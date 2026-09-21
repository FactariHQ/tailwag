/**
 * Tail Wag — hiding finished rewards from staff.
 * Run with: node test/hide.js  (npm test runs every file)
 */

const { createEnvironment } = require('./harness');

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) { currentSuite = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${e.message}\x1b[0m`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}
function includes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(`${msg || 'missing substring'}\n      looked for: ${needle}\n      in:         ${String(haystack).slice(0, 400)}`);
  }
}

/** A fresh, fully-configured environment with a small cast of people. */
function freshEnv(overrides = {}) {
  const env = createEnvironment({ now: new Date('2026-09-16T18:00:00Z') }); // Wed
  env.setup();
  env.setConfigValue('SLACK_BOT_TOKEN', 'xoxb-test');
  env.setConfigValue('ALLOWED_TEAM_ID', 'T_TEST');
  env.setConfigValue('URL_SECRET', 'secret123');
  env.setConfigValue('ANNOUNCE_CHANNEL', '#kudos');
  Object.keys(overrides).forEach((k) => env.setConfigValue(k, overrides[k]));
  env.addUser('U08JOSH1', 'josh');
  env.addUser('U08SAM01', 'sam');
  env.addUser('U08DANA1', 'dana');
  env.addUser('U08LEE01', 'lee');
  env.addUser('U08BOT01', 'helperbot', { is_bot: true });
  env.addUser('U08GONE1', 'leaver', { deleted: true });
  env.clearFetches();
  return env;
}

function slashCommand(env, command, text, extra = {}) {
  return env.call('routeCommand_', Object.assign({
    command, text,
    user_id: 'U08JOSH1', user_name: 'josh',
    channel_id: 'C_GENERAL', channel_name: 'general',
    team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
  }, extra));
}

function body(out) { return JSON.parse(out.getContent()); }

/** Makes this sandbox the portal build, which is what carries PORTAL_SPREADSHEET_ID. */
function asPortal(env) { env.run("var PORTAL_SPREADSHEET_ID = 'SHEET_TEST_ID';"); return env; }

function rewardsEnv(overrides = {}) {
  const env = asPortal(freshEnv(Object.assign({ ADMIN_USER_IDS: 'U08JOSH1' }, overrides)));
  env.call('syncRosterFromSlack_');
  env.call('setupRewards');
  env.setConfigValue('REWARDS_PORTAL_URL', 'https://sites.google.com/actaba.com/rewards');
  env.clearFetches();
  return env;
}
function wallet(env, id) { env.run('rewardsCacheDrop_()'); return env.call('walletFor_', id); }
function later(env, ms) { env.setNow(new Date(env.state.nowValue.getTime() + ms)); }
function makePod(env, extra = {}) {
  const now = env.state.nowValue.getTime();
  const res = env.call('savePod_', Object.assign({
    title: 'Extra PTO day', description: 'One paid day off', prize_value: '1 day PTO',
    closes_ts: new Date(now + 3 * 86400000).toISOString(), publish: true
  }, extra), 'josh@actaba.com');
  assert(res.ok, 'pod should save: ' + JSON.stringify(res));
  env.run('rewardsCacheDrop_()');
  return res.pod_id;
}
const HOUR = 3600000;
function earn(env, id, n) {
  env.call('withLock_', () => 0);
  env.run(`withLock_(function(){ accrueTickets_(); appendTicketRows_([{user_id:'${id}', name:'${id}', delta:${n}, kind:'grant', note:'test', actor:'t'}]); })`);
  env.run('rewardsCacheDrop_()');
}

// ===========================================================================
suite('Rewards — hiding finished rewards');
// ===========================================================================

function drawnPod(env) {
  const pod = makePod(env, { title: 'Threshold Reduction' });
  earn(env, 'U08SAM01', 3);
  env.call('setAllocation_', 'U08SAM01', 'sam', pod, 2);
  env.setRandom([0.1]);
  assert(env.call('drawPod_', pod, 'josh@actaba.com', true).ok);
  env.run('rewardsCacheDrop_()');
  return pod;
}

test('a hidden drawn reward leaves the staff Rewards and Winners tabs, and nothing else moves', () => {
  const env = rewardsEnv();
  const pod = drawnPod(env);
  env.setActiveUser('dana@actaba.com');
  let st = env.call('portalLoad');
  eq(st.pods.length, 1, 'recently drawn shows before hiding');
  eq(st.winners.length, 1);
  const before = wallet(env, 'U08SAM01');
  const ticketRows = env.sheetRows('Tickets').length;

  env.setActiveUser('josh@actaba.com');
  const r = env.call('portalAdminHide', pod, true);
  assert(r.ok, JSON.stringify(r));
  includes(r.message, 'hidden from staff');

  env.setActiveUser('dana@actaba.com');
  st = env.call('portalLoad');
  eq(st.pods.length, 0, 'gone from Rewards');
  eq(st.winners.length, 0, 'gone from Winners');
  env.setActiveUser('sam@actaba.com');
  st = env.call('portalLoad');
  eq(st.winners.length, 0, 'even the winner no longer sees it publicly');
  assert(st.history.some((h) => h.kind === 'enter'), 'their own ticket history is untouched');
  const after = wallet(env, 'U08SAM01');
  eq(after.available, before.available); eq(after.spent, before.spent);
  eq(env.sheetRows('Tickets').length, ticketRows, 'no ticket rows written');
  eq(env.sheetRows('Winners').length, 1, 'the winner record is kept');
});

test('admins still see a hidden reward, marked, and can show it again', () => {
  const env = rewardsEnv();
  const pod = drawnPod(env);
  env.setActiveUser('josh@actaba.com');
  const r = env.call('portalAdminHide', pod, true);
  const ap = r.admin.pods.find((p) => p.pod_id === pod);
  eq(ap.hidden, true);
  eq(r.admin.winners[0].hidden, true);
  const again = env.call('portalAdminHide', pod, true);
  includes(again.message, 'already hidden');
  const shown = env.call('portalAdminHide', pod, false);
  assert(shown.ok); includes(shown.message, 'showing to staff again');
  env.setActiveUser('dana@actaba.com');
  eq(env.call('portalLoad').winners.length, 1);
});

test('cancelled rewards can be hidden too; live and draft ones cannot', () => {
  const env = rewardsEnv();
  const live = makePod(env);
  const draft = makePod(env, { publish: false, title: 'Draft one' });
  eq(env.call('setPodHidden_', live, 'a', true).ok, false, 'a live pod must be cancelled first');
  eq(env.call('setPodHidden_', draft, 'a', true).ok, false);
  assert(env.call('cancelPod_', live, 'a', '').ok);
  assert(env.call('setPodHidden_', live, 'a', true).ok);
  eq(env.call('podById_', live).hidden_ts.length > 0, true);
});

test('a sheet that predates the hidden_ts column gets it added on first hide', () => {
  const env = rewardsEnv();
  const pod = drawnPod(env);
  // Recreate the live sheet as it was before this release: no hidden_ts header.
  const sh = env.state.spreadsheet.getSheetByName('Pods');
  const head = sh.getDataRange().getValues()[0].map(String);
  const at = head.indexOf('hidden_ts');
  assert(at !== -1);
  sh.getRange(1, at + 1, 1, 1).setValues([['']]);
  env.run("cacheDrop_('header.Pods'); rewardsCacheDrop_()");
  assert(env.call('setPodHidden_', pod, 'a', true).ok);
  env.run("cacheDrop_('header.Pods'); rewardsCacheDrop_()");
  assert(env.call('podById_', pod).hidden_ts, 'the flag landed in a real column');
  env.setActiveUser('dana@actaba.com');
  eq(env.call('portalLoad').winners.length, 0);
});

test('hiding is portal-only and admin-only', () => {
  const env = rewardsEnv();
  const pod = drawnPod(env);
  env.setActiveUser('sam@actaba.com');
  let threw = '';
  try { env.call('portalAdminHide', pod, true); } catch (e) { threw = e.message; }
  includes(threw, 'admin-only');
  env.state.scriptId = 'THE_SLACK_PROJECT';
  eq(env.call('setPodHidden_', pod, 'a', true).ok, false);
});
console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1m${passed} passed\x1b[0m, 0 failed`);
} else {
  console.log(`\x1b[32m${passed} passed\x1b[0m, \x1b[31m\x1b[1m${failed} failed\x1b[0m\n`);
  failures.forEach((f) => {
    console.log(`\x1b[31m${f.suite} › ${f.name}\x1b[0m`);
    console.log(`  ${f.error.stack.split('\n').slice(0, 4).join('\n  ')}\n`);
  });
}
process.exit(failed === 0 ? 0 : 1);
