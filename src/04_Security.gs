/**
 * Tail Wag — 04_Security.gs
 * Authenticating inbound requests from Slack.
 *
 * The constraint
 * --------------
 * Google Apps Script web apps do not expose HTTP request headers to doPost().
 * Slack's documented verification scheme signs the request with an
 * `X-Slack-Signature` header, so the standard HMAC check is simply not
 * available to a direct Apps Script deployment. Pretending otherwise would be
 * security theatre, so this file is explicit about what is actually checked:
 *
 *   1. URL_SECRET  — a high-entropy value appended to the Request URL as ?k=…
 *                    Only Slack and you know the full URL; it travels over TLS
 *                    to Google and never appears in a message or a log. This is
 *                    the primary shared secret.
 *   2. team_id     — every payload carries the workspace id. Anything from
 *                    another workspace is rejected outright.
 *   3. token       — Slack's legacy per-app verification token, when set, is
 *                    compared as a second factor.
 *   4. Signature   — if you ever front the app with a proxy that copies
 *                    X-Slack-Signature and X-Slack-Request-Timestamp into form
 *                    fields (`slack_signature`, `slack_timestamp`), the real
 *                    HMAC check below runs and takes precedence over the rest.
 *
 * In practice 1 + 2 is a solid bar for an internal recognition app: an attacker
 * needs the unguessable deployment URL *and* the workspace id to forge a tailwag,
 * and every tailwag is attributed and visible in a public channel anyway.
 */

var SIG_MAX_AGE_SECONDS = 300;

/**
 * Verifies an inbound request.
 * @param {Object} e the doPost event object
 * @param {Object} payload the parsed Slack payload (slash command fields or the
 *     interactivity/events JSON)
 * @return {{ok:boolean, reason:string, method:string}}
 */
function verifyRequest_(e, payload) {
  var params = (e && e.parameter) || {};

  // --- 4. Proxy-supplied signature, when present, is authoritative. ---------
  var sig = params.slack_signature || (payload && payload.slack_signature);
  var ts = params.slack_timestamp || (payload && payload.slack_timestamp);
  if (sig && ts && cfgStr_('SLACK_SIGNING_SECRET')) {
    var rawBody = (e.postData && e.postData.contents) || '';
    var sigOk = verifySlackSignature_(cfgStr_('SLACK_SIGNING_SECRET'), ts, rawBody, sig);
    if (!sigOk.ok) return { ok: false, reason: sigOk.reason, method: 'signature' };
    return { ok: true, reason: '', method: 'signature' };
  }

  // --- 1. URL secret -------------------------------------------------------
  var wanted = cfgStr_('URL_SECRET');
  if (!wanted) {
    return { ok: false, reason: 'URL_SECRET is not set in the Config tab. Set it, then append ?k=<secret> to every Request URL in the Slack app.', method: 'url_secret' };
  }
  if (!safeEqual_(params.k || '', wanted)) {
    return { ok: false, reason: 'bad_url_secret', method: 'url_secret' };
  }

  // --- 2. Workspace allowlist ---------------------------------------------
  var allowedTeam = cfgStr_('ALLOWED_TEAM_ID');
  if (allowedTeam) {
    var teamId = payloadTeamId_(payload);
    if (teamId && !safeEqual_(teamId, allowedTeam)) {
      return { ok: false, reason: 'wrong_team:' + teamId, method: 'team' };
    }
  }

  // --- 3. Legacy verification token ---------------------------------------
  var vt = cfgStr_('SLACK_VERIFICATION_TOKEN');
  if (vt) {
    var got = (payload && payload.token) || '';
    if (!safeEqual_(got, vt)) return { ok: false, reason: 'bad_verification_token', method: 'token' };
  }

  return { ok: true, reason: '', method: 'url_secret' };
}

/** Pulls the workspace id out of any of the payload shapes Slack sends. */
function payloadTeamId_(payload) {
  if (!payload) return '';
  if (payload.team_id) return String(payload.team_id);
  if (payload.team && payload.team.id) return String(payload.team.id);
  if (payload.user && payload.user.team_id) return String(payload.user.team_id);
  return '';
}

/**
 * The real Slack HMAC check, per Slack's documented scheme:
 * basestring = 'v0:' + timestamp + ':' + raw_body, HMAC-SHA256 with the signing
 * secret, compared against 'v0=' + hex digest.
 * Used in proxy mode, and exercised directly by the test suite.
 *
 * @param {string} signingSecret
 * @param {string|number} timestamp unix seconds
 * @param {string} rawBody exact request body
 * @param {string} providedSignature the 'v0=…' value
 * @param {number=} nowSeconds override for tests
 * @return {{ok:boolean, reason:string}}
 */
function verifySlackSignature_(signingSecret, timestamp, rawBody, providedSignature, nowSeconds) {
  if (!signingSecret) return { ok: false, reason: 'no_signing_secret' };
  if (!timestamp || !providedSignature) return { ok: false, reason: 'missing_signature_fields' };

  var tsNum = parseInt(String(timestamp), 10);
  if (isNaN(tsNum)) return { ok: false, reason: 'bad_timestamp' };
  var current = nowSeconds === undefined ? Math.floor(now_().getTime() / 1000) : nowSeconds;
  if (Math.abs(current - tsNum) > SIG_MAX_AGE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  var base = 'v0:' + tsNum + ':' + rawBody;
  var bytes = Utilities.computeHmacSha256Signature(base, signingSecret);
  var hex = bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
  var expected = 'v0=' + hex;
  return safeEqual_(expected, String(providedSignature))
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'signature_mismatch' };
}

/** Generates a strong URL secret. Called by setup. */
function generateUrlSecret_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Owner-only entry points
// ---------------------------------------------------------------------------

/**
 * Refuses to continue unless the person running this is the script owner.
 *
 * Apps Script exposes every top-level function whose name does not end in an
 * underscore to google.script.run, from ANY page the web app serves. For the
 * Slack deployment that is anyone on the internet who loads the /exec URL; for
 * the rewards portal it is everyone in the Workspace. So the editor-only
 * functions (setup, triggers, demo data) check who is actually calling:
 *
 *   - run from the editor by the owner: active user === effective user
 *   - anonymous web visitor:            active user is ''            → refused
 *   - a signed-in staff member:         active user is their email   → refused
 *
 * @param {string} what the function name, for the error message
 */
function ownerOnly_(what) {
  var active = '';
  var effective = '';
  try { active = String(Session.getActiveUser().getEmail() || ''); } catch (e) { active = ''; }
  try { effective = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { effective = ''; }
  if (!effective || active.toLowerCase() !== effective.toLowerCase()) {
    throw new Error(what + ' can only be run by the script owner from the Apps Script editor.');
  }
}

/**
 * True when a scheduled function was started by one of THIS project's own
 * installable triggers. Time-driven triggers pass an event carrying the
 * trigger's unique id; a page calling the function through google.script.run
 * would have to guess it.
 * @param {Object} e the event object the function was called with
 * @param {string} handler the function name the trigger should point at
 */
function calledByOwnTrigger_(e, handler) {
  var uid = e && e.triggerUid ? String(e.triggerUid) : '';
  if (!uid) return false;
  try {
    return ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === handler && String(t.getUniqueId()) === uid;
    });
  } catch (err) {
    return false;
  }
}
