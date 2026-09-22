/**
 * Tail Wag — 07_Commands.gs
 * Slash command handlers.
 *
 * Latency budget
 * --------------
 * Slack gives a slash command three seconds. Apps Script runs synchronously, so
 * the design keeps the hot path to: cached config read, two targeted range reads
 * and writes, one append, and a single parallel batch of Slack calls. The public
 * announcement is returned as the HTTP response itself (`response_type:
 * in_channel`) rather than as a separate chat.postMessage, which saves an entire
 * round trip on every tailwag.
 */

/**
 * /wag @someone reason
 * @param {Object} cmd parsed slash-command fields
 * @return {ContentService.TextOutput}
 */
function handleWagCommand_(cmd) {
  var text = String(cmd.text || '').trim();
  if (!text || /^(help|\?)$/i.test(text)) {
    var help = buildHelpCard_(cmd.user_id);
    return ephemeral_(help.text, help.blocks);
  }

  var parsed = parseGive_(text);
  var check = validateGive_(parsed, cmd.user_id);
  if (!check.ok) return ephemeral_(check.message);

  var req = {
    giverId: cmd.user_id,
    giverName: cmd.user_name || displayName_(cmd.user_id),
    userIds: parsed.userIds,
    wagsEach: parsed.dots,
    reason: parsed.reason,
    value: parsed.value,
    valueTag: parsed.value ? parsed.value.tag : '',
    channelId: cmd.channel_id,
    channelName: cmd.channel_name,
    source: 'slash',
    messageTs: ''
  };

  var result;
  try {
    result = giveWags_(req);
  } catch (e) {
    if (String(e.message || e).indexOf('BUSY') !== -1) {
      return ephemeral_('Someone else is giving a tailwag this exact second. Try again — it will go through.');
    }
    logError_('tailwag.failed', cmd.user_id, String(e && e.stack || e));
    return ephemeral_('Something went wrong writing that tailwag. Nothing was counted — try again, and tell an admin if it keeps happening.');
  }

  if (!result.awarded.length) {
    var why = result.skipped.map(function (s) {
      return mention_(s.userId) + ' — ' + s.reason;
    }).join('\n');
    return ephemeral_('No tailwags went out.\n' + (why || 'Nothing to do.') +
      '\n\nYou have ' + result.remaining + ' of ' + result.allowance + ' left this ' + periodWord_() + '.');
  }

  logInfo_('tailwag.given', cmd.user_id, {
    to: result.awarded.map(function (a) { return a.userId; }),
    dots: result.spent,
    value: req.valueTag,
    channel: cmd.channel_name
  });

  var announcement = buildAwardMessage_(result, req);
  var toSourceChannel = cfgBool_('ANNOUNCE_IN_SOURCE_CHANNEL');

  // When announcements are centralized the public post is just another Slack
  // call, so it rides in the same parallel batch as the DMs and the receipt.
  // Sending it on its own afterwards cost a second serial round trip, and on a
  // path with a three-second budget that was the difference between landing and
  // timing out.
  var extra = [];
  if (!toSourceChannel) {
    var announceChannel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
    if (announceChannel) {
      extra.push({
        method: 'chat.postMessage',
        payload: {
          channel: announceChannel,
          text: announcement.text,
          blocks: announcement.blocks,
          unfurl_links: false,
          unfurl_media: false
        }
      });
    }
  }

  // Side messages — DMs, mirror copies, the private receipt — all in one batch.
  dispatchSideMessages_(result, req, extra);

  if (toSourceChannel) {
    return inChannel_(announcement.text, announcement.blocks);
  }
  var receipt = buildGiverReceipt_(result, req);
  return ephemeral_(receipt.text, receipt.blocks);
}

/**
 * Sends everything that is not the main announcement, in a single parallel batch:
 * recipient DMs, the optional mirror copy, the giver's private receipt when
 * there is something worth telling them, and any extra calls the caller hands in
 * (the public announcement, when it is going to a central channel).
 */
function dispatchSideMessages_(result, req, extraCalls) {
  var calls = (extraCalls || []).slice();

  if (cfgBool_('DM_RECIPIENT')) {
    result.awarded.forEach(function (a) {
      var dm = buildRecipientDm_(a, req, req.channelId, '');
      calls.push({
        method: 'chat.postMessage',
        payload: { channel: a.userId, text: dm.text, blocks: dm.blocks, unfurl_links: false }
      });
    });
  }

  if (cfgBool_('MIRROR_TO_ANNOUNCE_CHANNEL') && cfgBool_('ANNOUNCE_IN_SOURCE_CHANNEL')) {
    var mirror = buildAwardMessage_(result, req);
    var ch = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
    if (ch) {
      calls.push({
        method: 'chat.postMessage',
        payload: { channel: ch, text: mirror.text, blocks: mirror.blocks, unfurl_links: false }
      });
    }
  }

  // Private receipt, but only when it says something the public post does not.
  var worthSaying = result.skipped.length > 0 ||
    result.remaining <= 1 ||
    result.awarded.some(function (a) { return a.dots < a.requested; });
  if (worthSaying && cfgBool_('ANNOUNCE_IN_SOURCE_CHANNEL') && req.channelId) {
    var receipt = buildGiverReceipt_(result, req);
    calls.push({
      method: 'chat.postEphemeral',
      payload: { channel: req.channelId, user: req.giverId, text: receipt.text, blocks: receipt.blocks }
    });
  }

  if (cfgBool_('DM_GIVER_RECEIPT')) {
    var r2 = buildGiverReceipt_(result, req);
    calls.push({
      method: 'chat.postMessage',
      payload: { channel: req.giverId, text: r2.text, blocks: r2.blocks }
    });
  }

  if (calls.length) slackApiAll_(calls);
}

/**
 * /wags — balance, leaderboards, someone else's standing.
 * @return {ContentService.TextOutput}
 */
function handleWagsCommand_(cmd) {
  var text = String(cmd.text || '').trim();
  var lower = text.toLowerCase();

  if (/^(help|\?)$/.test(lower)) {
    var help = buildHelpCard_(cmd.user_id);
    return ephemeral_(help.text, help.blocks);
  }

  // Someone else's tailwags: /wags @sam
  var parsed = parseGive_(text);
  if (parsed.userIds.length === 1 && !/(leader|board|top|month|week|day|all|given|give)/.test(lower)) {
    var targetId = parsed.userIds[0];
    var tbal = getBalance_(targetId, displayName_(targetId));
    var card = buildOtherBalanceCard_(tbal, targetId);
    return ephemeral_(card.text, card.blocks);
  }

  if (/^(given|givers|generous|giving)$/.test(lower)) {
    var givers = giverLeaderboard_();
    var gblocks = [headerBlock_('🐕 Most generous — all time')];
    gblocks.push(givers.length
      ? sectionBlock_(givers.map(function (r, i) {
        return rankEmoji_(i) + ' *' + ordinal_(r.rank) + '*  ' + mention_(r.user_id) + '  —  ' +
          r.dots + ' given';
      }).join('\n'))
      : sectionBlock_('_Nobody has given a tailwag yet._'));
    return ephemeral_('Most generous', gblocks);
  }

  if (/^(board|leaderboard|top|week|day|period)$/.test(lower) || lower === '') {
    if (lower === '') {
      var bal = getBalance_(cmd.user_id, cmd.user_name || displayName_(cmd.user_id));
      var mine = buildBalanceCard_(bal, cmd.user_id);
      var blocks = mine.blocks.concat([
        dividerBlock_(),
        actionsBlock_([
          buttonElement_('This ' + periodWord_(), 'lb_period', 'period', 'primary'),
          buttonElement_('This month', 'lb_month', 'month'),
          buttonElement_('All time', 'lb_all', 'all'),
          buttonElement_('How it works', 'show_help', 'help')
        ])
      ]);
      return ephemeral_(mine.text, blocks);
    }
    var rows = leaderboard_('period');
    var lb = buildLeaderboardCard_('period', rows, cmd.user_id);
    return ephemeral_(lb.text, lb.blocks);
  }

  if (/^month/.test(lower)) {
    var mrows = leaderboard_('month');
    var mlb = buildLeaderboardCard_('month', mrows, cmd.user_id);
    return ephemeral_(mlb.text, mlb.blocks);
  }

  if (/^(all|alltime|all-time|ever|lifetime)/.test(lower)) {
    var arows = leaderboard_('all');
    var albb = buildLeaderboardCard_('all', arows, cmd.user_id);
    return ephemeral_(albb.text, albb.blocks);
  }

  if (/^(feed|recent|latest|why)$/.test(lower)) {
    return ephemeral_('Recent tailwags', buildFeedBlocks_(10));
  }

  if (/^(rewards?|tickets?|prizes?|pods?|redeem|shop|store)$/.test(lower)) {
    return handleRewardsCommand_(cmd);
  }

  if (/^(raffle|entries|drawing)$/.test(lower)) {
    if (!cfgBool_('RAFFLE_ENABLED') && cfgBool_('REWARDS_ENABLED')) return handleRewardsCommand_(cmd);
    return ephemeral_('Raffle', buildRaffleStatusBlocks_(cmd.user_id));
  }

  var h = buildHelpCard_(cmd.user_id);
  return ephemeral_(h.text, h.blocks);
}

/** Another person's public-facing tailwag card. */
function buildOtherBalanceCard_(bal, userId) {
  var badges = badgesFor_(bal);
  var lines = [];
  lines.push('*' + mention_(userId) + '*');
  lines.push('Received *' + num_(bal.received_total) + '* all-time  ·  *' +
    num_(bal.received_this_period) + '* this ' + periodWord_() + '  ·  *' +
    num_(bal.received_month) + '* this month');
  lines.push('Given *' + num_(bal.given_total) + '* all-time');
  var blocks = [sectionBlock_(lines.join('\n'))];
  if (badges.length) {
    blocks.push(contextBlock_(badges.map(function (b) {
      return b.emoji + ' ' + escapeSlack_(b.label);
    }).join('   ')));
  }
  var recent = recentReasons_(3, { receiver_id: userId });
  if (recent.length) {
    blocks.push(sectionBlock_('*Lately*\n' + recent.map(function (r) {
      return '> ' + escapeSlack_(truncate_(humanizeMentions_(r.reason, true), 160)) + '  _— ' + escapeSlack_(r.giver_name) + '_';
    }).join('\n')));
  }
  return { text: displayName_(userId) + ': ' + num_(bal.received_total) + ' ' + wagWord_(num_(bal.received_total)) + ' all-time', blocks: blocks };
}

/** The recent-reasons feed. */
function buildFeedBlocks_(limit) {
  var rows = recentReasons_(limit || 10);
  if (!rows.length) return [sectionBlock_('_No tailwags yet._')];
  var values = {};
  valueList_().forEach(function (v) { values[v.tag] = v; });
  return [headerBlock_('🐕 Recent tailwags')].concat(rows.map(function (r) {
    var v = values[r.value_tag];
    return contextBlock_(
      (v ? v.emoji + ' ' : '') + mention_(r.giver_id) + ' → ' + mention_(r.receiver_id) +
      ' (' + r.dots + ')  ·  ' + escapeSlack_(truncate_(humanizeMentions_(r.reason, true), 180))
    );
  }));
}

/** Raffle standing for the current month. */
function buildRaffleStatusBlocks_(userId) {
  if (!cfgBool_('RAFFLE_ENABLED')) return [sectionBlock_('_The raffle is switched off right now._')];
  var period = monthKey_();
  var rows = raffleEntriesFor_(period);
  var total = 0;
  rows.forEach(function (r) { total += num_(r.entries); });
  var mine = myRaffleEntries_(userId, period);
  var odds = total > 0 ? (mine / total) : 0;

  var blocks = [
    headerBlock_('🎟️ ' + fmt_(now_(), 'MMMM') + ' raffle'),
    sectionBlock_('You have *' + mine + '* ' + (mine === 1 ? 'entry' : 'entries') +
      ' out of *' + total + '* in the drum — about *' + Math.round(odds * 100) + '%* of the tickets.' +
      (cfgStr_('RAFFLE_PRIZE') ? '\nPrize: *' + escapeSlack_(cfgStr_('RAFFLE_PRIZE')) + '*' : ''))
  ];
  blocks.push(contextBlock_('Every tailwag you receive is one entry. Drawn on the 1st, then the drum resets.' +
    (cfgNum_('RAFFLE_MAX_ENTRIES_PER_PERSON') > 0
      ? ' Capped at ' + cfgNum_('RAFFLE_MAX_ENTRIES_PER_PERSON') + ' entries each.' : '')));
  return blocks;
}

// ---------------------------------------------------------------------------
// /wag-admin
// ---------------------------------------------------------------------------

/**
 * /wag-admin <subcommand>
 * Deliberately terse and explicit — this is the lever that changes other
 * people's balances, so every action is logged and echoed back.
 */
function handleAdminCommand_(cmd) {
  if (!isAdmin_(cmd.user_id)) {
    return ephemeral_('That command is admin-only. Ask whoever runs Tail Wag to add you to `ADMIN_USER_IDS` in the Config tab.');
  }

  var parts = String(cmd.text || '').trim().split(/\s+/);
  var sub = (parts.shift() || '').toLowerCase();
  var rest = parts.join(' ');

  switch (sub) {
    case 'status': return ephemeral_('Tail Wag status', buildAdminStatusBlocks_());

    case 'grant': {
      // /wag-admin grant @user 3 reason
      var p = parseGive_(rest);
      if (!p.userIds.length) return ephemeral_('Usage: `/wag-admin grant @user 3 reason`');
      var nMatch = rest.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
      var n = nMatch ? parseInt(nMatch[1], 10) : 1;
      var reason = p.reason.replace(/(?:^|\s)\d{1,2}(?=\s|$)/, ' ').replace(/\s+/g, ' ').trim() ||
        'Granted by an admin';
      var granted = adminGrant_(p.userIds, n, reason, cmd.user_id);
      return ephemeral_('Granted ' + n + ' ' + wagWord_(n) + ' to ' +
        granted.map(function (g) { return mention_(g.userId); }).join(', ') + '.');
    }

    case 'topup': {
      // /wag-admin topup @user 5  — refill someone's allowance, not their received total
      var p2 = parseGive_(rest);
      var tMatch = rest.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
      var amount = tMatch ? parseInt(tMatch[1], 10) : allowanceFor_(cmd.user_id);
      if (!p2.userIds.length) return ephemeral_('Usage: `/wag-admin topup @user 5`');
      p2.userIds.forEach(function (uid) {
        var b = getBalance_(uid, displayName_(uid), false);
        rollForward_(b);
        b.allowance = num_(b.allowance) + amount;
        b.remaining = num_(b.remaining) + amount;
        writeBalance_(b);
      });
      logInfo_('admin.topup', cmd.user_id, { users: p2.userIds, amount: amount });
      return ephemeral_('Topped up ' + p2.userIds.map(mention_).join(', ') + ' by ' + amount + '.');
    }

    case 'set': {
      // /wag-admin set KEY value
      var sp = rest.split(/\s+/);
      var key = (sp.shift() || '').toUpperCase();
      var val = sp.join(' ');
      if (!key) return ephemeral_('Usage: `/wag-admin set ALLOWANCE_PEER 5`');
      if (!CONFIG_DEFAULTS.hasOwnProperty(key)) {
        return ephemeral_('`' + escapeSlack_(key) + '` is not a known setting. `/wag-admin keys` lists them.');
      }
      if (/TOKEN|SECRET/.test(key)) {
        return ephemeral_('Secrets are not settable from Slack — put `' + escapeSlack_(key) + '` straight into the Config tab.');
      }
      setConfig_(key, val);
      logInfo_('admin.set', cmd.user_id, { key: key, value: val });
      return ephemeral_('`' + escapeSlack_(key) + '` is now `' + escapeSlack_(val) + '`.');
    }

    case 'keys': {
      var keys = Object.keys(CONFIG_DEFAULTS).filter(function (k) { return !/TOKEN|SECRET/.test(k); });
      return ephemeral_('Settings', [sectionBlock_('*Settable from Slack*\n```' + keys.join('\n') + '```')]);
    }

    case 'reset': {
      if (rest.trim().toLowerCase() !== 'confirm') {
        return ephemeral_(':warning: This refills *everyone\'s* allowance right now, mid-period. ' +
          'Run `/wag-admin reset confirm` if that is what you mean.');
      }
      var n2 = resetAllAllowances_();
      logWarn_('admin.reset', cmd.user_id, { people: n2 });
      return ephemeral_('Refilled ' + n2 + ' ' + (n2 === 1 ? 'person' : 'people') + '.');
    }

    case 'draw': {
      var period = rest.trim() || prevMonthKey_();
      var res = runRaffleDraw_(period, true);
      return ephemeral_(res.message);
    }

    case 'digest': {
      var d = postDigest_(true);
      return ephemeral_(d.ok ? 'Digest posted to ' + cfgStr_('ANNOUNCE_CHANNEL') + '.' : 'Digest failed: ' + d.error);
    }

    case 'pause':
      setConfig_('PAUSED', true);
      logWarn_('admin.pause', cmd.user_id, '');
      return ephemeral_('Paused. Giving is refused; balances and boards still work.');

    case 'resume':
      setConfig_('PAUSED', false);
      logInfo_('admin.resume', cmd.user_id, '');
      return ephemeral_('Back on.');

    case 'sync':
      var synced = syncRosterFromSlack_();
      return ephemeral_('Roster synced — ' + synced.added + ' added, ' + synced.updated + ' updated, ' +
        synced.skipped + ' skipped (bots and deactivated accounts).');

    case 'rebuild':
      if (rest.trim().toLowerCase() !== 'confirm') {
        return ephemeral_(':warning: This recomputes every balance from the ledger. ' +
          'Run `/wag-admin rebuild confirm` to go ahead.');
      }
      var rb = rebuildBalancesFromLedger_();
      logWarn_('admin.rebuild', cmd.user_id, rb);
      return ephemeral_('Rebuilt ' + rb.people + ' balances from ' + rb.rows + ' ledger rows.');

    case 'whoami':
      return ephemeral_('You are ' + mention_(cmd.user_id) + ' (`' + cmd.user_id + '`), pool *' +
        poolOf_(cmd.user_id) + '*, admin *yes*. Workspace `' + (cmd.team_id || '?') + '`.');

    default:
      return ephemeral_('Admin commands', [sectionBlock_(
        '`/wag-admin status` — health, totals, config at a glance\n' +
        '`/wag-admin grant @user 3 reason` — award tailwags outside anyone\'s allowance\n' +
        '`/wag-admin topup @user 5` — add to someone\'s remaining allowance\n' +
        '`/wag-admin set KEY value` — change a setting\n' +
        '`/wag-admin keys` — list settable keys\n' +
        '`/wag-admin reset confirm` — refill everyone now\n' +
        '`/wag-admin draw [2026-08]` — run a legacy raffle drawing (reward pods are run from the rewards site)\n' +
        '`/wag-admin digest` — post the digest now\n' +
        '`/wag-admin pause` / `resume`\n' +
        '`/wag-admin sync` — pull the roster from Slack\n' +
        '`/wag-admin rebuild confirm` — recompute balances from the ledger\n' +
        '`/wag-admin whoami`'
      )]);
  }
}

/** Awards tailwags from nowhere — an admin grant, outside the allowance system. */
function adminGrant_(userIds, dots, reason, adminId) {
  return withLock_(function () {
    var out = [];
    userIds.forEach(function (uid) {
      var name = displayName_(uid);
      var b = getBalance_(uid, name, false);
      rollForward_(b);
      b.received_this_period = num_(b.received_this_period) + dots;
      b.received_month = num_(b.received_month) + dots;
      b.received_total = num_(b.received_total) + dots;
      var fresh = awardBadges_(b);
      addRaffleEntries_(uid, name, dots, monthKey_());
      writeBalance_(b);
      appendLedger_({
        giver_id: adminId, giver_name: displayName_(adminId),
        receiver_id: uid, receiver_name: name,
        dots: dots, reason: reason, source: 'admin', pool: 'admin'
      });
      out.push({ userId: uid, badges: fresh });
    });
    logWarn_('admin.grant', adminId, { users: userIds, dots: dots, reason: reason });
    cacheDropAll_();
    return out;
  });
}

/** Refills everyone's allowance immediately. */
function resetAllAllowances_() {
  return withLock_(function () {
    var rows = readSheet_(SHEETS.BALANCES);
    var s = sheet_(SHEETS.BALANCES);
    var cols = headerOf_(SHEETS.BALANCES).order;
    var pk = periodKey_();
    rows.forEach(function (b) {
      var allowance = allowanceFor_(String(b.user_id));
      b.period_key = pk;
      b.allowance = allowance;
      b.spent_this_period = 0;
      b.remaining = allowance;
      b.given_to_json = '{}';
      b.received_this_period = 0;
      b.updated_ts = iso_();
      s.getRange(b.__row, 1, 1, cols.length).setValues([cols.map(function (c) {
        var v = c ? b[c] : '';
        return sanitizeCell_(v === undefined || v === null ? '' : v);
      })]);
    });
    cacheDropAll_();
    return rows.length;
  }, 30000);
}

/** Admin status card. */
function buildAdminStatusBlocks_() {
  var stats = globalStats_();
  var word = periodWord_();
  return [
    headerBlock_('🐕 Tail Wag — status'),
    fieldsBlock_([
      ['People tracked', String(stats.people)],
      ['Tailwags all-time', String(stats.wagsAllTime)],
      ['This ' + word, String(stats.wagsThisPeriod)],
      ['This month', String(stats.wagsThisMonth)],
      ['Unspent right now', String(stats.unspentThisPeriod)],
      ['Gave this ' + word, stats.participationThisPeriod + ' of ' + stats.people]
    ]),
    contextBlock_([
      'Allowance: ' + cfgNum_('ALLOWANCE_PEER') + '/' + word + ' peer, ' +
        cfgNum_('ALLOWANCE_MANAGER') + '/' + word + ' manager',
      'Per-recipient cap: ' + (cfgNum_('MAX_PER_RECIPIENT_PER_PERIOD') || 'none'),
      'Raffle: ' + (cfgBool_('RAFFLE_ENABLED') ? 'on' : 'off'),
      'Values: ' + (cfgBool_('VALUES_ENABLED') ? (cfgBool_('VALUE_REQUIRED') ? 'required' : 'optional') : 'off'),
      cfgBool_('PAUSED') ? ':warning: *PAUSED*' : 'Running'
    ].join('  ·  ')),
    contextBlock_('Period key `' + stats.periodKey + '`  ·  month `' + stats.monthKey + '`')
  ];
}
