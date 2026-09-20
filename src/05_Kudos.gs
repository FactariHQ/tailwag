/**
 * Tail Wag — 05_Kudos.gs
 * Parsing the give syntax and the transactional core of awarding tailwags.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

var RE_USER_MENTION = /<@([UW][A-Z0-9]{2,})(?:\|[^>]*)?>/g;
var RE_USERGROUP = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;
var RE_BROADCAST = /<!(channel|here|everyone)(?:\|[^>]*)?>/g;
var RE_COUNT_TOKEN = /(?:^|\s)(?:x|X|\*|\+)\s?([1-9])(?=\s|$)/;
var RE_BARE_HANDLE = /(?:^|\s)@([a-z0-9._\-]{2,})/gi;
var RE_CHANNEL_LINK = /<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g;
var RE_URL_LINK = /<(https?:\/\/[^>|]+)(?:\|([^>]*))?>/g;
var RE_VALUE_TAG = /(?:^|\s)#([a-z0-9][a-z0-9\-_]{1,30})(?=\s|$)/gi;

/**
 * Parses the text of a /wag command (or a message that triggered emoji giving).
 *
 * Supported shapes:
 *   /wag @sam great catch on the Denver auth
 *   /wag @sam @dana x2 covered the whole weekend between them
 *   /wag @sam :jackson::jackson: two for the price of one
 *
 * @param {string} text raw Slack text
 * @return {{userIds:Array<string>, tailwags:number, reason:string, groups:Array<string>,
 *           broadcasts:Array<string>, bareHandles:Array<string>, explicitCount:boolean}}
 */
function parseGive_(text) {
  var raw = String(text == null ? '' : text);

  var userIds = [];
  var seen = {};
  var m;
  RE_USER_MENTION.lastIndex = 0;
  while ((m = RE_USER_MENTION.exec(raw)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = true; userIds.push(m[1]); }
  }

  var groups = [];
  RE_USERGROUP.lastIndex = 0;
  while ((m = RE_USERGROUP.exec(raw)) !== null) groups.push(m[1]);

  var broadcasts = [];
  RE_BROADCAST.lastIndex = 0;
  while ((m = RE_BROADCAST.exec(raw)) !== null) broadcasts.push(m[1]);

  // Strip the structural bits before reading the reason.
  var rest = raw
    .replace(RE_USER_MENTION, ' ')
    .replace(RE_USERGROUP, ' ')
    .replace(RE_BROADCAST, ' ');

  // Bare @handles that Slack did not linkify (usually a typo, or escape_users off).
  var bareHandles = [];
  RE_BARE_HANDLE.lastIndex = 0;
  while ((m = RE_BARE_HANDLE.exec(rest)) !== null) bareHandles.push(m[1]);

  // Explicit multiplier: "x2", "*3", "+2".
  var dots = 1;
  var explicitCount = false;
  var cm = rest.match(RE_COUNT_TOKEN);
  if (cm) {
    dots = parseInt(cm[1], 10);
    explicitCount = true;
    rest = rest.replace(RE_COUNT_TOKEN, ' ');
  }

  // Otherwise, repeated trigger emoji set the count.
  var trigger = cfgStr_('EMOJI_TRIGGER') || 'jackson';
  var emojiRe = new RegExp(':' + trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':', 'g');
  var emojiMatches = rest.match(emojiRe);
  if (!explicitCount && emojiMatches && emojiMatches.length > 1) {
    dots = emojiMatches.length;
  }
  rest = rest.replace(emojiRe, ' ');

  // Readable reason: turn channel links and URLs back into something human.
  // Channel links are stripped first so #general never reads as a value tag.
  rest = rest.replace(RE_CHANNEL_LINK, ' ').replace(RE_URL_LINK, function (full, url, label) {
    return ' ' + (label || url) + ' ';
  });

  // Company value tag: #real-world, #collab, …
  var value = null;
  var unknownTags = [];
  if (cfgBool_('VALUES_ENABLED')) {
    var tagMatches = [];
    RE_VALUE_TAG.lastIndex = 0;
    while ((m = RE_VALUE_TAG.exec(rest)) !== null) tagMatches.push(m[1]);
    for (var t = 0; t < tagMatches.length; t++) {
      var resolved = resolveValue_(tagMatches[t]);
      if (resolved && !value) {
        value = resolved;
        rest = rest.replace(new RegExp('(^|\\s)#' + tagMatches[t].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'i'), ' ');
      } else if (!resolved) {
        unknownTags.push(tagMatches[t]);
      }
    }
  }

  var reason = rest.replace(/\s+/g, ' ').trim();
  // A reason that is only punctuation is no reason at all.
  if (/^[^\w]*$/.test(reason)) reason = '';

  return {
    userIds: userIds,
    dots: Math.max(1, dots),
    reason: reason,
    value: value,
    unknownTags: unknownTags,
    groups: groups,
    broadcasts: broadcasts,
    bareHandles: bareHandles,
    explicitCount: explicitCount
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks a parsed give against the rules, without touching the sheet.
 * Sheet-dependent checks (allowance, per-recipient cap) happen in giveWags_().
 * @return {{ok:boolean, message:string}}
 */
function validateGive_(parsed, giverId) {
  if (cfgBool_('PAUSED')) {
    return { ok: false, message: 'Tail Wag is paused right now. Nothing is being counted — try again once it is switched back on.' };
  }
  if (parsed.broadcasts.length) {
    return { ok: false, message: 'Tailwags go to people, not to `@channel` or `@here`. Tag the individuals you mean.' };
  }
  if (parsed.groups.length) {
    return { ok: false, message: 'User groups are not supported — tag people individually so each tailwag lands on a person.' };
  }
  if (!parsed.userIds.length) {
    if (parsed.bareHandles.length) {
      return { ok: false, message: 'I could not resolve *@' + escapeSlack_(parsed.bareHandles[0]) + '*. Pick the person from Slack\'s autocomplete so the mention turns blue, then send it again.' };
    }
    return { ok: false, message: 'Tag at least one person. Try `/wag @someone why they earned it`.' };
  }
  var maxRecipients = cfgNum_('MAX_RECIPIENTS_PER_MESSAGE');
  if (maxRecipients > 0 && parsed.userIds.length > maxRecipients) {
    return { ok: false, message: 'That is ' + parsed.userIds.length + ' people in one go — the limit is ' + maxRecipients + '. Split it up.' };
  }
  if (!cfgBool_('ALLOW_SELF_KUDOS') && parsed.userIds.length === 1 && parsed.userIds[0] === giverId) {
    return { ok: false, message: 'No tailwags for yourself. Nice try though.' };
  }
  if (cfgBool_('VALUES_ENABLED') && cfgBool_('VALUE_REQUIRED') && !parsed.value) {
    var tagHelp = valueList_().map(function (v) { return '`#' + v.tag + '`'; }).join('  ');
    return {
      ok: false,
      message: 'Tag the value it reflects, so the tailwag says something about how we work:\n' + tagHelp
    };
  }
  var minReason = cfgNum_('MIN_REASON_CHARS');
  if (parsed.reason.length < minReason) {
    return {
      ok: false,
      message: 'Add a reason — at least ' + minReason + ' characters. The reason is the part people remember; the tailwag is just the receipt.\n' +
        'Try `/wag ' + mention_(parsed.userIds[0]) + ' covered two sessions at short notice on Tuesday`'
    };
  }
  if (rosterBlocks_(giverId)) {
    return { ok: false, message: 'You are not on the Tail Wag roster yet. Ask an admin to add you.' };
  }
  return { ok: true, message: '' };
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

/**
 * Awards tailwags. Runs under the script lock so two commands cannot spend the same
 * allowance twice. Partial success is normal and expected: if someone tags three
 * people but only has two tailwags left, the first two land and the third is
 * reported back as skipped.
 *
 * @param {{giverId:string, giverName:string, userIds:Array<string>, wagsEach:number,
 *          reason:string, channelId:string, channelName:string, source:string,
 *          messageTs:string}} req
 * @return {{ok:boolean, error:string, awarded:Array, skipped:Array, remaining:number,
 *           allowance:number, pool:string, spent:number}}
 */
function giveWags_(req) {
  // Warm the profile cache before taking the lock: these are network calls, and
  // holding the script lock across them blocks every other giver in the
  // workspace for no reason.
  prefetchProfiles_(req.userIds.concat([req.giverId]));

  return withLock_(function () {
    var result = {
      ok: true,
      error: '',
      awarded: [],
      skipped: [],
      remaining: 0,
      allowance: 0,
      pool: poolOf_(req.giverId),
      spent: 0
    };

    var giverBal = getBalance_(req.giverId, req.giverName, false);
    rollForward_(giverBal);
    giverBal.name = req.giverName || giverBal.name;
    giverBal.pool = poolOf_(req.giverId);
    giverBal.allowance = giverBal.allowance || allowanceFor_(req.giverId);

    result.allowance = num_(giverBal.allowance);
    var perRecipientCap = cfgNum_('MAX_PER_RECIPIENT_PER_PERIOD');
    var allowSelf = cfgBool_('ALLOW_SELF_KUDOS');
    var allowBots = cfgBool_('ALLOW_BOT_RECIPIENTS');
    var weekK = weekKey_();
    var monthK = monthKey_();

    for (var i = 0; i < req.userIds.length; i++) {
      var rid = req.userIds[i];
      var want = req.wagsEach;

      if (!allowSelf && rid === req.giverId) {
        result.skipped.push({ userId: rid, reason: 'No tailwags for yourself.' });
        continue;
      }
      if (rosterBlocks_(rid)) {
        result.skipped.push({ userId: rid, reason: 'Not on the Tail Wag roster.' });
        continue;
      }

      var profile = fetchUserProfile_(rid);
      if (profile && profile.deleted) {
        result.skipped.push({ userId: rid, reason: 'That account is deactivated.' });
        continue;
      }
      if (!allowBots && profile && profile.is_bot) {
        result.skipped.push({ userId: rid, reason: 'Bots do not collect tailwags.' });
        continue;
      }

      // Per-recipient weekly cap.
      if (perRecipientCap > 0) {
        var already = givenToThisWeek_(giverBal, rid);
        var headroom = perRecipientCap - already;
        if (headroom <= 0) {
          result.skipped.push({
            userId: rid,
            reason: 'You have already given them your ' + perRecipientCap + ' ' + wagWord_(perRecipientCap) + ' for this week.'
          });
          continue;
        }
        if (want > headroom) want = headroom;
      }

      // Remaining allowance.
      var remaining = num_(giverBal.remaining);
      if (remaining <= 0) {
        result.skipped.push({ userId: rid, reason: 'You are out of tailwags until the weekly reset.' });
        continue;
      }
      if (want > remaining) want = remaining;

      // --- commit ---------------------------------------------------------
      var receiverName = displayName_(rid);
      var isSelf = rid === req.giverId;
      // When self-kudos is allowed, giver and receiver are the SAME sheet row.
      // Reading it a second time would produce a second object, and the final
      // write of giverBal would then silently discard everything credited to
      // receiverBal — the tailwags, the badge state, all of it.
      var receiverBal = isSelf ? giverBal : getBalance_(rid, receiverName, false);
      if (!isSelf) {
        rollForward_(receiverBal);
        receiverBal.name = receiverName;
      }

      giverBal.remaining = remaining - want;
      giverBal.spent_this_period = num_(giverBal.spent_this_period) + want;
      giverBal.given_total = num_(giverBal.given_total) + want;
      bumpGivenTo_(giverBal, rid, want);

      receiverBal.received_this_period = num_(receiverBal.received_this_period) + want;
      receiverBal.received_month = num_(receiverBal.received_month) + want;
      receiverBal.received_total = num_(receiverBal.received_total) + want;

      var freshBadges = awardBadges_(receiverBal);
      var entries = addRaffleEntries_(rid, receiverName, want, monthK);

      // The giver's row is written once, at the end, with every change on it.
      if (!isSelf) writeBalance_(receiverBal);

      appendLedger_({
        ts_iso: iso_(),
        week_key: weekK,
        month_key: monthK,
        giver_id: req.giverId,
        giver_name: req.giverName,
        receiver_id: rid,
        receiver_name: receiverName,
        dots: want,
        reason: req.reason,
        value_tag: req.valueTag || '',
        channel_id: req.channelId,
        channel_name: req.channelName,
        source: req.source || 'slash',
        pool: result.pool,
        message_ts: req.messageTs || ''
      });

      upsertRoster_(rid, profile || { display_name: receiverName });

      result.awarded.push({
        userId: rid,
        name: receiverName,
        dots: want,
        requested: req.wagsEach,
        receivedTotal: num_(receiverBal.received_total),
        receivedThisPeriod: num_(receiverBal.received_this_period),
        badges: freshBadges,
        raffleEntriesAdded: entries,
        raffleEntriesTotal: myRaffleEntries_(rid, monthK)
      });
      result.spent += want;
    }

    // Award the giver their own generosity badges, then persist once.
    var giverFresh = result.spent > 0 ? awardBadges_(giverBal) : [];
    if (result.spent > 0) {
      upsertRoster_(req.giverId, { display_name: req.giverName });
      // Giving streak: consecutive periods in which they gave at least one tailwag.
      if (cfgBool_('STREAKS_ENABLED')) {
        var curPeriod = periodKey_();
        var lastGave = String(giverBal.last_gave_period || '');
        if (lastGave !== curPeriod) {
          giverBal.streak = (lastGave === prevPeriodKey_()) ? num_(giverBal.streak) + 1 : 1;
          giverBal.last_gave_period = curPeriod;
          result.streak = num_(giverBal.streak);
          result.streakExtended = true;
        } else {
          result.streak = num_(giverBal.streak);
        }
      }
    }
    writeBalance_(giverBal);

    result.remaining = num_(giverBal.remaining);
    result.giverBadges = giverFresh;
    result.ok = result.awarded.length > 0;
    if (!result.ok && !result.skipped.length) result.error = 'nothing_to_do';

    ['period', 'week', 'day', 'month', 'all'].forEach(function (p) {
      cacheDrop_('leaderboard.' + p);
    });
    cacheDrop_('stats');

    return result;
  });
}

// ---------------------------------------------------------------------------
// Leaderboards and stats
// ---------------------------------------------------------------------------

/**
 * Leaderboard for a period, read from the denormalized Balances tab.
 * @param {string} period 'week' | 'month' | 'all'
 * @param {number=} size
 * @return {Array<{user_id:string,name:string,tailwags:number,rank:number}>}
 */
function leaderboard_(period, size) {
  var key = 'leaderboard.' + period;
  var cached = cacheGet_(key);
  var limit = size || cfgNum_('LEADERBOARD_SIZE');
  if (cached) return cached.slice(0, limit);

  var field = (period === 'week' || period === 'period' || period === 'day') ? 'received_this_period'
    : period === 'month' ? 'received_month'
      : 'received_total';

  var rows = allBalances_()
    .map(function (b) {
      return { user_id: String(b.user_id), name: String(b.name || b.user_id), dots: num_(b[field]) };
    })
    .filter(function (r) { return r.user_id && r.dots > 0; })
    .sort(function (a, b) {
      if (b.dots !== a.dots) return b.dots - a.dots;
      return String(a.name).localeCompare(String(b.name));
    });

  // Standard competition ranking: ties share a rank, the next rank skips.
  var rank = 0;
  var prev = null;
  rows.forEach(function (r, i) {
    if (prev === null || r.dots !== prev) { rank = i + 1; prev = r.dots; }
    r.rank = rank;
  });

  cachePut_(key, rows.slice(0, 50), CACHE_TTL.LEADERBOARD);
  return rows.slice(0, limit);
}

/** Leaderboard of who has GIVEN the most — generosity, not popularity. */
function giverLeaderboard_(size) {
  var rows = allBalances_()
    .map(function (b) {
      return { user_id: String(b.user_id), name: String(b.name || b.user_id), dots: num_(b.given_total) };
    })
    .filter(function (r) { return r.user_id && r.dots > 0; })
    .sort(function (a, b) { return b.dots - a.dots; });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  return rows.slice(0, size || cfgNum_('LEADERBOARD_SIZE'));
}

/** Workspace-wide counters for the App Home and the web leaderboard. */
function globalStats_() {
  var cached = cacheGet_('stats');
  if (cached) return cached;
  var rows = allBalances_();
  var stats = {
    people: 0,
    wagsAllTime: 0,
    wagsThisPeriod: 0,
    wagsThisMonth: 0,
    unspentThisPeriod: 0,
    participationThisPeriod: 0,
    periodKey: periodKey_(),
    weekKey: weekKey_(),
    monthKey: monthKey_()
  };
  rows.forEach(function (b) {
    if (!String(b.user_id).trim()) return;
    stats.people++;
    stats.wagsAllTime += num_(b.received_total);
    stats.wagsThisPeriod += num_(b.received_this_period);
    stats.wagsThisMonth += num_(b.received_month);
    stats.unspentThisPeriod += num_(b.remaining);
    if (num_(b.spent_this_period) > 0) stats.participationThisPeriod++;
  });
  cachePut_('stats', stats, CACHE_TTL.STATS);
  return stats;
}

/** The most recent reasons, for the feed on the App Home and the web page. */
function recentReasons_(limit, filter) {
  var f = filter || {};
  f.limit = limit || 10;
  f.newestFirst = true;
  return queryLedger_(f).map(function (r) {
    return {
      ts: r.ts_iso,
      giver_id: String(r.giver_id),
      giver_name: String(r.giver_name),
      receiver_id: String(r.receiver_id),
      receiver_name: String(r.receiver_name),
      dots: num_(r.dots),
      value_tag: String(r.value_tag || ''),
      reason: String(r.reason || '')
    };
  });
}

/**
 * How tailwags were distributed across the company values in a period.
 * Reads the ledger, so it is used by digests and dashboards, never by a slash
 * command that has to answer inside three seconds.
 * @param {{week_key?:string, month_key?:string}} filter
 * @return {Array<{tag:string,label:string,emoji:string,tailwags:number,share:number}>}
 */
function valueBreakdown_(filter) {
  if (!cfgBool_('VALUES_ENABLED')) return [];
  var rows = queryLedger_(filter || {});
  var counts = {};
  var total = 0;
  rows.forEach(function (r) {
    var tag = String(r.value_tag || '').toLowerCase();
    if (!tag) return;
    counts[tag] = (counts[tag] || 0) + num_(r.dots);
    total += num_(r.dots);
  });
  return valueList_().map(function (v) {
    var dots = counts[v.tag] || 0;
    return {
      tag: v.tag,
      label: v.label,
      emoji: v.emoji,
      dots: dots,
      share: total > 0 ? dots / total : 0
    };
  }).sort(function (a, b) { return b.dots - a.dots; });
}
