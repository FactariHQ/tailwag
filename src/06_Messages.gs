/**
 * Tail Wag — 06_Messages.gs
 * Everything the app says: announcements, confirmations, DMs, digests, help.
 *
 * Kept apart from the logic so the wording can be edited without going anywhere
 * near the transaction, and so the tests can assert on message content.
 */

/** Playful openers for a public award. Picked by hash so a single tailwag reads the same everywhere. */
var AWARD_OPENERS = [
  'Tailwag incoming',
  'That earned a tailwag',
  'Someone noticed',
  'Caught doing something right',
  'Tailwag dispensed',
  'Recognition, delivered'
];

function pickOpener_(seed) {
  var s = String(seed || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return AWARD_OPENERS[h % AWARD_OPENERS.length];
}

/**
 * The public message announcing one or more awards.
 * @param {Object} result the giveWags_ result
 * @param {{giverId:string, reason:string, value:Object}} req
 * @return {{text:string, blocks:Array}}
 */
function buildAwardMessage_(result, req) {
  var lines = [];
  var totalWags = 0;
  result.awarded.forEach(function (a) { totalWags += a.dots; });

  var recipients = result.awarded.map(function (a) { return mention_(a.userId); });
  var who = joinNames_(recipients);
  var perEach = result.awarded.length > 1 && allSame_(result.awarded)
    ? result.awarded[0].dots : null;

  var headline = mention_(req.giverId) + ' gave ' + who + ' ' +
    (perEach ? '*' + perEach + ' ' + wagWord_(perEach) + ' each* ' + wagRun_(perEach)
      : '*' + totalWags + ' ' + wagWord_(totalWags) + '* ' + wagRun_(totalWags));

  lines.push(headline);
  lines.push('> ' + escapeSlack_(truncate_(req.reason, 900)));

  var blocks = [sectionBlock_(lines.join('\n'))];

  var context = [];
  if (req.value) context.push(req.value.emoji + ' *' + escapeSlack_(req.value.label) + '*');
  result.awarded.forEach(function (a) {
    context.push(escapeSlack_(a.name) + ': ' + a.receivedTotal + ' all-time');
  });
  if (result.streakExtended && num_(result.streak) >= 3) {
    context.push(':fire: ' + result.streak + '-' + periodWord_() + ' giving streak');
  }
  blocks.push(contextBlock_(context.join('  ·  ')));

  // Badge unlocks get their own celebratory block.
  var badgeLines = [];
  result.awarded.forEach(function (a) {
    (a.badges || []).forEach(function (b) {
      badgeLines.push(b.emoji + ' ' + mention_(a.userId) + ' unlocked *' + escapeSlack_(b.label) +
        '* — ' + b.threshold + ' ' + wagWord_(b.threshold) + ' received.');
    });
  });
  (result.giverBadges || []).forEach(function (b) {
    badgeLines.push(b.emoji + ' ' + mention_(req.giverId) + ' unlocked *' + escapeSlack_(b.label) +
      '* — ' + b.threshold + ' ' + wagWord_(b.threshold) + ' given.');
  });
  if (badgeLines.length) {
    blocks.push(dividerBlock_());
    blocks.push(sectionBlock_(badgeLines.join('\n')));
  }

  var fallback = stripMrkdwn_(headline) + ' — ' + truncate_(req.reason, 200);
  return { text: fallback, blocks: blocks };
}

function allSame_(awarded) {
  for (var i = 1; i < awarded.length; i++) if (awarded[i].dots !== awarded[0].dots) return false;
  return true;
}

function joinNames_(arr) {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

function stripMrkdwn_(s) {
  return String(s).replace(/\*/g, '').replace(/:[a-z0-9_+\-]+:/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The private confirmation the giver sees.
 * @return {{text:string, blocks:Array}}
 */
function buildGiverReceipt_(result, req) {
  var lines = [];

  if (result.awarded.length) {
    var parts = result.awarded.map(function (a) {
      var s = a.dots + ' ' + wagWord_(a.dots) + ' → ' + mention_(a.userId);
      if (a.dots < a.requested) s += ' _(trimmed from ' + a.requested + ')_';
      return s;
    });
    lines.push('Sent: ' + parts.join(', '));
  }

  result.skipped.forEach(function (s) {
    lines.push(':warning: ' + mention_(s.userId) + ' — ' + s.reason);
  });

  var word = periodWord_();
  lines.push('You have *' + result.remaining + ' of ' + result.allowance + '* ' +
    wagWord_(result.allowance) + ' left this ' + word +
    (result.remaining === 0 ? '. Refills ' + periodResetText_() + '.' : '.'));

  if (result.pool === 'manager') {
    lines.push('_Drawn from the manager pool, so peer tailwags stay peer._');
  }

  return { text: stripMrkdwn_(lines.join(' ')), blocks: [sectionBlock_(lines.join('\n'))] };
}

/** The DM a recipient gets, so recognition lands even if they miss the channel. */
function buildRecipientDm_(award, req, channelId, permalink) {
  var lines = [];
  lines.push(wagRun_(award.dots) + '  *' + mention_(req.giverId) + ' gave you ' +
    award.dots + ' ' + wagWord_(award.dots) + '*');
  lines.push('> ' + escapeSlack_(truncate_(req.reason, 900)));
  var tail = [];
  if (req.value) tail.push(req.value.emoji + ' ' + escapeSlack_(req.value.label));
  tail.push(award.receivedTotal + ' ' + wagWord_(award.receivedTotal) + ' all-time');
  if (cfgBool_('REWARDS_ENABLED') && cfgStr_('REWARDS_LAUNCH_TS')) {
    var earned = tix_(award.dots * num_(cfgNum_('TICKETS_PER_WAG_RECEIVED')));
    if (earned > 0) {
      var rurl = cfgStr_('REWARDS_PORTAL_URL');
      tail.push('🎟️ +' + ticketWord_(earned) + (rurl ? ' — <' + rurl + '|spend them>' : ''));
    }
  }
  if (cfgBool_('RAFFLE_ENABLED') && award.raffleEntriesTotal) {
    tail.push(award.raffleEntriesTotal + ' raffle ' + (award.raffleEntriesTotal === 1 ? 'entry' : 'entries') + ' this month');
  }
  lines.push(tail.join('  ·  '));
  if (permalink) lines.push('<' + permalink + '|See it in channel>');

  var blocks = [sectionBlock_(lines.join('\n'))];
  (award.badges || []).forEach(function (b) {
    blocks.push(sectionBlock_(b.emoji + ' *New badge: ' + escapeSlack_(b.label) + '* — ' +
      b.threshold + ' ' + wagWord_(b.threshold) + ' received.'));
  });
  return { text: stripMrkdwn_(lines[0]) + ' — ' + truncate_(req.reason, 150), blocks: blocks };
}

/** A person's balance card. */
function buildBalanceCard_(bal, userId) {
  var word = periodWord_();
  var badges = badgesFor_(bal);
  var next = nextBadge_(bal);

  var fields = [
    ['Left to give this ' + word, num_(bal.remaining) + ' of ' + num_(bal.allowance)],
    ['Given all-time', String(num_(bal.given_total))],
    ['Received this ' + word, String(num_(bal.received_this_period))],
    ['Received all-time', String(num_(bal.received_total))]
  ];

  var blocks = [
    sectionBlock_('*Your tailwags*  ' + wagRun_(num_(bal.remaining))),
    fieldsBlock_(fields)
  ];

  var context = [];
  if (num_(bal.remaining) === 0) {
    context.push('Out of tailwags — refills ' + periodResetText_() + '.');
  }
  if (cfgBool_('STREAKS_ENABLED') && num_(bal.streak) > 1) {
    context.push(':fire: ' + num_(bal.streak) + '-' + word + ' giving streak');
  }
  if (cfgBool_('RAFFLE_ENABLED')) {
    var entries = myRaffleEntries_(userId, monthKey_());
    context.push('Raffle: ' + entries + ' ' + (entries === 1 ? 'entry' : 'entries') + ' in the ' +
      fmt_(now_(), 'MMMM') + ' drawing');
  }
  if (cfgBool_('REWARDS_ENABLED')) {
    context.push('🎟️ `/wags rewards` for your tickets and what is up for grabs');
  }
  if (bal.pool === 'manager') context.push('Manager pool');
  if (context.length) blocks.push(contextBlock_(context.join('  ·  ')));

  if (badges.length) {
    blocks.push(sectionBlock_('*Badges*\n' + badges.map(function (b) {
      return b.emoji + ' ' + escapeSlack_(b.label);
    }).join('   ')));
  }
  if (next) {
    blocks.push(contextBlock_('Next up: ' + next.badge.emoji + ' *' + escapeSlack_(next.badge.label) +
      '* — ' + next.need + ' more ' + wagWord_(next.need) + ' to go.'));
  }

  return { text: 'You have ' + num_(bal.remaining) + ' of ' + num_(bal.allowance) + ' ' + wagWord_(num_(bal.allowance)) + ' left this ' + word + '.', blocks: blocks };
}

/** A leaderboard card. */
function buildLeaderboardCard_(period, rows, viewerId) {
  var title = period === 'month' ? 'This month' : period === 'all' ? 'All time' : 'This ' + periodWord_();
  var blocks = [headerBlock_('🐕 Tail Wag — ' + title)];

  if (!rows.length) {
    blocks.push(sectionBlock_('_Nobody has picked up a tailwag yet ' +
      (period === 'all' ? '' : 'this ' + (period === 'month' ? 'month' : periodWord_())) +
      '. Someone has to go first._'));
    return { text: 'Tail Wag leaderboard — nothing yet.', blocks: blocks };
  }

  var lines = rows.map(function (r, i) {
    var you = r.user_id === viewerId ? '  ← you' : '';
    return rankEmoji_(i) + ' *' + ordinal_(r.rank) + '*  ' + mention_(r.user_id) +
      '  —  ' + r.dots + ' ' + wagWord_(r.dots) + you;
  });
  blocks.push(sectionBlock_(lines.join('\n')));

  // If the viewer is not on the board, tell them where they stand anyway.
  if (viewerId && !rows.some(function (r) { return r.user_id === viewerId; })) {
    var full = leaderboard_(period, 500);
    var mine = null;
    for (var i = 0; i < full.length; i++) if (full[i].user_id === viewerId) { mine = full[i]; break; }
    blocks.push(contextBlock_(mine
      ? 'You: ' + ordinal_(mine.rank) + ' with ' + mine.dots + ' ' + wagWord_(mine.dots)
      : 'You have not received a tailwag ' + (period === 'all' ? 'yet' : 'in this period') + ' — plenty of time.'));
  }

  return { text: 'Tail Wag leaderboard — ' + title, blocks: blocks };
}

/** The Monday digest. */
function buildDigest_(periodLabel, rows, givers, stats, values) {
  var blocks = [
    headerBlock_('🐕 Tail Wag — ' + periodLabel),
    sectionBlock_('*' + stats.dots + ' ' + wagWord_(stats.dots) + '* handed out by *' +
      stats.givers + '* ' + (stats.givers === 1 ? 'person' : 'people') + ' to *' +
      stats.receivers + '* ' + (stats.receivers === 1 ? 'person' : 'people') + '.')
  ];

  if (rows.length) {
    blocks.push(sectionBlock_('*Most tailwags received*\n' + rows.slice(0, 5).map(function (r, i) {
      return rankEmoji_(i) + ' ' + mention_(r.user_id) + ' — ' + r.dots;
    }).join('\n')));
  }
  if (givers && givers.length) {
    blocks.push(sectionBlock_('*Most generous*\n' + givers.slice(0, 3).map(function (r, i) {
      return rankEmoji_(i) + ' ' + mention_(r.user_id) + ' — ' + r.dots + ' given';
    }).join('\n')));
  }
  if (values && values.length && values[0].dots > 0) {
    blocks.push(sectionBlock_('*What we recognized*\n' + values.filter(function (v) { return v.dots > 0; })
      .map(function (v) {
        return v.emoji + ' ' + escapeSlack_(v.label) + ' — ' + v.dots + ' (' + Math.round(v.share * 100) + '%)';
      }).join('\n')));
  }

  blocks.push(dividerBlock_());
  blocks.push(contextBlock_('Everyone\'s tailwags have refilled. `/wag @someone why` to spend them — ' +
    'they expire at the end of the ' + periodWord_() + '.'));

  return { text: 'Tail Wag — ' + periodLabel + ': ' + stats.dots + ' ' + wagWord_(stats.dots) + ' given.', blocks: blocks };
}

/** The monthly raffle announcement. */
function buildRaffleAnnouncement_(period, winners, totalEntries, entrantCount) {
  var prize = cfgStr_('RAFFLE_PRIZE');
  var blocks = [
    headerBlock_('🎟️ Tail Wag raffle — ' + period),
    sectionBlock_(winners.map(function (w) {
      return ':tada: *' + mention_(w.user_id) + '* — ' + w.entries + ' ' +
        (w.entries === 1 ? 'entry' : 'entries');
    }).join('\n') + (prize ? '\n\nPrize: *' + escapeSlack_(prize) + '*' : ''))
  ];
  blocks.push(contextBlock_('Drawn from ' + totalEntries + ' entries across ' + entrantCount +
    ' people. Every tailwag you receive is one entry — the drum resets today.'));
  return {
    text: 'Tail Wag raffle ' + period + ': ' + winners.map(function (w) { return w.name; }).join(', '),
    blocks: blocks
  };
}

/** The help card. */
function buildHelpCard_(userId) {
  var word = periodWord_();
  var allowance = allowanceFor_(userId);
  var cap = cfgNum_('MAX_PER_RECIPIENT_PER_PERIOD');
  var trigger = ':' + cfgStr_('EMOJI_TRIGGER') + ':';

  var lines = [];
  lines.push('*Giving a tailwag*');
  lines.push('`/wag @someone what they did` — the reason is the point; the tailwag is the receipt.');
  lines.push('`/wag @sam @dana x2 covered the whole weekend` — several people, more than one each.');
  if (cfgBool_('ALLOW_EMOJI_GIVING')) {
    lines.push('Or just type it in any channel: `@sam ' + trigger + ' saved me two hours today`.');
  }

  if (cfgBool_('VALUES_ENABLED')) {
    lines.push('');
    lines.push('*Tag the value* (optional' + (cfgBool_('VALUE_REQUIRED') ? ' — currently required' : '') + ')');
    lines.push(valueList_().map(function (v) {
      return v.emoji + ' `#' + v.tag + '` ' + escapeSlack_(v.label);
    }).join('\n'));
  }

  lines.push('');
  lines.push('*The rules*');
  lines.push('• *' + allowance + ' ' + wagWord_(allowance) + ' per ' + word + '*, refilling ' + periodResetText_() + '. Unused tailwags ' +
    (cfgBool_('CARRY_OVER_UNUSED') ? 'roll forward.' : 'expire — spend them.'));
  if (cap > 0) lines.push('• At most *' + cap + '* to the same person per ' + word + '.');
  if (!cfgBool_('ALLOW_SELF_KUDOS')) lines.push('• No tailwags for yourself.');
  lines.push('• Reasons are public and permanent. Write something they would want to read back.');

  lines.push('');
  lines.push('*Looking things up*');
  lines.push('`/wags` — your balance and badges');
  if (cfgBool_('REWARDS_ENABLED')) lines.push('`/wags rewards` — your tickets and the rewards you can enter');
  lines.push('`/wags leaderboard` · `/wags month` · `/wags all` — the boards');
  lines.push('`/wags given` — who has been most generous');
  lines.push('`/wags @someone` — someone else\'s tailwags');

  if (cfgBool_('REWARDS_ENABLED')) {
    var perR = num_(cfgNum_('TICKETS_PER_WAG_RECEIVED'));
    var perG = num_(cfgNum_('TICKETS_PER_WAG_GIVEN'));
    lines.push('');
    lines.push('*Rewards*');
    lines.push('Every tailwag you receive earns *' + perR + ' ' + (perR === 1 ? 'ticket' : 'tickets') + '*' +
      (perG > 0 ? ', and every one you give earns *' + perG + '*' : '') + '.');
    lines.push('Put your tickets into whichever rewards you want on the rewards site — more tickets, better odds. ' +
      'Tickets in a draw are spent win or lose; you can pull them back out until it closes.');
    lines.push('`/wags rewards` — your tickets and what is open' +
      (cfgStr_('REWARDS_PORTAL_URL') ? '  ·  <' + cfgStr_('REWARDS_PORTAL_URL') + '|open the rewards site>' : ''));
    lines.push('Badges unlock automatically at ' + cfgList_('BADGE_THRESHOLDS').join(', ') + ' tailwags received.');
  }

  if (cfgBool_('RAFFLE_ENABLED')) {
    lines.push('');
    lines.push('*Monthly raffle*');
    lines.push('Badges unlock automatically at ' + cfgList_('BADGE_THRESHOLDS').join(', ') + ' tailwags received.');
    lines.push('Every tailwag you receive is one entry in the monthly raffle' +
      (cfgStr_('RAFFLE_PRIZE') ? ' for *' + escapeSlack_(cfgStr_('RAFFLE_PRIZE')) + '*' : '') + '.');
  }

  return { text: 'Tail Wag help', blocks: [headerBlock_('🐕 Tail Wag'), sectionBlock_(lines.join('\n'))] };
}
