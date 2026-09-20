/**
 * Tail Wag — 08_Events.gs
 * Events API handling: giving by typing the emoji in any channel, giving by
 * reacting with it, and the App Home.
 *
 * Retries and idempotency
 * -----------------------
 * Slack redelivers an event when it is not acknowledged within three seconds.
 * Apps Script cannot acknowledge before it has finished working, so a slow run
 * WILL be retried. Every path here therefore claims the event first — by
 * message timestamp and giver — and a claimed event is dropped on sight. The
 * cost of a dropped duplicate is nothing; the cost of a double-award is a
 * person's trust in the numbers.
 */

/**
 * Entry point for an Events API callback.
 * @param {Object} body the full event wrapper
 * @return {ContentService.TextOutput}
 */
function handleEvent_(body) {
  // URL verification handshake, sent once when the Request URL is saved.
  if (body.type === 'url_verification') {
    return textOut_(body.challenge || '');
  }
  if (body.type !== 'event_callback' || !body.event) return emptyOut_();

  var event = body.event;
  try {
    switch (event.type) {
      case 'message': return handleMessageEvent_(event);
      case 'reaction_added': return handleReactionEvent_(event);
      case 'app_home_opened': return handleAppHomeOpened_(event);
      case 'app_mention': return handleAppMention_(event);
      case 'team_join': return handleTeamJoin_(event);
      default: return emptyOut_();
    }
  } catch (e) {
    logError_('event.failed', event.user || '', { type: event.type, error: String(e && e.stack || e) });
    return emptyOut_();
  }
}

/** Giving by typing the trigger emoji in a normal channel message. */
function handleMessageEvent_(event) {
  if (!cfgBool_('ALLOW_EMOJI_GIVING')) return emptyOut_();
  // Ignore edits, deletions, joins, bot posts and thread broadcasts.
  if (event.subtype && event.subtype !== 'thread_broadcast') return emptyOut_();
  if (event.bot_id || !event.user || !event.text) return emptyOut_();

  var trigger = ':' + cfgStr_('EMOJI_TRIGGER') + ':';
  if (event.text.indexOf(trigger) === -1) return emptyOut_();

  var parsed = parseGive_(event.text);
  if (!parsed.userIds.length) return emptyOut_();

  // Claim the event before doing any work, so a retry finds it taken.
  if (messageAlreadyCounted_(event.ts, event.user)) return emptyOut_();
  markMessageCounted_(event.ts, event.user);

  var check = validateGive_(parsed, event.user);
  if (!check.ok) {
    postEphemeral_(event.channel, event.user, check.message);
    return emptyOut_();
  }

  var req = {
    giverId: event.user,
    giverName: displayName_(event.user),
    userIds: parsed.userIds,
    wagsEach: parsed.dots,
    reason: parsed.reason,
    value: parsed.value,
    valueTag: parsed.value ? parsed.value.tag : '',
    channelId: event.channel,
    channelName: '',
    source: 'emoji',
    messageTs: event.ts
  };

  var result;
  try {
    result = giveWags_(req);
  } catch (e) {
    // A lock conflict is transient. Release the claim so Slack's retry of this
    // same event can succeed — otherwise the tailwag is lost silently and the giver
    // is never told, which is the worst possible failure for a trust system.
    if (String(e.message || e).indexOf('BUSY') !== -1) {
      unmarkMessageCounted_(event.ts, event.user);
      logWarn_('emoji.busy', event.user, event.ts);
      postEphemeral_(event.channel, event.user,
        'Tail Wag was busy for a second and did not record that one. Send it again.');
      return emptyOut_();
    }
    logError_('emoji.failed', event.user, String(e && e.stack || e));
    postEphemeral_(event.channel, event.user,
      'Something went wrong recording that tailwag. Nothing was counted — try again.');
    return emptyOut_();
  }

  if (!result.awarded.length) {
    var why = result.skipped.map(function (s) { return mention_(s.userId) + ' — ' + s.reason; }).join('\n');
    postEphemeral_(event.channel, event.user, why || 'That one did not go through.');
    return emptyOut_();
  }

  logInfo_('tailwag.given', event.user, {
    to: result.awarded.map(function (a) { return a.userId; }),
    dots: result.spent, source: 'emoji'
  });

  // Confirm in-thread so the channel is not doubled up with the original message.
  var msg = buildAwardMessage_(result, req);
  postMessage_(event.channel, msg.text, msg.blocks, event.thread_ts || event.ts);
  dispatchSideMessages_(result, req);
  return emptyOut_();
}

/** Giving by reacting to a message with the trigger emoji. */
function handleReactionEvent_(event) {
  if (!cfgBool_('ALLOW_REACTION_GIVING')) return emptyOut_();
  var trigger = cfgStr_('EMOJI_TRIGGER');
  if (String(event.reaction) !== trigger) return emptyOut_();
  if (!event.item || event.item.type !== 'message') return emptyOut_();

  var giverId = event.user;
  var receiverId = event.item_user;
  if (!receiverId || receiverId === giverId) return emptyOut_();

  var claimKey = event.item.ts + '.react';
  if (messageAlreadyCounted_(claimKey, giverId)) return emptyOut_();
  markMessageCounted_(claimKey, giverId);

  // The message they reacted to becomes the reason.
  var reason = fetchMessageText_(event.item.channel, event.item.ts);
  // Slack hands message text back already escaped (&amp;, &lt;). Everything
  // downstream escapes again on the way out, so undo it once here or a message
  // containing "&" renders as "&amp;amp;".
  reason = reason ? 'for: ' + truncate_(unescapeSlack_(reason).replace(/\s+/g, ' ').trim(), 300)
    : 'for something worth reacting to';

  var req = {
    giverId: giverId,
    giverName: displayName_(giverId),
    userIds: [receiverId],
    wagsEach: 1,
    reason: reason,
    value: null,
    valueTag: '',
    channelId: event.item.channel,
    channelName: '',
    source: 'reaction',
    messageTs: event.item.ts
  };

  if (cfgBool_('PAUSED')) return emptyOut_();
  if (rosterBlocks_(giverId) || rosterBlocks_(receiverId)) return emptyOut_();

  var result;
  try {
    result = giveWags_(req);
  } catch (e) {
    if (String(e.message || e).indexOf('BUSY') !== -1) {
      unmarkMessageCounted_(claimKey, giverId);
      logWarn_('reaction.busy', giverId, claimKey);
      postEphemeral_(event.item.channel, giverId,
        'Tail Wag was busy for a second. Remove the reaction and add it again.');
      return emptyOut_();
    }
    logError_('reaction.failed', giverId, String(e && e.stack || e));
    return emptyOut_();
  }

  if (!result.awarded.length) {
    var why = result.skipped.length ? result.skipped[0].reason : 'That one did not go through.';
    postEphemeral_(event.item.channel, giverId, why);
    return emptyOut_();
  }

  logInfo_('tailwag.given', giverId, { to: [receiverId], dots: result.spent, source: 'reaction' });
  var msg = buildAwardMessage_(result, req);
  postMessage_(event.item.channel, msg.text, msg.blocks, event.item.ts);
  dispatchSideMessages_(result, req);
  return emptyOut_();
}

/** Reads the text of a specific message, for reaction reasons. */
function fetchMessageText_(channel, ts) {
  var res = slackApiGet_('conversations.history', {
    channel: channel, latest: ts, oldest: ts, inclusive: true, limit: 1
  }, true);
  if (res.ok && res.messages && res.messages.length) return String(res.messages[0].text || '');
  return '';
}

/** Someone opened the app's Home tab. */
function handleAppHomeOpened_(event) {
  if (event.tab && event.tab !== 'home') return emptyOut_();
  publishHomeView_(event.user);
  return emptyOut_();
}

/** Someone @mentioned the bot. */
function handleAppMention_(event) {
  var text = String(event.text || '');
  var stripped = text.replace(/<@[UW][A-Z0-9]+>/, '').trim();

  // This path posts to a channel, so an unacknowledged slow run followed by a
  // Slack retry would post the leaderboard two or three times.
  var claim = event.ts + '.mention';
  if (messageAlreadyCounted_(claim, event.user || 'anon')) return emptyOut_();
  markMessageCounted_(claim, event.user || 'anon');

  if (/^(leaderboard|board|top)/i.test(stripped)) {
    var rows = leaderboard_('period');
    var lb = buildLeaderboardCard_('period', rows, event.user);
    postMessage_(event.channel, lb.text, lb.blocks, event.thread_ts || event.ts);
    return emptyOut_();
  }
  var help = buildHelpCard_(event.user);
  postEphemeral_(event.channel, event.user, help.text, help.blocks);
  return emptyOut_();
}

/** A new person joined the workspace — put them on the roster with a full allowance. */
function handleTeamJoin_(event) {
  var u = event.user;
  if (!u || !u.id || u.is_bot || u.deleted) return emptyOut_();
  upsertRoster_(u.id, {
    display_name: (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name,
    real_name: (u.profile && u.profile.real_name) || '',
    email: (u.profile && u.profile.email) || ''
  });
  getBalance_(u.id, (u.profile && u.profile.real_name) || u.name);
  logInfo_('roster.joined', u.id, u.name || '');
  return emptyOut_();
}

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

/**
 * Block Kit interactions — the buttons on the balance card and App Home.
 * @param {Object} payload
 */
function handleInteraction_(payload) {
  if (payload.type === 'block_actions') {
    var action = (payload.actions && payload.actions[0]) || {};
    var userId = (payload.user && payload.user.id) || '';
    var responseUrl = payload.response_url;

    /**
     * Replies to an interaction.
     *
     * Blocks attached to a message carry a response_url; blocks on the App Home
     * tab do not. Without this fallback every Home-tab button is a dead click —
     * respondLater_ returns an error nobody sees and nothing happens.
     */
    var reply = function (text, blocks) {
      if (responseUrl) {
        return respondLater_(responseUrl, {
          response_type: 'ephemeral', replace_original: true, text: text, blocks: blocks
        });
      }
      return postMessage_(userId, text, blocks);
    };

    switch (action.action_id) {
      case 'lb_period':
      case 'lb_month':
      case 'lb_all': {
        var period = action.action_id === 'lb_month' ? 'month'
          : action.action_id === 'lb_all' ? 'all' : 'period';
        var rows = leaderboard_(period);
        var card = buildLeaderboardCard_(period, rows, userId);
        reply(card.text, card.blocks.concat([
          actionsBlock_([
            buttonElement_('This ' + periodWord_(), 'lb_period', 'period', period === 'period' ? 'primary' : undefined),
            buttonElement_('This month', 'lb_month', 'month', period === 'month' ? 'primary' : undefined),
            buttonElement_('All time', 'lb_all', 'all', period === 'all' ? 'primary' : undefined),
            buttonElement_('My tailwags', 'show_balance', 'me')
          ])
        ]));
        return emptyOut_();
      }

      case 'show_balance': {
        var bal = getBalance_(userId, displayName_(userId));
        var mine = buildBalanceCard_(bal, userId);
        reply(mine.text, mine.blocks.concat([
          actionsBlock_([
            buttonElement_('This ' + periodWord_(), 'lb_period', 'period'),
            buttonElement_('This month', 'lb_month', 'month'),
            buttonElement_('All time', 'lb_all', 'all')
          ])
        ]));
        return emptyOut_();
      }

      case 'show_help': {
        var help = buildHelpCard_(userId);
        reply(help.text, help.blocks);
        return emptyOut_();
      }

      case 'home_refresh':
        publishHomeView_(userId);
        return emptyOut_();

      default:
        return emptyOut_();
    }
  }
  return emptyOut_();
}
