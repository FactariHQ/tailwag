/**
 * Tail Wag — 11_WebApp.gs
 * The HTTP surface: one doPost() that Slack sends everything to, and a doGet()
 * that serves either the keyed read-only leaderboard (screens, all-hands) or,
 * for a signed-in Google user, the rewards portal.
 */

/**
 * When the current request started, in epoch ms. Slack discards a slash command
 * response after three seconds, so the give path checks this before deciding
 * whether the announcement can safely ride back on the HTTP response.
 */
var __reqStarted = 0;

/**
 * Milliseconds spent on the current request so far. Returns 0 when nothing has
 * set __reqStarted (a trigger run, a function run from the editor, a test).
 */
function elapsedMs_() {
  return __reqStarted ? (new Date().getTime() - __reqStarted) : 0;
}

/**
 * True when so much of Slack's three-second budget is gone that the response is
 * likely to be thrown away.
 *
 * The number has to be well under 3000. Slack starts its clock when it sends the
 * request, and roughly a second goes to Apps Script dispatch and response
 * handling either side of this function — time doPost never sees. A request that
 * measures 900ms of its own work can still be past three seconds on the wire,
 * which is exactly how a fast answer ends up discarded with "operation_timeout".
 */
function responseLikelyTooLate_() {
  // Outside a request — a trigger, a run from the editor — there is no Slack
  // waiting and nothing to be late for.
  if (!__reqStarted) return false;
  // Setting RESPONSE_DEADLINE_MS to 0 makes every slash command answer through
  // response_url. That is the switch to reach for if Apps Script ever gets slow
  // enough that returning inline stops being worth trying.
  return elapsedMs_() >= cfgNum_('RESPONSE_DEADLINE_MS');
}

/**
 * Every inbound Slack request lands here: slash commands, interactivity
 * payloads and Events API callbacks all arrive as POSTs to the same URL.
 */
function doPost(e) {
  var started = new Date().getTime();
  __reqStarted = started;
  try {
    if (!e) return textOut_('no request');

    var raw = (e.postData && e.postData.contents) || '';
    var contentType = (e.postData && e.postData.type) || '';
    var params = e.parameter || {};
    var payload = null;
    var kind = '';

    if (params.payload) {
      // Interactivity: a JSON blob inside a form field.
      kind = 'interaction';
      payload = safeParseJson_(params.payload);
    } else if (contentType.indexOf('application/json') !== -1 || (raw && raw.charAt(0) === '{')) {
      kind = 'event';
      payload = safeParseJson_(raw);
    } else if (params.command) {
      kind = 'command';
      payload = params;
    } else {
      return textOut_('unrecognized request');
    }

    if (!payload) return textOut_('bad payload');

    // The URL verification handshake arrives before anything is wired up, and
    // Slack will not save the Request URL until it is echoed. It carries no user
    // data, so it is answered after the shared-secret check but before the rest.
    var auth = verifyRequest_(e, payload);
    if (!auth.ok) {
      logWarn_('auth.rejected', kind, { reason: auth.reason, method: auth.method });
      return textOut_('unauthorized');
    }

    if (kind === 'event' && payload.type === 'url_verification') {
      return textOut_(payload.challenge || '');
    }

    // The rewards portal is a separate Apps Script project with its own cache.
    // When it changes a setting it pings here so this project drops its cached
    // copy too, instead of showing the old value for up to six hours.
    if (kind === 'event' && payload.type === 'tailwag_cache_drop') {
      cacheDropAll_();
      __configCache = null;
      return textOut_('dropped');
    }

    var out;
    switch (kind) {
      case 'command': out = routeCommand_(payload); break;
      case 'interaction': out = handleInteraction_(payload); break;
      case 'event': out = handleEvent_(payload); break;
      default: out = textOut_('ok');
    }

    var elapsed = new Date().getTime() - started;

    // Do not gamble on the HTTP response once our share of the budget is spent.
    // response_url reaches the same place in Slack and stays valid for thirty
    // minutes, so the answer lands even when the request itself has timed out.
    // The work is already done at this point, so nothing is counted twice.
    if (kind === 'command' && payload.response_url && responseLikelyTooLate_()) {
      var late = '';
      try { late = out.getContent(); } catch (e2) { late = ''; }
      if (late && postToResponseUrl_(payload.response_url, late)) {
        logWarn_('response.late', payload.command || '', { ms: elapsed });
        return emptyOut_();
      }
    }

    if (elapsed > 2500) {
      logWarn_('slow_request', kind, { ms: elapsed, command: payload.command || payload.type || '' });
    }
    return out;
  } catch (err) {
    logError_('dopost.failed', '', String(err && err.stack || err));
    // Never leak a stack trace into Slack; say something a human can act on.
    return jsonOut_({
      response_type: 'ephemeral',
      text: 'Tail Wag hit an error handling that. Nothing was counted. If it keeps happening, ' +
        'check the Events tab of the Tail Wag sheet.'
    });
  }
}

/** Dispatches a slash command by name, so the command words can be renamed freely. */
function routeCommand_(cmd) {
  var name = String(cmd.command || '').replace(/^\//, '').toLowerCase();

  if (name === 'wag' || name === 'kudos' || name === 'tailwag') return handleWagCommand_(cmd);
  if (name === 'wags' || name === 'mywags' || name === 'leaderboard') return handleWagsCommand_(cmd);
  if (name === 'wag-admin' || name === 'tailwags-admin' || name === 'kudos-admin') return handleAdminCommand_(cmd);

  // Unknown command name — most likely a manifest edit that did not match.
  return ephemeral_('`/' + escapeSlack_(name) + '` is not wired up. Known commands: `/wag`, `/wags`, `/wag-admin`.');
}

function safeParseJson_(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// doGet — the read-only web leaderboard
// ---------------------------------------------------------------------------

/**
 * Serves the leaderboard page. Guarded by the same URL secret, so the link can
 * be pinned in a channel or left up on an office screen without exposing the
 * data to the open web.
 *
 * ?view=health returns a JSON status object instead.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};

  if (!safeEqual_(params.k || '', cfgStr_('URL_SECRET'))) {
    // No key: this is a person, not a screen. On the rewards portal deployment
    // they are signed in to Google and get their rewards; anywhere else they
    // are anonymous and get pointed at the portal.
    if (cfgBool_('REWARDS_ENABLED')) {
      if (isRewardsProject_() && activeEmail_()) return servePortal_();
      return portalSignInPage_();
    }
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e7e9ee;' +
      'display:grid;place-items:center;height:100vh;margin:0}</style>' +
      '<div><h1 style="font-size:20px">🐕 Tail Wag</h1><p>This link needs its key.</p></div>'
    ).setTitle('Tail Wag');
  }

  if (params.view === 'health') {
    return jsonOut_({
      ok: true,
      time: iso_(),
      periodKey: periodKey_(),
      monthKey: monthKey_(),
      paused: cfgBool_('PAUSED'),
      hasToken: !!cfgStr_('SLACK_BOT_TOKEN'),
      stats: globalStats_()
    });
  }

  var period = params.period === 'month' ? 'month' : params.period === 'all' ? 'all' : 'period';
  var tmpl = HtmlService.createTemplateFromFile('Leaderboard');
  tmpl.data = {
    period: period,
    periodWord: periodWord_(),
    rows: leaderboard_(period, 25),
    givers: giverLeaderboard_(5),
    stats: globalStats_(),
    feed: recentReasons_(12),
    values: valueBreakdown_(isDailyAllowance_() ? {} : { week_key: weekKey_() }),
    valuesEnabled: cfgBool_('VALUES_ENABLED'),
    raffleEnabled: cfgBool_('RAFFLE_ENABLED'),
    rafflePrize: cfgStr_('RAFFLE_PRIZE'),
    monthName: fmt_(now_(), 'MMMM'),
    updated: fmt_(now_(), 'EEE d MMM, h:mm a'),
    key: params.k
  };
  return tmpl.evaluate()
    .setTitle('Tail Wag')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
