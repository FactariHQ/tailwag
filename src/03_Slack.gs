/**
 * Tail Wag — 03_Slack.gs
 * Slack Web API client, response envelopes and Block Kit builders.
 */

var SLACK_API = 'https://slack.com/api/';

/**
 * Calls a Slack Web API method with the bot token.
 * @param {string} method e.g. 'chat.postMessage'
 * @param {Object} payload
 * @param {boolean=} muteErrors don't log failures (used by best-effort calls)
 * @return {Object} parsed response, or {ok:false,error:...}
 */
function slackApi_(method, payload, muteErrors) {
  var token = cfgStr_('SLACK_BOT_TOKEN');
  if (!token) {
    if (!muteErrors) logError_('slack.no_token', '', method);
    return { ok: false, error: 'missing_bot_token' };
  }
  try {
    var res = UrlFetchApp.fetch(SLACK_API + method, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok && !muteErrors) {
      logWarn_('slack.api_error', method, { error: body.error, payload: truncate_(JSON.stringify(payload), 800) });
    }
    return body;
  } catch (e) {
    if (!muteErrors) logError_('slack.api_exception', method, String(e));
    return { ok: false, error: String(e) };
  }
}

/**
 * Fires several Slack Web API calls in parallel. Apps Script runs synchronously,
 * so on a path with a three-second budget this is the difference between one
 * round trip and five.
 * @param {Array<{method:string, payload:Object}>} calls
 * @return {Array<Object>} parsed responses, index-aligned with calls
 */
function slackApiAll_(calls) {
  var token = cfgStr_('SLACK_BOT_TOKEN');
  if (!token || !calls.length) return calls.map(function () { return { ok: false, error: 'missing_bot_token' }; });
  var requests = calls.map(function (c) {
    return {
      url: SLACK_API + c.method,
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(c.payload || {}),
      muteHttpExceptions: true
    };
  });
  try {
    return UrlFetchApp.fetchAll(requests).map(function (res) {
      try { return JSON.parse(res.getContentText() || '{}'); } catch (e) { return { ok: false, error: 'bad_json' }; }
    });
  } catch (e) {
    logWarn_('slack.fetchall_failed', '', String(e));
    return calls.map(function () { return { ok: false, error: String(e) }; });
  }
}

/** GET-style Slack Web API call with query parameters. */
function slackApiGet_(method, params, muteErrors) {
  var token = cfgStr_('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'missing_bot_token' };
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  try {
    var res = UrlFetchApp.fetch(SLACK_API + method + (qs ? '?' + qs : ''), {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok && !muteErrors) logWarn_('slack.api_error', method, body.error);
    return body;
  } catch (e) {
    if (!muteErrors) logError_('slack.api_exception', method, String(e));
    return { ok: false, error: String(e) };
  }
}

/** Posts a message to a channel. Returns the API response. */
function postMessage_(channel, text, blocks, threadTs) {
  var payload = { channel: channel, text: text };
  if (blocks) payload.blocks = blocks;
  if (threadTs) payload.thread_ts = threadTs;
  payload.unfurl_links = false;
  payload.unfurl_media = false;
  return slackApi_('chat.postMessage', payload);
}

/** Posts a message only the given user can see, inside a channel. */
function postEphemeral_(channel, user, text, blocks) {
  var payload = { channel: channel, user: user, text: text };
  if (blocks) payload.blocks = blocks;
  return slackApi_('chat.postEphemeral', payload, true);
}

/**
 * Sends an already-serialized response body to a slash command's response_url.
 * Used when the HTTP response is likely to arrive after Slack has stopped
 * listening: the same JSON that would have been returned is posted here instead,
 * and Slack shows it in the same place. Valid for thirty minutes after the
 * command, so this is a genuine second chance rather than a best effort.
 * @param {string} url response_url from the slash command payload
 * @param {string} bodyJson the response body, already JSON
 * @return {boolean} true when Slack accepted it
 */
function postToResponseUrl_(url, bodyJson) {
  if (!url || !bodyJson) return false;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: bodyJson,
      muteHttpExceptions: true
    });
    return res.getResponseCode() < 300;
  } catch (e) {
    logWarn_('response_url.failed', '', String(e));
    return false;
  }
}

/** Sends a delayed response to a slash command's response_url. */
function respondLater_(responseUrl, body) {
  if (!responseUrl) return { ok: false, error: 'no_response_url' };
  try {
    UrlFetchApp.fetch(responseUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    return { ok: true };
  } catch (e) {
    logWarn_('slack.response_url_failed', '', String(e));
    return { ok: false, error: String(e) };
  }
}

/** Looks up a user's profile, cached for a day. */
function fetchUserProfile_(userId) {
  var cached = cacheGet_('user.' + userId);
  if (cached) return cached;
  var res = slackApiGet_('users.info', { user: userId }, true);
  if (!res.ok || !res.user) return null;
  var u = res.user;
  var profile = {
    user_id: u.id,
    display_name: (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name,
    real_name: (u.profile && u.profile.real_name) || u.real_name || '',
    email: (u.profile && u.profile.email) || '',
    is_bot: !!u.is_bot,
    deleted: !!u.deleted,
    tz: u.tz || ''
  };
  cachePut_('user.' + userId, profile, CACHE_TTL.PROFILE);
  return profile;
}

/**
 * Warms the profile cache for several users in one parallel batch.
 *
 * Without this, a /wag naming five people costs five sequential users.info
 * round trips before any work starts — most of the three-second budget spent
 * waiting, with the script lock held the whole time.
 */
function prefetchProfiles_(userIds) {
  var missing = [];
  (userIds || []).forEach(function (id) {
    if (!id) return;
    if (cacheGet_('user.' + id)) return;
    if (missing.indexOf(id) === -1) missing.push(id);
  });
  if (missing.length < 2) return;   // one lookup is not worth batching

  var token = cfgStr_('SLACK_BOT_TOKEN');
  if (!token) return;
  var requests = missing.map(function (id) {
    return {
      url: SLACK_API + 'users.info?user=' + encodeURIComponent(id),
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    };
  });
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return;   // fall back to lazy per-user lookups
  }
  responses.forEach(function (res, i) {
    var body;
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { return; }
    if (!body.ok || !body.user) return;
    var u = body.user;
    cachePut_('user.' + missing[i], {
      user_id: u.id,
      display_name: (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name,
      real_name: (u.profile && u.profile.real_name) || '',
      email: (u.profile && u.profile.email) || '',
      is_bot: !!u.is_bot,
      deleted: !!u.deleted,
      tz: u.tz || ''
    }, 86400);
  });
}

/** Best-effort display name, falling back to the mention markup. */
function displayName_(userId) {
  var roster = getRoster_()[userId];
  if (roster && roster.display_name) return String(roster.display_name);
  var p = fetchUserProfile_(userId);
  return p ? p.display_name : userId;
}

/** Resolves a channel name like "#kudos" to an id the bot can post to. */
function resolveChannel_(nameOrId) {
  var raw = String(nameOrId || '').trim();
  if (!raw) return '';
  if (/^[CGD][A-Z0-9]{5,}$/.test(raw)) return raw;
  var clean = raw.replace(/^#/, '').toLowerCase();
  var cached = cacheGet_('channel.' + clean);
  if (cached) return cached;

  var cursor = '';
  for (var page = 0; page < 40; page++) {
    var res = slackApiGet_('conversations.list', {
      limit: 200,
      exclude_archived: true,
      types: 'public_channel,private_channel',
      cursor: cursor
    }, true);
    if (!res.ok || !res.channels) break;
    for (var i = 0; i < res.channels.length; i++) {
      if (String(res.channels[i].name).toLowerCase() === clean) {
        cachePut_('channel.' + clean, res.channels[i].id, CACHE_TTL.CHANNEL);
        return res.channels[i].id;
      }
    }
    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  // Fall back to the raw name — chat.postMessage accepts "#channel" for public channels.
  return raw.charAt(0) === '#' ? raw : '#' + clean;
}

// ---------------------------------------------------------------------------
// HTTP response envelopes
// ---------------------------------------------------------------------------

/** A JSON body for Slack. */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** An empty 200, which Slack treats as "handled, say nothing". */
function emptyOut_() {
  return ContentService.createTextOutput('');
}

/** Plain text body. */
function textOut_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

/** An ephemeral slash-command reply. */
function ephemeral_(text, blocks) {
  var body = { response_type: 'ephemeral', text: text };
  if (blocks) body.blocks = blocks;
  return jsonOut_(body);
}

/** A slash-command reply everyone in the channel sees. */
function inChannel_(text, blocks) {
  var body = { response_type: 'in_channel', text: text };
  if (blocks) body.blocks = blocks;
  return jsonOut_(body);
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

function sectionBlock_(mrkdwn) {
  return { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } };
}

function contextBlock_(mrkdwn) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn }] };
}

function dividerBlock_() {
  return { type: 'divider' };
}

function headerBlock_(text) {
  return { type: 'header', text: { type: 'plain_text', text: truncate_(text, 150), emoji: true } };
}

function fieldsBlock_(pairs) {
  return {
    type: 'section',
    fields: pairs.map(function (p) {
      return { type: 'mrkdwn', text: '*' + p[0] + '*\n' + p[1] };
    })
  };
}

function actionsBlock_(elements) {
  return { type: 'actions', elements: elements };
}

function buttonElement_(text, actionId, value, style) {
  var b = {
    type: 'button',
    text: { type: 'plain_text', text: text, emoji: true },
    action_id: actionId,
    value: value || 'x'
  };
  if (style) b.style = style;
  return b;
}
