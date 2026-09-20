/**
 * Tail Wag — 10_Triggers.gs
 * Scheduled work: the period digest, the monthly raffle draw, roster sync, and
 * the maintenance jobs an admin can reach for.
 *
 * Apps Script offers no monthly trigger, so a single daily job runs at
 * DIGEST_HOUR and decides for itself what today is: the first day of the
 * allowance week means a digest, the first of the month means a drawing.
 */

/** The one scheduled entry point. Installed by installTriggers(). */
function dailyJob(e) {
  if (!calledByOwnTrigger_(e, 'dailyJob')) ownerOnly_('dailyJob');
  // Every function without a trailing underscore can be called by anyone who
  // loads a page served by the web app, via google.script.run. The scheduled
  // work is harmless to repeat except for the posts it makes, so a second call
  // on the same day is a no-op rather than a second digest.
  var props = PropertiesService.getScriptProperties();
  var today = dayKey_();
  if (props.getProperty('TW_DAILY_LAST') === today) return 'Already ran today.';
  props.setProperty('TW_DAILY_LAST', today);
  return dailyJob_();
}

/** The body of the daily job. */
function dailyJob_() {
  try {
    var d = now_();
    var dow = parseInt(fmt_(d, 'u'), 10) % 7; // 1=Mon…7=Sun → 1..6,0
    var dom = parseInt(fmt_(d, 'd'), 10);
    var startDow = DAY_INDEX[String(cfgStr_('WEEK_START_DAY') || 'MONDAY').toUpperCase()];
    if (startDow === undefined) startDow = 1;

    if (dom === 1 && cfgBool_('RAFFLE_ENABLED')) {
      var draw = runRaffleDraw_(prevMonthKey_(d), false);
      logInfo_('raffle.scheduled', 'system', draw.message);
    }

    // The digest reports a calendar week, so it goes out on the week-start day
    // whether allowances refill daily or weekly.
    var wantDigest = cfgBool_('WEEKLY_DIGEST_ENABLED') && dow === startDow;
    if (wantDigest) {
      var res = postDigest_(false);
      logInfo_('digest.scheduled', 'system', res.ok ? 'posted' : res.error);
    }

    // Keep the roster fresh so new hires have a balance before their first tailwag.
    if (dow === startDow) syncRosterFromSlack_();

    pruneEvents_();
    pruneMessageClaims_();
  } catch (e) {
    logError_('daily_job.failed', 'system', String(e && e.stack || e));
  }
}

/**
 * Runs whenever someone edits the backing spreadsheet by hand, and drops
 * whatever the edited tab feeds. The app drops its own caches when it writes;
 * this covers the other writer, which is a person with the sheet open. Without
 * it, the long cache lives would make hand-editing a tab feel broken.
 */
function onConfigEdit(e) {
  try {
    var name = e && e.range && e.range.getSheet ? e.range.getSheet().getName() : '';
    if (!name) return;
    cacheDrop_('header.' + name);

    if (name === SHEETS.CONFIG) { cacheDrop_('config'); return; }
    if (name === SHEETS.ROSTER) { cacheDrop_('roster'); return; }
    if (name === SHEETS.BALANCES || name === SHEETS.LEDGER) {
      cacheDrop_('balances.index');
      cacheDrop_('stats');
      ['period', 'week', 'day', 'month', 'all'].forEach(function (p) {
        cacheDrop_('leaderboard.' + p);
      });
    }
  } catch (err) {
    // An edit must never fail because of us.
  }
}

/**
 * Fills the caches the command paths read, so a person never pays for a cold
 * read. Slack allows three seconds end to end and about a second of that is
 * Apps Script overhead before this code runs at all; opening the spreadsheet
 * and reading four tabs does not fit in what is left. On a team that gives a
 * handful of tailwags a day, every single command was landing on a cold cache.
 * Running every WARM_INTERVAL_MIN minutes keeps them filled between commands.
 *
 * It is pure reading. If it fails, the next command just does the work itself.
 */
function warmCaches() {
  var started = new Date().getTime();
  var warmed = [];
  try {
    getConfigAll_(); warmed.push('config');
    getRoster_(); warmed.push('roster');
    balanceIndex_(); warmed.push('balances');
    globalStats_(); warmed.push('stats');
    leaderboard_('period', 25); warmed.push('leaderboard');
  } catch (e) {
    logWarn_('warm.failed', 'system', String(e));
  }
  var ms = new Date().getTime() - started;
  logDebug_('warm.done', 'system', { ms: ms, warmed: warmed });
  return 'Warmed ' + warmed.join(', ') + ' in ' + ms + 'ms.';
}

/**
 * Apps Script accepts only 1, 5, 10, 15 or 30 for everyMinutes(). Anything else
 * throws, so a number typed into the Config tab is snapped to the nearest one
 * rather than breaking the install.
 */
function nearestMinuteInterval_(mins) {
  var allowed = [1, 5, 10, 15, 30];
  var want = num_(mins) || 15;
  var best = allowed[0];
  for (var i = 1; i < allowed.length; i++) {
    if (Math.abs(allowed[i] - want) < Math.abs(best - want)) best = allowed[i];
  }
  return best;
}

/** Installs (or reinstalls) the daily job, the sheet watcher and the cache warmer. Safe to run repeatedly. */
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'dailyJob' || fn === 'onConfigEdit' || fn === 'warmCaches') ScriptApp.deleteTrigger(t);
  });
  var hour = Math.max(0, Math.min(23, cfgNum_('DIGEST_HOUR') || 9));
  ScriptApp.newTrigger('dailyJob')
    .timeBased()
    .atHour(hour)
    .nearMinute(5)
    .everyDays(1)
    .inTimezone(cfgStr_('TIMEZONE') || 'America/Denver')
    .create();
  try {
    ScriptApp.newTrigger('onConfigEdit')
      .forSpreadsheet(ss_())
      .onEdit()
      .create();
  } catch (e) {
    logWarn_('triggers.on_edit_failed', 'system', String(e));
  }

  var warmEvery = 0;
  if (cfgBool_('KEEP_CACHES_WARM')) {
    // Apps Script only offers a few fixed minute intervals.
    warmEvery = nearestMinuteInterval_(cfgNum_('WARM_INTERVAL_MIN'));
    ScriptApp.newTrigger('warmCaches')
      .timeBased()
      .everyMinutes(warmEvery)
      .create();
  }

  logInfo_('triggers.installed', 'system',
    'dailyJob at ' + hour + ':05 ' + cfgStr_('TIMEZONE') + ', onConfigEdit' +
    (warmEvery ? ', warmCaches every ' + warmEvery + 'm' : ''));
  return 'Daily job installed for ' + hour + ':05 ' + cfgStr_('TIMEZONE') +
    ', plus the sheet watcher' + (warmEvery ? ' and the cache warmer (every ' + warmEvery + ' minutes).' : '.');
}

/** Removes the scheduled job. */
function removeTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'dailyJob' || fn === 'onConfigEdit' || fn === 'warmCaches') { ScriptApp.deleteTrigger(t); n++; }
  });
  return 'Removed ' + n + ' trigger(s).';
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * Posts the digest covering the period that just ended.
 * @param {boolean} force post even when the digest is switched off
 */
function postDigest_(force) {
  if (!force && !cfgBool_('WEEKLY_DIGEST_ENABLED')) return { ok: false, error: 'digest_disabled' };

  // The digest always covers a calendar week. In daily-allowance mode the
  // "period" is a single day, which is far too thin to be worth a post, so the
  // reporting window is deliberately decoupled from the refill cadence.
  var prevWeek = prevWeekKey_();
  var ledgerFilter = { week_key: prevWeek };
  var rows = queryLedger_(ledgerFilter);
  var periodLabel = 'week of ' + prevWeek;

  var byReceiver = {};
  var byGiver = {};
  var totalWags = 0;
  rows.forEach(function (r) {
    var d = num_(r.dots);
    totalWags += d;
    var rid = String(r.receiver_id);
    var gid = String(r.giver_id);
    if (!byReceiver[rid]) byReceiver[rid] = { user_id: rid, name: String(r.receiver_name), dots: 0 };
    byReceiver[rid].dots += d;
    if (!byGiver[gid]) byGiver[gid] = { user_id: gid, name: String(r.giver_name), dots: 0 };
    byGiver[gid].dots += d;
  });

  if (totalWags === 0 && !force) return { ok: false, error: 'nothing_to_report' };

  var receivers = Object.keys(byReceiver).map(function (k) { return byReceiver[k]; })
    .sort(function (a, b) { return b.dots - a.dots; });
  receivers.forEach(function (r, i) { r.rank = i + 1; });
  var givers = Object.keys(byGiver).map(function (k) { return byGiver[k]; })
    .sort(function (a, b) { return b.dots - a.dots; });
  givers.forEach(function (r, i) { r.rank = i + 1; });

  var msg = buildDigest_(periodLabel, receivers, givers, {
    dots: totalWags,
    givers: givers.length,
    receivers: receivers.length
  }, valueBreakdown_(ledgerFilter));

  var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
  var res = postMessage_(channel, msg.text, msg.blocks);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---------------------------------------------------------------------------
// Raffle
// ---------------------------------------------------------------------------

/**
 * Runs the drawing for a period. Selection is weighted by entries: one tailwag
 * received is one ticket in the drum, so an occasional contributor still has a
 * real chance while a standout has a proportionally better one.
 *
 * @param {string} period e.g. '2026-08'
 * @param {boolean} force draw even if it has already been drawn or is under the minimum
 * @return {{ok:boolean, message:string, winners:Array}}
 */
function runRaffleDraw_(period, force) {
  if (!cfgBool_('RAFFLE_ENABLED') && !force) {
    return { ok: false, message: 'The raffle is switched off.', winners: [] };
  }

  var existing = raffleWinners_(period);
  if (existing.length && !force) {
    return {
      ok: false,
      message: period + ' has already been drawn: ' + existing.map(function (w) { return w.name; }).join(', '),
      winners: existing
    };
  }

  var pool = raffleEntriesFor_(period).filter(function (r) { return num_(r.entries) > 0; });
  var totalEntries = 0;
  pool.forEach(function (r) { totalEntries += num_(r.entries); });

  var minEntries = cfgNum_('RAFFLE_MIN_ENTRIES_TO_DRAW');
  if (totalEntries < minEntries && !force) {
    return {
      ok: false,
      message: period + ' had only ' + totalEntries + ' entries — under the minimum of ' +
        minEntries + ', so no drawing.',
      winners: []
    };
  }
  if (!pool.length) {
    return { ok: false, message: 'No entries for ' + period + '.', winners: [] };
  }

  // Optionally keep last month's winner out of the drum.
  var candidates = pool.slice();
  if (cfgBool_('RAFFLE_EXCLUDE_LAST_WINNER')) {
    var lastPeriod = prevMonthOf_(period);
    var lastWinners = {};
    raffleWinners_(lastPeriod).forEach(function (w) { lastWinners[String(w.user_id)] = true; });
    var filtered = candidates.filter(function (c) { return !lastWinners[String(c.user_id)]; });
    if (filtered.length) candidates = filtered;
  }

  var want = Math.max(1, Math.min(cfgNum_('RAFFLE_WINNERS_PER_DRAW') || 1, candidates.length));
  var winners = drawWeighted_(candidates, want);

  winners.forEach(function (w) { markRaffleWinner_(period, String(w.user_id)); });

  var msg = buildRaffleAnnouncement_(period, winners.map(function (w) {
    return { user_id: String(w.user_id), name: String(w.name), entries: num_(w.entries) };
  }), totalEntries, pool.length);

  var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
  postMessage_(channel, msg.text, msg.blocks);

  // DM the winners so it does not get lost in the channel.
  if (cfgBool_('DM_RECIPIENT')) {
    slackApiAll_(winners.map(function (w) {
      return {
        method: 'chat.postMessage',
        payload: {
          channel: String(w.user_id),
          text: 'You won the ' + period + ' Tail Wag raffle.',
          blocks: [sectionBlock_(':tada: *You won the ' + period + ' Tail Wag raffle* — ' +
            num_(w.entries) + ' entries out of ' + totalEntries + '.' +
            (cfgStr_('RAFFLE_PRIZE') ? '\nPrize: *' + escapeSlack_(cfgStr_('RAFFLE_PRIZE')) + '*' : ''))]
        }
      };
    }));
  }

  logInfo_('raffle.drawn', 'system', {
    period: period, winners: winners.map(function (w) { return w.user_id; }), totalEntries: totalEntries
  });

  return {
    ok: true,
    message: 'Drew ' + winners.map(function (w) { return w.name; }).join(', ') +
      ' from ' + totalEntries + ' entries. Announced in ' + cfgStr_('ANNOUNCE_CHANNEL') + '.',
    winners: winners
  };
}

/**
 * Picks n distinct rows, weighted by their `entries` count, without replacement.
 * @param {Array<{entries:number}>} rows
 * @param {number} n
 */
function drawWeighted_(rows, n) {
  var remaining = rows.slice();
  var picked = [];
  for (var k = 0; k < n && remaining.length; k++) {
    var total = 0;
    remaining.forEach(function (r) { total += num_(r.entries); });
    if (total <= 0) break;
    var target = random_() * total;
    var acc = 0;
    var chosenIndex = remaining.length - 1;
    for (var i = 0; i < remaining.length; i++) {
      acc += num_(remaining[i].entries);
      if (target < acc) { chosenIndex = i; break; }
    }
    picked.push(remaining[chosenIndex]);
    remaining.splice(chosenIndex, 1);
  }
  return picked;
}

/** The month key before a given "YYYY-MM". */
function prevMonthOf_(period) {
  var m = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10) - 1;
  if (mo === 0) { mo = 12; y -= 1; }
  return y + '-' + pad2_(mo);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Pulls the member list from Slack onto the Roster tab, so new hires have a
 * balance waiting and leavers stop appearing on boards.
 */
function syncRosterFromSlack_() {
  var added = 0, updated = 0, skipped = 0;
  var cursor = '';
  var roster = getRoster_();

  for (var page = 0; page < 20; page++) {
    var res = slackApiGet_('users.list', { limit: 200, cursor: cursor }, true);
    if (!res.ok || !res.members) break;

    res.members.forEach(function (u) {
      if (u.is_bot || u.deleted || u.id === 'USLACKBOT' || u.is_app_user) { skipped++; return; }
      var profile = {
        display_name: (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name,
        real_name: (u.profile && u.profile.real_name) || '',
        email: (u.profile && u.profile.email) || ''
      };
      if (roster[u.id]) { upsertRoster_(u.id, profile); updated++; }
      else { upsertRoster_(u.id, profile); added++; }
    });

    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }

  cacheDrop_('roster');
  logInfo_('roster.synced', 'system', { added: added, updated: updated, skipped: skipped });
  return { added: added, updated: updated, skipped: skipped };
}

/**
 * Recomputes every balance from the ledger. The ledger is the source of truth;
 * this is the button to press if a balance ever looks wrong.
 */
function rebuildBalancesFromLedger_() {
  return withLock_(function () {
    var rows = readSheet_(SHEETS.LEDGER);
    var pk = periodKey_();
    var mk = monthKey_();
    var wk = weekKey_();
    var acc = {};

    function ensure(id, name) {
      if (!acc[id]) {
        acc[id] = {
          user_id: id, name: name || id, pool: poolOf_(id), period_key: pk,
          allowance: allowanceFor_(id), spent_this_period: 0, remaining: allowanceFor_(id),
          given_to_json: {}, month_key: mk, received_this_period: 0, received_month: 0,
          received_total: 0, given_total: 0, badges_json: [], streak: 0, last_gave_period: '',
          updated_ts: iso_()
        };
      }
      if (name) acc[id].name = name;
      return acc[id];
    }

    rows.forEach(function (r) {
      var dots = num_(r.dots);
      if (!dots) return;
      var gid = String(r.giver_id || '').trim();
      var rid = String(r.receiver_id || '').trim();
      if (!rid) return;

      var recv = ensure(rid, String(r.receiver_name || ''));
      recv.received_total += dots;
      if (normMonthKey_(r.month_key) === mk) recv.received_month += dots;
      var inPeriod = isDailyAllowance_()
        ? String(r.ts_iso || '').slice(0, 10) === pk
        : String(r.week_key).trim() === wk;
      if (inPeriod) recv.received_this_period += dots;

      if (gid && String(r.pool) !== 'admin') {
        var give = ensure(gid, String(r.giver_name || ''));
        give.given_total += dots;
        if (inPeriod) {
          give.spent_this_period += dots;
          give.remaining = Math.max(0, num_(give.allowance) - give.spent_this_period);
          give.given_to_json[rid] = (give.given_to_json[rid] || 0) + dots;
        }
      }
    });

    // Re-derive badges from the rebuilt totals.
    Object.keys(acc).forEach(function (id) {
      var b = acc[id];
      var keys = [];
      badgeLadder_('receiver').forEach(function (def) {
        if (b.received_total >= def.threshold) keys.push(def.key);
      });
      badgeLadder_('giver').forEach(function (def) {
        if (b.given_total >= def.threshold) keys.push(def.key);
      });
      b.badges_json = JSON.stringify(keys);
      b.given_to_json = JSON.stringify(b.given_to_json);
    });

    // Rewrite the whole tab in one pass, in the tab's own column order.
    var cols = headerOf_(SHEETS.BALANCES).order;
    var ids = Object.keys(acc);
    var s = sheet_(SHEETS.BALANCES);
    s.clear();
    s.getRange(1, 1, 1, cols.length).setValues([cols]);
    s.setFrozenRows(1);
    if (ids.length) {
      var matrix = ids.map(function (id) {
        return cols.map(function (c) {
          var v = c ? acc[id][c] : '';
          return sanitizeCell_(v === undefined || v === null ? '' : v);
        });
      });
      s.getRange(2, 1, matrix.length, cols.length).setValues(matrix);
    }

    cacheDropAll_();
    return { people: ids.length, rows: rows.length };
  }, 60000);
}

/**
 * Clears out the per-message idempotency claims.
 *
 * Every emoji or reaction give writes a script property so Slack's retry of the
 * same event can be recognized and dropped. Apps Script caps the property store,
 * and a full store makes setProperty throw — at which point idempotency quietly
 * degrades to the six-hour cache and retries start double-awarding. Claims are
 * only useful for as long as Slack retries (minutes), so a daily sweep is safe.
 */
function pruneMessageClaims_(maxAgeHours) {
  var props = PropertiesService.getScriptProperties();
  var all;
  try { all = props.getProperties(); } catch (e) { return 0; }
  var cutoff = now_().getTime() / 1000 - (maxAgeHours || 24) * 3600;
  var removed = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('OD_MSG_') !== 0) return;
    // Key shape: OD_MSG_<userId>_<slack ts>, and a Slack ts is unix seconds.
    var ts = parseFloat(String(k).split('_').pop());
    if (isNaN(ts) || ts < cutoff) {
      try { props.deleteProperty(k); removed++; } catch (e) { /* keep going */ }
    }
  });
  if (removed) logInfo_('claims.pruned', 'system', { removed: removed });
  return removed;
}

/** Keeps the Events tab from growing without bound. */
function pruneEvents_(keepRows) {
  var keep = keepRows || 5000;
  var s = sheet_(SHEETS.EVENTS);
  var last = s.getLastRow();
  if (last <= keep + 1) return 0;
  var remove = last - keep - 1;
  s.deleteRows(2, remove);
  return remove;
}

/** Editor entry point — owner only. See ownerOnly_(). */
function installTriggers() {
  ownerOnly_('installTriggers');
  return installTriggers_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function removeTriggers() {
  ownerOnly_('removeTriggers');
  return removeTriggers_();
}
