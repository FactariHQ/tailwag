/**
 * Tail Wag — reward ideas tests (kept separate from run.js so each file stays small).
 * Run with: node test/ideas.js  (npm test runs both)
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

// ===========================================================================
suite('Rewards — reward ideas');
// ===========================================================================

function ideaRows(env) { return env.sheetRows('Ideas'); }

test('staff nominate an idea; it shows on everyone\'s Ideas tab', () => {
  const env = rewardsEnv();
  const r = env.call('submitIdea_', 'U08SAM01', 'sam', '  A   Friday off  ', 'Any Friday in the next quarter');
  assert(r.ok, JSON.stringify(r));
  const rows = ideaRows(env);
  eq(rows.length, 1);
  eq(String(rows[0].title), 'A Friday off', 'whitespace is tidied');
  eq(String(rows[0].status), 'open');
  env.setActiveUser('dana@actaba.com');
  const st = env.call('portalLoad');
  eq(st.rules.ideasEnabled, true);
  eq(st.rules.ideaTickets, 20, 'the default payout is 20 tickets');
  eq(st.ideas.length, 1);
  eq(st.ideas[0].nominator, 'sam');
  eq(st.ideas[0].mine, false);
  eq(st.ideas[0].voter_names, undefined, 'staff do not see who voted');
});

test('ideas are validated, de-duplicated and capped per person', () => {
  const env = rewardsEnv({ IDEA_MAX_OPEN_PER_PERSON: 2 });
  eq(env.call('submitIdea_', 'U08SAM01', 'sam', 'no', '').ok, false, 'too short');
  eq(env.call('submitIdea_', 'U08SAM01', 'sam', 'x'.repeat(81), '').ok, false, 'too long');
  eq(env.call('submitIdea_', 'U08SAM01', 'sam', 'Pizza lunch', 'y'.repeat(601)).ok, false, 'details too long');
  assert(env.call('submitIdea_', 'U08SAM01', 'sam', 'Pizza lunch', '').ok);
  const dupe = env.call('submitIdea_', 'U08DANA1', 'dana', 'pizza  LUNCH!', '');
  eq(dupe.ok, false); includes(dupe.error, 'give it an upvote instead');
  assert(env.call('submitIdea_', 'U08SAM01', 'sam', 'Coffee cart visit', '').ok);
  const third = env.call('submitIdea_', 'U08SAM01', 'sam', 'Team bowling night', '');
  eq(third.ok, false); includes(third.error, '2 ideas waiting');
});

test('upvotes toggle, cannot be cast on your own idea, and sort the board', () => {
  const env = rewardsEnv();
  const a = env.call('submitIdea_', 'U08SAM01', 'sam', 'Pizza lunch', '').idea_id;
  const b = env.call('submitIdea_', 'U08SAM01', 'sam', 'Extra PTO day', '').idea_id;
  eq(env.call('toggleIdeaVote_', 'U08SAM01', a).ok, false, 'no self-votes');
  let r = env.call('toggleIdeaVote_', 'U08DANA1', b);
  eq(r.voted, true); eq(r.votes, 1);
  env.call('toggleIdeaVote_', 'U08LEE01', b);
  r = env.call('toggleIdeaVote_', 'U08LEE01', b);
  eq(r.voted, false, 'a second click takes the vote back'); eq(r.votes, 1);
  env.setActiveUser('dana@actaba.com');
  const st = env.call('portalLoad');
  eq(st.ideas[0].idea_id, b, 'most upvoted first');
  eq(st.ideas[0].voted, true);
  eq(st.ideas[1].voted, false);
});

test('picking an idea pays the nominator exactly once and is final', () => {
  const env = rewardsEnv();
  const id = env.call('submitIdea_', 'U08SAM01', 'sam', 'Lunch with the CEO', '').idea_id;
  env.clearFetches();
  const r = env.call('decideIdea_', id, 'selected', 'josh@actaba.com');
  assert(r.ok, JSON.stringify(r));
  eq(r.paid, 20);
  const w = wallet(env, 'U08SAM01');
  eq(w.available, 20); eq(w.ideas, 20); eq(w.spendable, 20);
  const tk = env.sheetRows('Tickets').filter((t) => String(t.kind) === 'idea');
  eq(tk.length, 1); eq(String(tk[0].ref), 'idea:' + id);
  eq(env.call('decideIdea_', id, 'selected', 'josh@actaba.com').ok, false, 'no second payout');
  eq(env.call('decideIdea_', id, 'declined', 'josh@actaba.com').ok, false, 'selection is final');
  eq(env.call('decideIdea_', id, 'open', 'josh@actaba.com').ok, false);
  eq(wallet(env, 'U08SAM01').available, 20);
  const post = env.fetchesTo('chat.postMessage').find((f) => f.payload.channel === 'C_KUDOS');
  assert(post, 'the pick is announced');
  includes(JSON.stringify(post.payload.blocks), '=========================================================');
  includes(JSON.stringify(post.payload.blocks), '20 tickets');
  assert(env.fetchesTo('chat.postMessage').some((f) => f.payload.channel === 'U08SAM01'), 'the nominator is DMed');
  env.setActiveUser('sam@actaba.com');
  const hist = env.call('portalLoad').history;
  eq(hist[0].kind, 'idea');
});

test('the payout follows IDEA_SELECTED_TICKETS and a paid ref is never paid again', () => {
  const env = rewardsEnv({ IDEA_SELECTED_TICKETS: 35 });
  const id = env.call('submitIdea_', 'U08DANA1', 'dana', 'Spa voucher', '').idea_id;
  // Someone reopens the row by hand after it was paid.
  env.call('decideIdea_', id, 'selected', 'a');
  const sh = env.state.spreadsheet.getSheetByName('Ideas');
  const head = sh.getDataRange().getValues()[0].map(String);
  sh.getRange(2, head.indexOf('status') + 1, 1, 1).setValues([['open']]);
  env.run('rewardsCacheDrop_()');
  env.call('decideIdea_', id, 'selected', 'a');
  eq(wallet(env, 'U08DANA1').available, 35, 'the Tickets ref guards the payout, not just the status');
});

test('declining, reopening and withdrawing', () => {
  const env = rewardsEnv();
  const id = env.call('submitIdea_', 'U08SAM01', 'sam', 'Ice cream truck', '').idea_id;
  let r = env.call('decideIdea_', id, 'declined', 'josh', { note: 'Not in winter' });
  assert(r.ok);
  eq(env.call('toggleIdeaVote_', 'U08DANA1', id).ok, false, 'no voting on a declined idea');
  eq(wallet(env, 'U08SAM01').available, 0, 'declining pays nothing');
  env.setActiveUser('sam@actaba.com');
  eq(env.call('portalLoad').ideas[0].decision_note, 'Not in winter');
  assert(env.call('decideIdea_', id, 'open', 'josh').ok, 'an admin can reopen');
  eq(env.call('withdrawIdea_', 'U08DANA1', id).ok, false, 'only the nominator can withdraw');
  assert(env.call('withdrawIdea_', 'U08SAM01', id).ok);
  eq(env.call('decideIdea_', id, 'selected', 'josh').ok, false, 'a withdrawn idea cannot be picked');
  env.setActiveUser('dana@actaba.com');
  eq(env.call('portalLoad').ideas.length, 0, 'others no longer see a withdrawn idea');
  env.setActiveUser('sam@actaba.com');
  eq(env.call('portalLoad').ideas.length, 1, 'the nominator still sees it');
});

test('turning an idea into a reward creates the pod, picks the idea and links them', () => {
  const env = rewardsEnv();
  const id = env.call('submitIdea_', 'U08SAM01', 'sam', 'Extra PTO day', 'A Friday').idea_id;
  env.setActiveUser('josh@actaba.com');
  const now = env.state.nowValue.getTime();
  const r = env.call('portalAdminSavePod', { title: 'Extra PTO day', closes_ts: new Date(now + 3 * 86400000).toISOString(), publish: true, from_idea: id });
  assert(r.ok, JSON.stringify(r));
  includes(r.message, 'earned 20 tickets');
  const idea = r.admin && env.call('ideaById_', id);
  eq(idea.status, 'selected');
  eq(idea.pod_id, r.pod_id);
  eq(wallet(env, 'U08SAM01').available, 20);
  eq(r.admin.totals.ideas, 20);
  env.setActiveUser('sam@actaba.com');
  const st = env.call('portalLoad');
  eq(st.ideas[0].pod_title, 'Extra PTO day');
  eq(st.ideas[0].pod_phase, 'open');
});

test('idea actions go through the signed-in person and admin checks', () => {
  const env = rewardsEnv();
  env.setActiveUser('sam@actaba.com');
  const r = env.call('portalSubmitIdea', 'Pizza lunch', 'Friday please');
  assert(r.ok, JSON.stringify(r));
  eq(r.state.ideas[0].mine, true);
  const id = r.state.ideas[0].idea_id;
  let threw = '';
  try { env.call('portalAdminDecideIdea', id, 'selected', ''); } catch (e) { threw = e.message; }
  includes(threw, 'admin-only');
  env.setActiveUser('dana@actaba.com');
  const v = env.call('portalToggleIdeaVote', id);
  eq(v.state.ideas[0].votes, 1);
  env.setActiveUser('josh@actaba.com');
  const d = env.call('portalAdminDecideIdea', id, 'selected', '');
  assert(d.ok, JSON.stringify(d));
  eq(env.call('portalLoad').ideas[0].voter_names.join(','), 'dana', 'admins see who upvoted');
  // A linked-less admin email cannot nominate: there is no wallet to pay.
  const lone = rewardsEnv({ REWARDS_ADMIN_EMAILS: 'robots@actaba.com' });
  lone.setActiveUser('robots@actaba.com');
  eq(lone.call('portalSubmitIdea', 'Something great', '').ok, false);
});

test('ideas are inert in the sheet and on the Slack project', () => {
  const env = rewardsEnv();
  const r = env.call('submitIdea_', 'U08SAM01', 'sam', '=IMPORTDATA("https://evil")', '+cmd|calc');
  assert(r.ok, JSON.stringify(r));
  eq(env.formulaCells('Ideas').length, 0, 'no live formulas from staff input');
  eq(String(ideaRows(env)[0].title), '=IMPORTDATA("https://evil")', 'the text itself survives');
  env.state.scriptId = 'THE_SLACK_PROJECT';
  eq(env.call('submitIdea_', 'U08SAM01', 'sam', 'Another idea', '').ok, false);
  eq(env.call('toggleIdeaVote_', 'U08DANA1', r.idea_id).ok, false);
  eq(env.call('decideIdea_', r.idea_id, 'selected', 'x').ok, false);
});

test('the Ideas tab can be switched off, and Slack mentions it while it is on', () => {
  const env = rewardsEnv();
  includes(JSON.stringify(body(slashCommand(env, '/wags', 'rewards')).blocks), 'Nominate it on the rewards site');
  includes(JSON.stringify(env.call('buildHelpCard_', 'U08JOSH1').blocks), 'reward idea');
  env.setActiveUser('josh@actaba.com');
  env.call('portalAdminSettings', { ideasEnabled: false, ideaTickets: 25 });
  eq(env.call('cfgNum_', 'IDEA_SELECTED_TICKETS'), 25);
  const st = env.call('portalLoad');
  eq(st.rules.ideasEnabled, false); eq(st.ideas.length, 0);
  eq(env.call('submitIdea_', 'U08SAM01', 'sam', 'Pizza lunch', '').ok, false);
  assert(JSON.stringify(body(slashCommand(env, '/wags', 'rewards')).blocks).indexOf('Nominate') === -1);
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
