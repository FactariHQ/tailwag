/**
 * Tail Wag — 02_Store.gs
 * The Google Sheet data layer: spreadsheet access, roster, balances, ledger,
 * badges and raffle entries.
 *
 * Design notes
 * ------------
 * Slack gives a slash command three seconds to respond, so nothing on the hot
 * path is allowed to scan the whole ledger. Everything a /wag needs — the
 * giver's remaining allowance, how many tailwags they have already sent this
 * recipient this week, the recipient's running totals and badge state — lives
 * denormalized on that person's single row of the Balances tab. The Ledger tab
 * is append-only and exists for audit, export and the reasons feed.
 */

var PROP_SPREADSHEET_ID = 'OD_SPREADSHEET_ID';
var __ssCache = null;
var __sheetCache = {};

/** The backing spreadsheet. Bound container if there is one, otherwise by id. */
function ss_() {
  if (__ssCache) return __ssCache;
  var id = PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID) || builtInSpreadsheetId_();
  if (id) {
    __ssCache = SpreadsheetApp.openById(id);
  } else {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      throw new Error('No spreadsheet configured. Run setupSpreadsheet() once, or set the ' +
        PROP_SPREADSHEET_ID + ' script property to the spreadsheet id.');
    }
    __ssCache = active;
    PropertiesService.getScriptProperties().setProperty(PROP_SPREADSHEET_ID, active.getId());
  }
  return __ssCache;
}

/**
 * The spreadsheet id compiled into the rewards portal build (scripts/build-portal.js
 * writes PORTAL_SPREADSHEET_ID), so the second project finds the shared sheet
 * without anyone typing script properties.
 */
function builtInSpreadsheetId_() {
  return typeof PORTAL_SPREADSHEET_ID !== 'undefined' && PORTAL_SPREADSHEET_ID ? String(PORTAL_SPREADSHEET_ID) : '';
}

/** A tab by name, creating it with headers if it is missing. */
function sheet_(name) {
  if (__sheetCache[name]) return __sheetCache[name];
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
    var cols = COLUMNS[nameToKey_(name)];
    if (cols) {
      s.getRange(1, 1, 1, cols.length).setValues([cols]);
      s.setFrozenRows(1);
    }
  }
  __sheetCache[name] = s;
  return s;
}

function nameToKey_(name) {
  for (var k in SHEETS) if (SHEETS[k] === name) return k;
  return name.toUpperCase();
}

/**
 * Reads a whole tab as an array of objects keyed by the header row.
 * @param {string} name
 * @return {Array<Object>}
 */
function readSheet_(name) {
  var s = sheet_(name);
  var last = s.getLastRow();
  if (last < 2) return [];
  var values = s.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      row[headers[c]] = values[r][c];
      if (values[r][c] !== '' && values[r][c] !== null) empty = false;
    }
    if (empty) continue;
    row.__row = r + 1;
    out.push(row);
  }
  return out;
}

/** Appends an object as a row, ordered by the tab's declared columns. */
function appendRow_(name, obj) {
  var cols = COLUMNS[nameToKey_(name)];
  var row = cols.map(function (c) {
    var v = obj[c];
    return sanitizeCell_(v === undefined || v === null ? '' : v);
  });
  sheet_(name).appendRow(row);
}

/**
 * The live column order of a tab, read from its header row rather than assumed.
 *
 * setupSpreadsheet() repairs a missing column by appending it on the right, so
 * a sheet upgraded from an older version can have a different column order to
 * COLUMNS. Anything that reads or writes a row by position must go through
 * here, or an upgrade silently shuffles everyone's totals into the wrong fields.
 *
 * @return {{order:Array<string>, index:Object<string,number>}}
 */
function headerOf_(name) {
  var cached = cacheGet_('header.' + name);
  if (cached) return cached;
  var s = sheet_(name);
  var width = s.getLastColumn();
  var declared = COLUMNS[nameToKey_(name)] || [];
  var order = width > 0
    ? s.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); })
    : declared.slice();
  if (!order.length || !order[0]) order = declared.slice();
  var index = {};
  order.forEach(function (h, i) { if (h) index[h] = i; });
  var out = { order: order, index: index };
  cachePut_('header.' + name, out, CACHE_TTL.HEADER);
  return out;
}

/** Runs fn while holding the script lock, so two concurrent /wag calls cannot double-spend. */
function withLock_(fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(timeoutMs === undefined ? 12000 : timeoutMs);
  if (!got) throw new Error('BUSY');
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** Roster as a map of user_id → row object. */
function getRoster_() {
  var cached = cacheGet_('roster');
  if (cached) return cached;
  var rows = readSheet_(SHEETS.ROSTER);
  var map = {};
  rows.forEach(function (r) {
    var id = String(r.user_id || '').trim();
    if (id) map[id] = r;
  });
  cachePut_('roster', map, CACHE_TTL.ROSTER);
  return map;
}

/** True when the user draws from the manager pool. */
function isManager_(userId) {
  if (cfgList_('MANAGER_USER_IDS').indexOf(userId) !== -1) return true;
  var r = getRoster_()[userId];
  return !!(r && String(r.pool || '').trim().toLowerCase() === 'manager');
}

/** True when the user may run /wag-admin. */
function isAdmin_(userId) {
  return cfgList_('ADMIN_USER_IDS').indexOf(userId) !== -1;
}

/** Which allowance pool a user draws from. */
function poolOf_(userId) {
  return isManager_(userId) ? 'manager' : 'peer';
}

/** Weekly allowance for a user, by pool. */
function allowanceFor_(userId) {
  return isManager_(userId)
    ? cfgNum_('ALLOWANCE_MANAGER')
    : cfgNum_('ALLOWANCE_PEER');
}

/** Adds or updates a roster row. Safe to call on every interaction. */
function upsertRoster_(userId, profile) {
  var roster = getRoster_();
  var existing = roster[userId];
  var name = (profile && (profile.display_name || profile.real_name)) || (existing && existing.display_name) || userId;
  if (existing) {
    var changed = false;
    var sh = sheet_(SHEETS.ROSTER);
    var cols = COLUMNS.ROSTER;
    if (profile && profile.display_name && profile.display_name !== existing.display_name) {
      sh.getRange(existing.__row, cols.indexOf('display_name') + 1).setValue(profile.display_name);
      changed = true;
    }
    if (profile && profile.real_name && profile.real_name !== existing.real_name) {
      sh.getRange(existing.__row, cols.indexOf('real_name') + 1).setValue(profile.real_name);
      changed = true;
    }
    if (profile && profile.email && profile.email !== existing.email) {
      sh.getRange(existing.__row, cols.indexOf('email') + 1).setValue(profile.email);
      changed = true;
    }
    if (changed) cacheDrop_('roster');
    return existing;
  }
  appendRow_(SHEETS.ROSTER, {
    user_id: userId,
    display_name: name,
    real_name: (profile && profile.real_name) || '',
    email: (profile && profile.email) || '',
    pool: 'peer',
    active: true,
    location: '',
    added_ts: iso_()
  });
  cacheDrop_('roster');
  return { user_id: userId, display_name: name, pool: 'peer', active: true };
}

/** True when the roster gate is closed to this user. */
function rosterBlocks_(userId) {
  if (!cfgBool_('REQUIRE_ROSTER')) return false;
  var r = getRoster_()[userId];
  if (!r) return true;
  var active = r.active;
  if (typeof active === 'string') active = active.trim().toLowerCase() !== 'false' && active.trim() !== '';
  return active === false;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** user_id → sheet row number, cached. */
function balanceIndex_() {
  var cached = cacheGet_('balances.index');
  if (cached) return cached;
  var s = sheet_(SHEETS.BALANCES);
  var last = s.getLastRow();
  var idx = {};
  if (last >= 2) {
    var ids = s.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]).trim();
      if (id) idx[id] = i + 2;
    }
  }
  cachePut_('balances.index', idx, CACHE_TTL.BALANCE_INDEX);
  return idx;
}

function emptyBalance_(userId, name) {
  return {
    user_id: userId,
    name: name || userId,
    pool: poolOf_(userId),
    period_key: periodKey_(),
    allowance: allowanceFor_(userId),
    spent_this_period: 0,
    remaining: allowanceFor_(userId),
    given_to_json: '{}',
    month_key: monthKey_(),
    received_this_period: 0,
    received_month: 0,
    received_total: 0,
    given_total: 0,
    badges_json: '[]',
    streak: 0,
    last_gave_period: '',
    updated_ts: iso_()
  };
}

/**
 * Reads a user's balance row, creating it if absent and rolling it forward when
 * the week or month has turned over. The roll-forward is lazy on purpose: the
 * scheduled Monday trigger is a convenience, not a correctness requirement, so a
 * missed trigger can never hand anyone a stale allowance.
 * @param {string} userId
 * @param {string=} name
 * @param {boolean=} persist write the roll-forward back to the sheet
 * @return {Object}
 */
function getBalance_(userId, name, persist) {
  var idx = balanceIndex_();
  var s = sheet_(SHEETS.BALANCES);
  var head = headerOf_(SHEETS.BALANCES);
  var cols = head.order;
  var bal;

  if (idx[userId]) {
    var row = s.getRange(idx[userId], 1, 1, cols.length).getValues()[0];
    bal = {};
    for (var c = 0; c < cols.length; c++) if (cols[c]) bal[cols[c]] = row[c];
    bal.__row = idx[userId];
    // Guard against a stale cached index pointing at the wrong row.
    if (String(bal.user_id).trim() !== userId) {
      cacheDrop_('balances.index');
      idx = balanceIndex_();
      if (idx[userId]) {
        row = s.getRange(idx[userId], 1, 1, cols.length).getValues()[0];
        bal = {};
        for (var c2 = 0; c2 < cols.length; c2++) if (cols[c2]) bal[cols[c2]] = row[c2];
        bal.__row = idx[userId];
      } else {
        bal = null;
      }
    }
  }

  if (!bal) {
    bal = emptyBalance_(userId, name);
    appendRow_(SHEETS.BALANCES, bal);
    cacheDrop_('balances.index');
    bal.__row = sheet_(SHEETS.BALANCES).getLastRow();
    return bal;
  }

  if (name && bal.name !== name) bal.name = name;

  var rolled = rollForward_(bal);
  if (rolled && persist !== false) writeBalance_(bal);
  return bal;
}

/**
 * Applies week and month turnover to a balance object in place.
 * @return {boolean} true when anything changed
 */
function rollForward_(bal) {
  var changed = false;
  var wk = periodKey_();
  var mk = monthKey_();

  if (normPeriodKey_(bal.period_key) !== wk) {
    var allowance = allowanceFor_(bal.user_id);
    var carry = cfgBool_('CARRY_OVER_UNUSED') ? Math.max(0, num_(bal.remaining)) : 0;
    bal.period_key = wk;
    bal.allowance = allowance + carry;
    bal.spent_this_period = 0;
    bal.remaining = allowance + carry;
    bal.given_to_json = '{}';
    bal.received_this_period = 0;
    bal.pool = poolOf_(bal.user_id);
    changed = true;
  }
  if (normMonthKey_(bal.month_key) !== mk) {
    bal.month_key = mk;
    bal.received_month = 0;
    changed = true;
  }
  return changed;
}

/**
 * Writes a balance object back to its row.
 *
 * The row number is re-checked against the user id immediately before writing.
 * A cached row index can go stale within the life of one execution — an admin
 * deleting a row elsewhere shifts everything below it up — and writing blind
 * would overwrite a different person's totals with these ones. That is the kind
 * of corruption nobody notices until the leaderboard is wrong.
 */
function writeBalance_(bal) {
  var s = sheet_(SHEETS.BALANCES);
  var cols = headerOf_(SHEETS.BALANCES).order;
  bal.updated_ts = iso_();

  var target = bal.__row;
  if (!target) {
    var idx = balanceIndex_();
    target = idx[bal.user_id];
  }

  // Confirm the row still belongs to this person.
  if (target) {
    var occupant = String(s.getRange(target, 1).getValue()).trim();
    if (occupant !== String(bal.user_id).trim()) {
      cacheDrop_('balances.index');
      var fresh = balanceIndex_();
      target = fresh[bal.user_id] || 0;
    }
  }

  if (!target) {
    appendRow_(SHEETS.BALANCES, bal);
    cacheDrop_('balances.index');
    bal.__row = s.getLastRow();
    return;
  }

  bal.__row = target;
  var row = cols.map(function (c) {
    var v = c ? bal[c] : '';
    return sanitizeCell_(v === undefined || v === null ? '' : v);
  });
  s.getRange(target, 1, 1, cols.length).setValues([row]);
}

/** Coerces a cell to a number. */
function num_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v === null || v === undefined ? '' : v));
  return isNaN(n) ? 0 : n;
}

/** Parses a JSON cell, returning the fallback on anything unexpected. */
function parseJson_(v, fallback) {
  try {
    if (v === '' || v === null || v === undefined) return fallback;
    var parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

/** How many tailwags this giver has already sent this recipient during the current week. */
function givenToThisWeek_(bal, receiverId) {
  var map = parseJson_(bal.given_to_json, {});
  return num_(map[receiverId]);
}

/** Records tailwags against the per-recipient weekly cap. */
function bumpGivenTo_(bal, receiverId, dots) {
  var map = parseJson_(bal.given_to_json, {});
  map[receiverId] = num_(map[receiverId]) + dots;
  bal.given_to_json = JSON.stringify(map);
}

/** All balance rows, rolled forward in memory but not written. */
function allBalances_() {
  var rows = readSheet_(SHEETS.BALANCES);
  rows.forEach(function (b) { rollForward_(b); });
  return rows;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Appends one give to the immutable ledger. */
function appendLedger_(entry) {
  appendRow_(SHEETS.LEDGER, {
    id: entry.id || newId_(),
    ts_iso: entry.ts_iso || iso_(),
    week_key: entry.week_key || weekKey_(),
    month_key: entry.month_key || monthKey_(),
    giver_id: entry.giver_id,
    giver_name: entry.giver_name,
    receiver_id: entry.receiver_id,
    receiver_name: entry.receiver_name,
    dots: entry.dots,
    reason: entry.reason,
    value_tag: entry.value_tag || '',
    channel_id: entry.channel_id || '',
    channel_name: entry.channel_name || '',
    source: entry.source || 'slash',
    pool: entry.pool || 'peer',
    message_ts: entry.message_ts || ''
  });
}

/**
 * Reads ledger rows matching a filter. Only used off the hot path
 * (admin exports, the reasons feed, rebuilds).
 * @param {{week_key?:string, month_key?:string, receiver_id?:string,
 *          giver_id?:string, limit?:number, newestFirst?:boolean}} f
 */
function queryLedger_(f) {
  f = f || {};
  var rows = readSheet_(SHEETS.LEDGER);
  var out = rows.filter(function (r) {
    if (f.week_key && String(r.week_key).trim() !== f.week_key) return false;
    if (f.month_key && normMonthKey_(r.month_key) !== f.month_key) return false;
    if (f.receiver_id && String(r.receiver_id) !== f.receiver_id) return false;
    if (f.giver_id && String(r.giver_id) !== f.giver_id) return false;
    return true;
  });
  if (f.newestFirst !== false) out.reverse();
  if (f.limit) out = out.slice(0, f.limit);
  return out;
}

/** True when this Slack message has already produced tailwags (emoji idempotency). */
function messageAlreadyCounted_(messageTs, giverId) {
  if (!messageTs) return false;
  var key = 'msg.' + giverId + '.' + messageTs;
  if (cacheGet_(key)) return true;
  var props = PropertiesService.getScriptProperties();
  var seen = props.getProperty('OD_MSG_' + giverId + '_' + messageTs);
  return !!seen;
}

/**
 * Releases a claim on a message, so a Slack retry gets a real second chance.
 * Used when the work failed for a reason that will not recur — a lock conflict,
 * not a rule violation.
 */
function unmarkMessageCounted_(messageTs, giverId) {
  if (!messageTs) return;
  cacheDrop_('msg.' + giverId + '.' + messageTs);
  try {
    PropertiesService.getScriptProperties()
      .deleteProperty('OD_MSG_' + giverId + '_' + messageTs);
  } catch (e) { /* best effort */ }
}

/** Marks a Slack message as already counted. */
function markMessageCounted_(messageTs, giverId) {
  if (!messageTs) return;
  cachePut_('msg.' + giverId + '.' + messageTs, 1, CACHE_TTL.MESSAGE_CLAIM);
  try {
    PropertiesService.getScriptProperties()
      .setProperty('OD_MSG_' + giverId + '_' + messageTs, '1');
  } catch (e) { /* property store is best effort */ }
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Awards any badges the user has newly earned, recording them on the Badges tab
 * and on the balance row.
 * @return {Array<Object>} newly awarded badge definitions
 */
function awardBadges_(bal) {
  var earned = parseJson_(bal.badges_json, []);
  var have = {};
  earned.forEach(function (k) { have[k] = true; });
  var fresh = [];

  [['receiver', num_(bal.received_total)], ['giver', num_(bal.given_total)]].forEach(function (pair) {
    var ladder = badgeLadder_(pair[0]);
    var total = pair[1];
    ladder.forEach(function (b) {
      if (total >= b.threshold && !have[b.key]) {
        have[b.key] = true;
        earned.push(b.key);
        fresh.push(b);
        appendRow_(SHEETS.BADGES, {
          user_id: bal.user_id,
          name: bal.name,
          track: b.track,
          threshold: b.threshold,
          badge_key: b.key,
          badge_label: b.label,
          emoji: b.emoji,
          awarded_ts: iso_()
        });
      }
    });
  });

  if (fresh.length) bal.badges_json = JSON.stringify(earned);
  return fresh;
}

/** Badge definitions a user currently holds. */
function badgesFor_(bal) {
  var keys = parseJson_(bal.badges_json, []);
  var all = badgeLadder_('receiver').concat(badgeLadder_('giver'));
  var byKey = {};
  all.forEach(function (b) { byKey[b.key] = b; });
  return keys.map(function (k) { return byKey[k]; }).filter(Boolean);
}

/** The next receiver badge a user is working toward, or null. */
function nextBadge_(bal) {
  var total = num_(bal.received_total);
  var ladder = badgeLadder_('receiver');
  for (var i = 0; i < ladder.length; i++) {
    if (total < ladder[i].threshold) {
      return { badge: ladder[i], need: ladder[i].threshold - total };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raffle
// ---------------------------------------------------------------------------

/**
 * period+user → raffle row, memoized for the life of one execution.
 *
 * Without the memo, a /wag naming several people re-scans the whole Raffle tab
 * twice per recipient — once to add entries, once to read the total back.
 */
var __raffleIdx = {};

function raffleIndex_(period) {
  if (__raffleIdx[period]) return __raffleIdx[period];
  var rows = readSheet_(SHEETS.RAFFLE);
  var idx = {};
  rows.forEach(function (r) {
    if (normMonthKey_(r.period) === period) idx[String(r.user_id)] = r;
  });
  __raffleIdx[period] = idx;
  return idx;
}

/** Drops the memo after a write, so the next read sees the new row. */
function raffleIndexDirty_(period) {
  if (period) delete __raffleIdx[period];
  else __raffleIdx = {};
}

/** Adds raffle entries for a receiver, respecting the per-person monthly cap. */
function addRaffleEntries_(userId, name, dots, period) {
  if (!cfgBool_('RAFFLE_ENABLED')) return 0;
  period = period || monthKey_();
  var cap = cfgNum_('RAFFLE_MAX_ENTRIES_PER_PERSON');
  var existing = raffleIndex_(period)[userId];
  var cols = COLUMNS.RAFFLE;

  if (existing) {
    var current = num_(existing.entries);
    var next = current + dots;
    if (cap > 0) next = Math.min(next, cap);
    if (next === current) return 0;
    sheet_(SHEETS.RAFFLE).getRange(existing.__row, cols.indexOf('entries') + 1).setValue(next);
    existing.entries = next;      // keep the memo in step with the sheet
    return next - current;
  }

  var initial = cap > 0 ? Math.min(dots, cap) : dots;
  var row = {
    period: period,
    user_id: userId,
    name: name,
    entries: initial,
    is_winner: false,
    drawn_ts: ''
  };
  appendRow_(SHEETS.RAFFLE, row);
  row.__row = sheet_(SHEETS.RAFFLE).getLastRow();
  raffleIndex_(period)[userId] = row;
  return initial;
}

/** Raffle rows for a period. */
function raffleEntriesFor_(period) {
  return readSheet_(SHEETS.RAFFLE).filter(function (r) { return normMonthKey_(r.period) === period; });
}

/** This user's entries in a period. */
function myRaffleEntries_(userId, period) {
  var r = raffleIndex_(period || monthKey_())[userId];
  return r ? num_(r.entries) : 0;
}

/** Marks a raffle row as a winner. */
function markRaffleWinner_(period, userId) {
  raffleIndexDirty_(period);
  var r = raffleIndex_(period)[userId];
  if (!r) return false;
  var cols = COLUMNS.RAFFLE;
  var sh = sheet_(SHEETS.RAFFLE);
  sh.getRange(r.__row, cols.indexOf('is_winner') + 1).setValue(true);
  sh.getRange(r.__row, cols.indexOf('drawn_ts') + 1).setValue(iso_());
  return true;
}

/** Winners of a period. */
function raffleWinners_(period) {
  return raffleEntriesFor_(period).filter(function (r) {
    return r.is_winner === true || String(r.is_winner).toLowerCase() === 'true';
  });
}
