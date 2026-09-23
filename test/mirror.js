/**
 * Tail Wag — mirror copies never duplicate a post in the announce channel.
 * Run with: node test/mirror.js  (npm test runs every file)
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

function freshEnv(overrides = {}) {
  const env = createEnvironment({ now: new Date('2026-09-16T18:00:00Z') });
  env.setup();
  env.setConfigValue('SLACK_BOT_TOKEN', 'xoxb-test');
  env.setConfigValue('ALLOWED_TEAM_ID', 'T_TEST');
  env.setConfigValue('URL_SECRET', 'secret123');
  env.setConfigValue('ANNOUNCE_CHANNEL', '#kudos');
  Object.keys(overrides).forEach((k) => env.setConfigValue(k, overrides[k]));
  env.addUser('U08JOSH1', 'josh');
  env.addUser('U08SAM01', 'sam');
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

suite('Mirror copies');

test('mirroring copies a tailwag given elsewhere into the announcement channel', () => {
  const env = freshEnv({ MIRROR_TO_ANNOUNCE_CHANNEL: true });
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  eq(b.response_type, 'in_channel', 'announced where it was given');
  const mirrors = env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'C_KUDOS');
  eq(mirrors.length, 1, 'one mirror copy in the announcement channel');
});

test('a tailwag given inside the announcement channel is not mirrored back into it', () => {
  const env = freshEnv({ MIRROR_TO_ANNOUNCE_CHANNEL: true });
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice',
    { channel_id: 'C_KUDOS', channel_name: 'kudos' }));
  eq(b.response_type, 'in_channel', 'still announced once, inline');
  const mirrors = env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'C_KUDOS');
  eq(mirrors.length, 0, 'no second copy in the same channel');
});

test('the same-channel check matches by id, or by name when lookup fell back', () => {
  const env = freshEnv();
  eq(env.call('isSameChannel_', '#Kudos', 'C_X', 'kudos'), true);
  eq(env.call('isSameChannel_', 'C_KUDOS', 'C_KUDOS', ''), true);
  eq(env.call('isSameChannel_', 'C_KUDOS', 'C_GENERAL', 'general'), false);
  eq(env.call('isSameChannel_', '', 'C_KUDOS', 'kudos'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
