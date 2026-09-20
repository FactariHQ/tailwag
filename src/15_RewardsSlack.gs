/**
 * Tail Wag — 15_RewardsSlack.gs
 * The rewards economy as seen from Slack: `/wags rewards`, the App Home section,
 * and the line in the help card. Read-only — tickets are moved on the portal.
 */

/** A button that opens a link rather than calling back. */
function linkButton_(text, url, actionId, style) {
  var b = {
    type: 'button',
    text: { type: 'plain_text', text: text, emoji: true },
    action_id: actionId || 'open_link',
    url: url
  };
  if (style) b.style = style;
  return b;
}

/** "3 tickets", "1 ticket", "2.5 tickets". */
function ticketWord_(n) {
  var v = tix_(n);
  return v + ' ' + (v === 1 ? 'ticket' : 'tickets');
}

/** A pod's close time, relative when it is near. */
function closesText_(pod) {
  var ms = tsMs_(pod.closes_ts) - now_().getTime();
  if (ms <= 0) return 'drawing now';
  var h = ms / 3600000;
  if (h < 1) return 'draws in ' + Math.max(1, Math.round(ms / 60000)) + ' min';
  if (h < 48) return 'draws in ' + Math.round(h) + 'h';
  return 'draws ' + fmt_(new Date(tsMs_(pod.closes_ts)), 'EEE MMM d');
}

/**
 * The rewards summary for one person: tickets, what is open, and a link.
 * @return {Array<Object>} Block Kit blocks
 */
function buildRewardsBlocks_(userId) {
  if (!cfgBool_('REWARDS_ENABLED')) return [sectionBlock_('_Rewards are switched off right now._')];
  var wallet = walletFor_(userId);
  var totals = podTotals_();
  var t = now_().getTime();
  var open = podsAll_().filter(function (p) { return podPhase_(p, t) === 'open'; });
  var soon = podsAll_().filter(function (p) { return podPhase_(p, t) === 'soon'; });

  var blocks = [headerBlock_('🎟️ Your rewards')];
  blocks.push(sectionBlock_('*' + ticketWord_(wallet.spendable) + '* ready to enter' +
    (wallet.inPlay ? '  ·  ' + ticketWord_(wallet.inPlay) + ' in open draws' : '') +
    (wallet.spent ? '  ·  ' + ticketWord_(wallet.spent) + ' spent so far' : '')));

  if (open.length) {
    blocks.push(sectionBlock_(open.slice(0, 8).map(function (p) {
      var tt = totals[p.pod_id] || emptyTotals_();
      var mine = tt.byUser[userId] || 0;
      var share = tt.total > 0 ? Math.round((mine / tt.total) * 100) : 0;
      return p.emoji + ' *' + escapeSlack_(p.title) + '*' + (p.prize_value ? ' — ' + escapeSlack_(p.prize_value) : '') +
        '\n      ' + closesText_(p) + '  ·  ' + tt.total + ' in from ' + tt.entrants + ' ' + (tt.entrants === 1 ? 'person' : 'people') +
        (mine ? '  ·  *you: ' + mine + '* (' + share + '% of the tickets)' : '  ·  _you have none in_');
    }).join('\n')));
  } else {
    blocks.push(contextBlock_('_Nothing is open to enter right now._'));
  }
  if (soon.length) {
    blocks.push(contextBlock_('Coming up: ' + soon.slice(0, 4).map(function (p) {
      return p.emoji + ' ' + escapeSlack_(p.title) + ' (opens ' + fmt_(new Date(tsMs_(p.opens_ts)), 'EEE MMM d') + ')';
    }).join('  ·  ')));
  }

  var rate = num_(cfgNum_('TICKETS_PER_WAG_RECEIVED'));
  var give = num_(cfgNum_('TICKETS_PER_WAG_GIVEN'));
  blocks.push(contextBlock_('Every ' + wagWord_(1) + ' you receive earns ' + ticketWord_(rate) +
    (give > 0 ? ', and every one you give earns ' + ticketWord_(give) : '') +
    '. Put them in whichever rewards you want — more tickets, better odds. Tickets in a draw are spent win or lose.'));

  var url = cfgStr_('REWARDS_PORTAL_URL');
  if (url) blocks.push(actionsBlock_([linkButton_('Open Tail Wag Rewards', url, 'open_rewards', 'primary')]));
  return blocks;
}

/** A short rewards section for the App Home tab. Never throws. */
function homeRewardsBlocks_(userId) {
  if (!cfgBool_('REWARDS_ENABLED')) return [];
  try {
    return [dividerBlock_()].concat(buildRewardsBlocks_(userId));
  } catch (e) {
    logWarn_('home.rewards_failed', userId, String(e));
    return [];
  }
}

/** /wags rewards — answered inline, or through response_url if it ran long. */
function handleRewardsCommand_(cmd) {
  var blocks = buildRewardsBlocks_(cmd.user_id);
  if (responseLikelyTooLate_() && cmd.response_url) {
    respondLater_(cmd.response_url, { response_type: 'ephemeral', text: 'Your rewards', blocks: blocks });
    return emptyOut_();
  }
  return ephemeral_('Your rewards', blocks);
}
