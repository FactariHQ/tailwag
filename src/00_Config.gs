/**
 * Tail Wag — peer recognition for Slack, backed by Google Sheets.
 * 00_Config.gs — configuration schema, defaults, and typed accessors.
 *
 * Every knob lives in the "Config" tab of the spreadsheet so it can be changed
 * without touching code. Defaults below are used when a key is missing.
 */

/** Tab names in the backing spreadsheet. */
var SHEETS = {
  CONFIG: 'Config',
  ROSTER: 'Roster',
  LEDGER: 'Ledger',
  BALANCES: 'Balances',
  BADGES: 'Badges',
  RAFFLE: 'Raffle',
  EVENTS: 'Events',
  PODS: 'Pods',
  TICKETS: 'Tickets',
  WINNERS: 'Winners',
  IDEAS: 'Ideas'
};

/** Column order for each tab. Changing these means re-running setupSpreadsheet(). */
var COLUMNS = {
  CONFIG: ['key', 'value', 'notes'],
  ROSTER: ['user_id', 'display_name', 'real_name', 'email', 'pool', 'active', 'location', 'added_ts',
    'google_email'],
  LEDGER: ['id', 'ts_iso', 'week_key', 'month_key', 'giver_id', 'giver_name', 'receiver_id',
    'receiver_name', 'dots', 'reason', 'value_tag', 'channel_id', 'channel_name', 'source', 'pool',
    'message_ts'],
  BALANCES: ['user_id', 'name', 'pool', 'period_key', 'allowance', 'spent_this_period', 'remaining',
    'given_to_json', 'month_key', 'received_this_period', 'received_month', 'received_total',
    'given_total', 'badges_json', 'streak', 'last_gave_period', 'updated_ts'],
  BADGES: ['user_id', 'name', 'track', 'threshold', 'badge_key', 'badge_label', 'emoji', 'awarded_ts'],
  RAFFLE: ['period', 'user_id', 'name', 'entries', 'is_winner', 'drawn_ts'],
  EVENTS: ['ts_iso', 'level', 'type', 'actor', 'detail'],
  // Rewards. A pod is something the org puts up to be won; the Tickets tab is
  // an append-only wallet ledger (earnings, grants, entries, withdrawals,
  // refunds); Winners records every draw with the numbers behind it.
  PODS: ['pod_id', 'title', 'description', 'emoji', 'image_url', 'prize_value', 'winners_count',
    'max_tickets_per_person', 'opens_ts', 'closes_ts', 'status', 'announced_ts', 'reminded_ts', 'drawn_ts',
    'created_by', 'created_ts', 'updated_ts', 'sort'],
  TICKETS: ['id', 'ts_iso', 'user_id', 'name', 'delta', 'kind', 'pod_id', 'ref', 'note', 'actor'],
  WINNERS: ['pod_id', 'pod_title', 'place', 'user_id', 'name', 'tickets_in', 'pod_total_tickets',
    'entrants', 'drawn_ts', 'draw_roll', 'fulfilled', 'fulfilled_ts', 'fulfilled_by', 'notes'],
  // Reward ideas staff nominate. voters is a comma list of Slack ids; a selected
  // idea pays its nominator IDEA_SELECTED_TICKETS once (Tickets ref idea:<id>).
  IDEAS: ['idea_id', 'title', 'details', 'nominator_id', 'nominator_name', 'status', 'voters', 'created_ts',
    'decided_ts', 'decided_by', 'decision_note', 'pod_id', 'paid_tickets']
};

/**
 * Default configuration. Keys are written into the Config tab by setupSpreadsheet()
 * with these values and the notes shown to whoever opens the sheet.
 */
var CONFIG_DEFAULTS = {
  // ---- Slack wiring -------------------------------------------------------
  SLACK_BOT_TOKEN: { value: '', notes: 'xoxb-… Bot User OAuth Token from the Slack app\'s OAuth & Permissions page. Required.' },
  URL_SECRET: { value: '', notes: 'Random string appended to the Request URLs as ?k=…  Apps Script cannot read HTTP headers, so this is the primary shared secret. Required.' },
  SLACK_VERIFICATION_TOKEN: { value: '', notes: 'Legacy verification token (Basic Information → App Credentials). Optional second factor; checked when set.' },
  SLACK_SIGNING_SECRET: { value: '', notes: 'Only used in proxy mode, where a front proxy forwards X-Slack-Signature as a form field. Leave blank for direct Apps Script deployments.' },
  ALLOWED_TEAM_ID: { value: '', notes: 'Your Slack workspace ID (Txxxxxxxx). Requests from any other workspace are rejected. Strongly recommended.' },
  ANNOUNCE_CHANNEL: { value: '#kudos', notes: 'Channel where public tailwag announcements, weekly digests and raffle draws are posted. The bot must be a member.' },

  // ---- Allowance ----------------------------------------------------------
  ALLOWANCE_PERIOD: { value: 'week', notes: 'How often everyone\'s tailwags refill: "week" or "day". HeyTaco refills daily; weekly makes each tailwag scarcer. Change it any time — balances roll over to the new cadence on their own.' },
  ALLOWANCE_PEER: { value: 5, notes: 'Tailwags each non-manager gets per period.' },
  ALLOWANCE_MANAGER: { value: 5, notes: 'Tailwags each manager gets per period, from the separate manager pool.' },
  MAX_PER_RECIPIENT_PER_PERIOD: { value: 5, notes: 'Most tailwags one person may give the same person within a period. 0 = no cap. At 5 with a 5-per-week allowance, someone may spend a whole week on one person.' },
  CARRY_OVER_UNUSED: { value: false, notes: 'FALSE = unused tailwags expire at the reset (recommended). TRUE = they roll forward.' },
  WEEK_START_DAY: { value: 'MONDAY', notes: 'Day the weekly allowance resets. Ignored when ALLOWANCE_PERIOD is "day".' },
  TIMEZONE: { value: 'America/Denver', notes: 'Timezone used for day, week and month boundaries.' },
  DM_RECIPIENT: { value: true, notes: 'TRUE sends the recipient a direct message when they get a tailwag, so it lands even if they miss the channel.' },
  DM_GIVER_RECEIPT: { value: false, notes: 'TRUE also DMs the giver a receipt. Usually noise — the ephemeral reply already confirms it.' },
  STREAKS_ENABLED: { value: true, notes: 'TRUE tracks how many periods in a row someone has given at least one tailwag.' },

  // ---- Giving rules -------------------------------------------------------
  MIN_REASON_CHARS: { value: 6, notes: 'Minimum length of the reason text. Low enough for "doggos!", high enough to rule out "ty".' },
  ALLOW_SELF_KUDOS: { value: false, notes: 'FALSE blocks giving tailwags to yourself.' },
  ALLOW_BOT_RECIPIENTS: { value: false, notes: 'FALSE blocks giving tailwags to bots and apps.' },
  MAX_RECIPIENTS_PER_MESSAGE: { value: 5, notes: 'Most people who can be tagged in one /wag command.' },
  ALLOW_EMOJI_GIVING: { value: true, notes: 'TRUE lets people give a tailwag by putting the trigger emoji in a normal message alongside an @mention.' },
  UNIT_SINGULAR: { value: 'tailwag', notes: 'What one unit of recognition is called, singular — "1 tailwag". Change it here and every message follows.' },
  UNIT_PLURAL: { value: 'tailwags', notes: 'The plural of UNIT_SINGULAR — "3 tailwags".' },
  EMOJI_TRIGGER: { value: 'jackson', notes: 'Emoji name (no colons) that gives a tailwag when used in a message with an @mention.' },
  ALLOW_REACTION_GIVING: { value: true, notes: 'TRUE gives the author a tailwag when someone adds the trigger emoji as a reaction to their message. The message itself becomes the reason.' },
  REQUIRE_ROSTER: { value: false, notes: 'TRUE means only people listed on the Roster tab may give or receive. FALSE auto-enrolls anyone who participates.' },

  // ---- Company values -----------------------------------------------------
  VALUES_ENABLED: { value: true, notes: 'TRUE lets people tag a tailwag with the company value it reflects, e.g. /wag @sam #real-world …' },
  VALUE_REQUIRED: { value: false, notes: 'TRUE refuses a tailwag that carries no value tag. Start FALSE; turn it on once the habit sticks.' },
  VALUE_TAGS: { value: 'exceptional-care,understand,bigger-lives,real-world,collaborate', notes: 'Short tags people type after #. Keep them lowercase and hyphenated.' },
  VALUE_LABELS: { value: 'Exceptional Clinical Care,Understand Don\'t Judge,Build Bigger Lives,Make It Work in the Real World,Collaborate & Be Transparent', notes: 'Full value names, in the same order as VALUE_TAGS.' },
  VALUE_EMOJI: { value: ':dart:,:heart:,:seedling:,:house:,:handshake:', notes: 'Emoji per value, in the same order as VALUE_TAGS.' },

  // ---- Recognition --------------------------------------------------------
  BADGE_THRESHOLDS: { value: '10,25,50,100,250', notes: 'Lifetime tailwags RECEIVED at which a badge is awarded.' },
  BADGE_LABELS: { value: 'Pilot Light,Steady Reinforcer,Dense Schedule,Behavioral Momentum,Living Legend', notes: 'Badge names, in the same order as BADGE_THRESHOLDS.' },
  BADGE_EMOJI: { value: ':jackson:,:fire:,:zap:,:rocket:,:trophy:', notes: 'Badge emoji, in the same order as BADGE_THRESHOLDS.' },
  GIVER_BADGE_THRESHOLDS: { value: '25,100,250', notes: 'Lifetime tailwags GIVEN at which a generosity badge is awarded.' },
  GIVER_BADGE_LABELS: { value: 'Noticer,Tailwag Dispenser,Chief Reinforcement Officer', notes: 'Generosity badge names, in order.' },
  GIVER_BADGE_EMOJI: { value: ':eyes:,:handshake:,:star2:', notes: 'Generosity badge emoji, in order.' },

  // ---- Raffle -------------------------------------------------------------
  RAFFLE_ENABLED: { value: true, notes: 'TRUE runs the legacy automatic monthly drawing where every tailwag received is one entry. setupRewards() turns this off — reward pods replace it.' },
  RAFFLE_MAX_ENTRIES_PER_PERSON: { value: 0, notes: 'Cap on entries per person per month so one runaway winner cannot own the drum. 0 = uncapped.' },
  RAFFLE_MIN_ENTRIES_TO_DRAW: { value: 5, notes: 'Skip the drawing if the month had fewer entries than this.' },
  RAFFLE_WINNERS_PER_DRAW: { value: 1, notes: 'How many names to pull each month.' },
  RAFFLE_EXCLUDE_LAST_WINNER: { value: true, notes: 'TRUE keeps last month\'s winner out of this month\'s drum.' },
  RAFFLE_PRIZE: { value: '$50 gift card of your choosing', notes: 'Described in the announcement post. Change it whenever.' },

  // ---- Rewards (ticket pods) ---------------------------------------------
  REWARDS_ENABLED: { value: false, notes: 'TRUE turns on rewards: tailwags earn tickets, and people enter their tickets into the reward pods of their choice. setupRewards() switches it on; nothing is credited before then.' },
  REWARDS_LAUNCH_TS: { value: '', notes: 'ISO timestamp. Only tailwags given on or after this moment earn tickets. setupRewards() stamps it once — the fresh start at launch.' },
  REWARDS_ACCRUAL_CURSOR: { value: '', notes: 'Maintained automatically: row|id of the last Ledger row already turned into tickets. Leave it alone.' },
  TICKETS_PER_WAG_RECEIVED: { value: 1, notes: 'Tickets earned for each tailwag you RECEIVE. Changes apply going forward — tickets already credited keep the rate they were earned at.' },
  TICKETS_PER_WAG_GIVEN: { value: 0, notes: 'Tickets earned for each tailwag you GIVE (admin grants excluded). 0 = giving earns nothing. Try 0.5 or 1 to reward generosity.' },
  REWARDS_PORTAL_URL: { value: '', notes: 'Where people open the rewards site — the Google Site page, or the portal web app /exec URL. Linked from /wags, App Home and every pod announcement.' },
  REWARDS_ADMIN_EMAILS: { value: '', notes: 'Comma-separated Google emails allowed to run the portal Admin tab, in addition to anyone in ADMIN_USER_IDS.' },
  REWARDS_ANNOUNCE_PODS: { value: true, notes: 'TRUE posts to ANNOUNCE_CHANNEL when a pod opens, 24 hours before it closes, and when it is drawn.' },
  REWARDS_DM_WINNERS: { value: true, notes: 'TRUE sends each winner a direct message as well as the channel post.' },
  REWARDS_EXCLUDE_RECENT_WINNERS_DAYS: { value: 0, notes: 'Keep anyone who won a pod in the last N days out of new draws (their tickets are refunded). 0 = no exclusion.' },
  SLACK_APP_URL: { value: '', notes: 'The Slack project\'s web app /exec URL (no ?k=). The rewards portal pings it after changing a setting so Slack stops showing the cached old value.' },
  IDEAS_ENABLED: { value: true, notes: 'TRUE shows the Ideas tab on the rewards site, where staff nominate rewards and upvote each other\'s.' },
  IDEA_SELECTED_TICKETS: { value: 20, notes: 'Tickets paid to the nominator when an admin selects their reward idea. Paid once per idea.' },
  IDEA_MAX_OPEN_PER_PERSON: { value: 5, notes: 'Most ideas one person can have waiting for a decision at once. 0 = no limit.' },
  REWARDS_JOB_SCRIPT_ID: { value: '', notes: 'Set by installRewardsTriggers(). Only the Apps Script project with this id runs scheduled draws, so two projects sharing the sheet can never draw the same pod twice.' },

  // ---- Scheduled posts ----------------------------------------------------
  WEEKLY_DIGEST_ENABLED: { value: true, notes: 'TRUE posts last week\'s leaderboard and value breakdown every Monday morning.' },
  DIGEST_HOUR: { value: 9, notes: 'Hour of the day (0-23, in TIMEZONE) for the Monday digest and the monthly raffle draw.' },
  LEADERBOARD_SIZE: { value: 10, notes: 'How many people appear on a leaderboard.' },
  ANNOUNCE_IN_SOURCE_CHANNEL: { value: true, notes: 'TRUE announces a tailwag in the channel where it was given. FALSE sends every announcement to ANNOUNCE_CHANNEL instead.' },
  MIRROR_TO_ANNOUNCE_CHANNEL: { value: false, notes: 'TRUE also copies every tailwag into ANNOUNCE_CHANNEL, giving one feed of all recognition. Can get noisy.' },

  // ---- Administration -----------------------------------------------------
  ADMIN_USER_IDS: { value: '', notes: 'Comma-separated Slack user IDs allowed to run /wag-admin. Leave blank to allow Slack workspace admins only via explicit listing.' },
  MANAGER_USER_IDS: { value: '', notes: 'Comma-separated Slack user IDs that draw from the manager pool. Also settable per-row on the Roster tab.' },
  RESPONSE_DEADLINE_MS: { value: 1200, notes: 'How many milliseconds of our own work may pass before the answer is sent to response_url instead of being returned. Slack allows three seconds end to end and about a second of that is Apps Script overhead we cannot see, so this is deliberately well under 3000. Set it to 0 to send every answer that way.' },
  KEEP_CACHES_WARM: { value: true, notes: 'TRUE runs a tiny job every WARM_INTERVAL_MIN minutes that re-reads the sheet into the cache, so a slash command never pays for a cold read out of Slack\'s three seconds. Re-run installTriggers() after changing this.' },
  WARM_INTERVAL_MIN: { value: 15, notes: 'How often the cache warmer runs. Apps Script allows 1, 5, 10, 15 or 30; anything else snaps to the nearest. Re-run installTriggers() after changing this.' },
  PAUSED: { value: false, notes: 'TRUE puts the whole app in read-only mode: balances and leaderboards still work, giving is refused.' },
  LOG_LEVEL: { value: 'INFO', notes: 'DEBUG, INFO, WARN or ERROR. Controls what lands on the Events tab.' }
};

/** Cache of the parsed Config tab for the life of one execution. */
var __configCache = null;

/**
 * Returns the whole config as a plain object of raw string values, merged over
 * the defaults. Cached per execution and in CacheService for CACHE_TTL.CONFIG.
 * Every writer drops the cache, so a long TTL never serves a stale value — and a
 * cold read costs a full spreadsheet open, which on a quiet day was happening on
 * almost every command and eating Slack's three-second budget.
 */
function getConfigAll_() {
  if (__configCache) return __configCache;

  var merged = {};
  for (var k in CONFIG_DEFAULTS) merged[k] = CONFIG_DEFAULTS[k].value;

  var cached = cacheGet_('config');
  if (cached) {
    for (var ck in cached) merged[ck] = cached[ck];
    __configCache = merged;
    return merged;
  }

  var rows = readSheet_(SHEETS.CONFIG);
  var fromSheet = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i].key || '').trim();
    if (!key) continue;
    fromSheet[key] = rows[i].value;
    merged[key] = rows[i].value;
  }
  cachePut_('config', fromSheet, CACHE_TTL.CONFIG);
  __configCache = merged;
  return merged;
}

/** Raw config value for a key. */
function cfg_(key) {
  var all = getConfigAll_();
  return all.hasOwnProperty(key) ? all[key] : (CONFIG_DEFAULTS[key] ? CONFIG_DEFAULTS[key].value : undefined);
}

/** Config value as a trimmed string. */
function cfgStr_(key) {
  var v = cfg_(key);
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Config value as a number, falling back to the default when unparseable. */
function cfgNum_(key) {
  var v = cfg_(key);
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  if (isNaN(n)) {
    var d = CONFIG_DEFAULTS[key] ? CONFIG_DEFAULTS[key].value : 0;
    return typeof d === 'number' ? d : 0;
  }
  return n;
}

/**
 * Config value as a boolean. Accepts real booleans plus the many things a human
 * types into a spreadsheet cell: TRUE/true/yes/y/1/on.
 */
function cfgBool_(key) {
  var v = cfg_(key);
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toLowerCase();
  if (s === '') {
    var d = CONFIG_DEFAULTS[key] ? CONFIG_DEFAULTS[key].value : false;
    return d === true;
  }
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'on';
}

/** Config value as an array of trimmed, non-empty strings split on commas. */
function cfgList_(key) {
  var s = cfgStr_(key);
  if (!s) return [];
  return s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 0; });
}

/** Config value as an array of numbers. */
function cfgNumList_(key) {
  return cfgList_(key).map(function (x) { return parseInt(x, 10); })
    .filter(function (n) { return !isNaN(n); });
}

/** Writes a config key back to the sheet and busts the cache. */
function setConfig_(key, value) {
  var sh = sheet_(SHEETS.CONFIG);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setValue(value);
      cacheDrop_('config');
      __configCache = null;
      return true;
    }
  }
  sh.appendRow([key, value, '']);
  cacheDrop_('config');
  __configCache = null;
  return true;
}

/**
 * Badge definitions built from config, for a given track.
 * @param {string} track 'receiver' or 'giver'
 * @return {Array<{threshold:number,label:string,emoji:string,key:string,track:string}>}
 */
function badgeLadder_(track) {
  var isGiver = track === 'giver';
  var thresholds = cfgNumList_(isGiver ? 'GIVER_BADGE_THRESHOLDS' : 'BADGE_THRESHOLDS');
  var labels = cfgList_(isGiver ? 'GIVER_BADGE_LABELS' : 'BADGE_LABELS');
  var emoji = cfgList_(isGiver ? 'GIVER_BADGE_EMOJI' : 'BADGE_EMOJI');
  var out = [];
  for (var i = 0; i < thresholds.length; i++) {
    out.push({
      track: isGiver ? 'giver' : 'receiver',
      threshold: thresholds[i],
      label: labels[i] || (thresholds[i] + ' ' + wagWord_(thresholds[i])),
      emoji: emoji[i] || ':jackson:',
      key: (isGiver ? 'give_' : 'recv_') + thresholds[i]
    });
  }
  out.sort(function (a, b) { return a.threshold - b.threshold; });
  return out;
}

/**
 * The company values people can tag a tailwag with.
 * @return {Array<{tag:string,label:string,emoji:string}>}
 */
function valueList_() {
  if (!cfgBool_('VALUES_ENABLED')) return [];
  var tags = cfgList_('VALUE_TAGS');
  var labels = cfgList_('VALUE_LABELS');
  var emoji = cfgList_('VALUE_EMOJI');
  return tags.map(function (t, i) {
    return {
      tag: String(t).toLowerCase(),
      label: labels[i] || t,
      emoji: emoji[i] || ':small_blue_diamond:'
    };
  });
}

/**
 * Resolves user input to a value, accepting the exact tag, a unique prefix, or a
 * word from the label. Returns null when nothing matches unambiguously.
 * @param {string} input
 */
function resolveValue_(input) {
  var q = String(input || '').toLowerCase().replace(/^#/, '').trim();
  if (!q) return null;
  var values = valueList_();
  var exact = values.filter(function (v) { return v.tag === q; });
  if (exact.length === 1) return exact[0];
  var prefix = values.filter(function (v) { return v.tag.indexOf(q) === 0; });
  if (prefix.length === 1) return prefix[0];
  var inLabel = values.filter(function (v) {
    return v.label.toLowerCase().indexOf(q) !== -1 || v.tag.indexOf(q) !== -1;
  });
  if (inLabel.length === 1) return inLabel[0];
  return null;
}
