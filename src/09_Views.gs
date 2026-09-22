/**
 * Tail Wag — 09_Views.gs
 * The App Home tab: a person's standing, the boards, and the recent feed, all
 * in one place they can open any time without typing a command.
 */

/** Builds and publishes the Home tab for one user. */
function publishHomeView_(userId) {
  try {
    var view = buildHomeView_(userId);
    var res = slackApi_('views.publish', { user_id: userId, view: view });
    if (!res.ok) logWarn_('home.publish_failed', userId, res.error);
    return res;
  } catch (e) {
    logError_('home.failed', userId, String(e && e.stack || e));
    return { ok: false, error: String(e) };
  }
}

/** The Home tab view object. */
function buildHomeView_(userId) {
  var bal = getBalance_(userId, displayName_(userId));
  var word = periodWord_();
  var blocks = [];

  // --- Your tailwags -----------------------------------------------------------
  blocks.push(headerBlock_('🐕 Your tailwags'));
  blocks.push(sectionBlock_(
    '*' + num_(bal.remaining) + ' of ' + num_(bal.allowance) + '* left to give this ' + word + '  ' +
    wagRun_(num_(bal.remaining)) +
    (num_(bal.remaining) === 0 ? '\n_Refills ' + periodResetText_() + '._' : '')
  ));
  blocks.push(fieldsBlock_([
    ['Received this ' + word, String(num_(bal.received_this_period))],
    ['Received this month', String(num_(bal.received_month))],
    ['Received all-time', String(num_(bal.received_total))],
    ['Given all-time', String(num_(bal.given_total))]
  ]));

  var ctx = [];
  if (cfgBool_('STREAKS_ENABLED') && num_(bal.streak) > 1) {
    ctx.push(':fire: ' + num_(bal.streak) + '-' + word + ' giving streak');
  }
  if (cfgBool_('RAFFLE_ENABLED')) {
    var entries = myRaffleEntries_(userId, monthKey_());
    ctx.push('🎟️ ' + entries + ' ' + (entries === 1 ? 'entry' : 'entries') + ' in the ' +
      fmt_(now_(), 'MMMM') + ' drawing');
  }
  if (bal.pool === 'manager') ctx.push('Manager pool');
  if (ctx.length) blocks.push(contextBlock_(ctx.join('  ·  ')));

  // --- Rewards -------------------------------------------------------------
  homeRewardsBlocks_(userId).forEach(function (b) { blocks.push(b); });

  // --- Badges --------------------------------------------------------------
  var badges = badgesFor_(bal);
  var next = nextBadge_(bal);
  if (badges.length || next) {
    blocks.push(dividerBlock_());
    if (badges.length) {
      blocks.push(sectionBlock_('*Your badges*\n' + badges.map(function (b) {
        return b.emoji + ' ' + escapeSlack_(b.label);
      }).join('   ')));
    }
    if (next) {
      var got = num_(bal.received_total);
      blocks.push(contextBlock_(progressBar_(got, next.badge.threshold) + '  ' +
        next.need + ' more to ' + next.badge.emoji + ' *' + escapeSlack_(next.badge.label) + '*'));
    }
  }

  // --- Leaderboard ---------------------------------------------------------
  var rows = leaderboard_('period', 5);
  blocks.push(dividerBlock_());
  blocks.push(sectionBlock_('*Top this ' + word + '*'));
  blocks.push(rows.length
    ? sectionBlock_(rows.map(function (r, i) {
      return rankEmoji_(i) + ' ' + mention_(r.user_id) + ' — ' + r.dots +
        (r.user_id === userId ? '  ← you' : '');
    }).join('\n'))
    : contextBlock_('_Nobody has picked up a tailwag this ' + word + ' yet._'));

  var monthRows = leaderboard_('month', 5);
  if (monthRows.length) {
    blocks.push(sectionBlock_('*Top this month*'));
    blocks.push(sectionBlock_(monthRows.map(function (r, i) {
      return rankEmoji_(i) + ' ' + mention_(r.user_id) + ' — ' + r.dots +
        (r.user_id === userId ? '  ← you' : '');
    }).join('\n')));
  }

  // --- Recent feed ---------------------------------------------------------
  var feed = recentReasons_(6);
  if (feed.length) {
    blocks.push(dividerBlock_());
    blocks.push(sectionBlock_('*Lately around here*'));
    var values = {};
    valueList_().forEach(function (v) { values[v.tag] = v; });
    feed.forEach(function (r) {
      var v = values[r.value_tag];
      blocks.push(contextBlock_(
        (v ? v.emoji + ' ' : '') + '*' + escapeSlack_(r.giver_name) + '* → *' +
        escapeSlack_(r.receiver_name) + '*  ·  ' + escapeSlack_(truncate_(humanizeMentions_(r.reason, true), 200))
      ));
    });
  }

  // --- How to give ---------------------------------------------------------
  blocks.push(dividerBlock_());
  var trigger = ':' + cfgStr_('EMOJI_TRIGGER') + ':';
  var howLines = ['*Giving one*', '`/wag @someone what they did`'];
  if (cfgBool_('ALLOW_EMOJI_GIVING')) {
    howLines.push('or type `@someone ' + trigger + ' why` in any channel');
  }
  if (cfgBool_('ALLOW_REACTION_GIVING')) {
    howLines.push('or react with ' + trigger + ' on something good');
  }
  blocks.push(sectionBlock_(howLines.join('\n')));
  blocks.push(actionsBlock_([
    buttonElement_('Refresh', 'home_refresh', 'refresh'),
    buttonElement_('How it works', 'show_help', 'help')
  ]));

  blocks.push(contextBlock_('Updated ' + fmt_(now_(), 'EEE d MMM, h:mm a')));

  // Slack caps a view at 100 blocks.
  if (blocks.length > 100) blocks = blocks.slice(0, 100);

  return { type: 'home', blocks: blocks };
}

/** A little text progress bar, for badge progress. */
function progressBar_(current, target, width) {
  var w = width || 12;
  var pct = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
  var filled = Math.round(pct * w);
  var bar = '';
  for (var i = 0; i < w; i++) bar += i < filled ? '█' : '░';
  return '`' + bar + '` ' + current + '/' + target;
}
