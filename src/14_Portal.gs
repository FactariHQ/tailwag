/**
 * Tail Wag — 14_Portal.gs
 * The rewards portal: a web app people open from the ACT Google Site, signed in
 * with their actaba.com Google account. It shows their tailwags and tickets,
 * lets them put tickets into reward pods, and shows who has won. Admins get a
 * second tab to run the whole thing.
 *
 * Identity
 * --------
 * The portal is deployed with "Who has access: anyone in actaba.com" and
 * "Execute as: me", so Session.getActiveUser() is the viewer's Workspace email.
 * That email is matched to a Slack member through the Roster tab (filled from
 * Slack's users.list, which carries emails), falling back to Slack's
 * users.lookupByEmail for anyone the roster has not caught yet.
 *
 * Every function here without a trailing underscore is callable from the page
 * via google.script.run, so each one resolves the caller itself and never
 * trusts an id passed in from the browser.
 */

/** The viewer's Google email, or '' when anonymous. */
function activeEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * Resolves the signed-in viewer to a Slack member.
 * @return {{userId:string, name:string, email:string, isAdmin:boolean}|null}
 */
function portalUser_() {
  var email = activeEmail_();
  if (!email) return null;

  var memo = cacheGet_('portal.who.' + email);
  var userId = memo ? memo.userId : '';
  var name = memo ? memo.name : '';

  if (!userId) {
    var roster = getRoster_();
    Object.keys(roster).forEach(function (id) {
      // google_email is for people whose Google login differs from their Slack
      // email (Slack on factari.com, Google on actaba.com). Roster sync never
      // touches it, so the link survives every sync.
      var google = String(roster[id].google_email || '').trim().toLowerCase();
      var slack = String(roster[id].email || '').trim().toLowerCase();
      if (!userId && (google === email || slack === email)) {
        userId = id;
        name = String(roster[id].display_name || roster[id].real_name || id);
      }
    });
  }
  if (!userId && cfgStr_('SLACK_BOT_TOKEN')) {
    var res = slackApiGet_('users.lookupByEmail', { email: email }, true);
    if (res && res.ok && res.user && !res.user.deleted && !res.user.is_bot) {
      userId = res.user.id;
      var p = res.user.profile || {};
      name = p.display_name || p.real_name || res.user.name || userId;
      try {
        withLock_(function () {
          upsertRoster_(userId, { display_name: name, real_name: p.real_name || '', email: email });
        });
      } catch (e) { /* the roster row is a convenience */ }
    }
  }
  if (!userId) return { userId: '', name: email, email: email, isAdmin: isPortalAdminEmail_(email) };

  cachePut_('portal.who.' + email, { userId: userId, name: name }, 3600);
  return { userId: userId, name: name, email: email, isAdmin: isAdmin_(userId) || isPortalAdminEmail_(email) };
}

function isPortalAdminEmail_(email) {
  var e = String(email || '').toLowerCase();
  return !!e && cfgList_('REWARDS_ADMIN_EMAILS').map(function (x) { return x.toLowerCase(); }).indexOf(e) !== -1;
}

/** The viewer, or an exception the page turns into a friendly message. */
function requirePortalUser_() {
  if (!isRewardsProject_()) throw new Error('Open Tail Wag Rewards from the ACT intranet.');
  var me = portalUser_();
  if (!me) throw new Error('Sign in with your ACT Google account to see your rewards.');
  if (!me.userId && !me.isAdmin) {
    throw new Error('We could not find a Slack account for ' + me.email + '. Tail Wag matches you by email — ' +
      'make sure your Slack profile uses this address, or ask an admin.');
  }
  return me;
}

function requirePortalAdmin_() {
  if (!isRewardsProject_()) throw new Error('Open Tail Wag Rewards from the ACT intranet.');
  var me = portalUser_();
  if (!me || !me.isAdmin) throw new Error('That is admin-only.');
  return me;
}

// ---------------------------------------------------------------------------
// Serving the page
// ---------------------------------------------------------------------------

/** The portal page, for a signed-in viewer. */
function servePortal_() {
  var tmpl = HtmlService.createTemplateFromFile('Portal');
  tmpl.boot = {
    unitSingular: cfgStr_('UNIT_SINGULAR') || 'tailwag',
    unitPlural: cfgStr_('UNIT_PLURAL') || 'tailwags',
    jackson: jacksonDataUri_()
  };
  return tmpl.evaluate()
    .setTitle('Tail Wag Rewards')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Jackson's face, inlined so the page needs no image hosting. */
function jacksonDataUri_() {
  try {
    return String(HtmlService.createHtmlOutputFromFile('PortalLogo').getContent() || '').trim();
  } catch (e) {
    return '';
  }
}

/** The page for someone who reached the portal without signing in. */
function portalSignInPage_() {
  var url = cfgStr_('REWARDS_PORTAL_URL');
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;background:#fff8f0;color:#2b1d10;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}' +
    'a{color:#c25e00}</style>' +
    '<div style="max-width:420px"><h1 style="font-size:22px">🐕 Tail Wag</h1>' +
    '<p>This link needs its key. Looking for your rewards? ' +
    (url ? 'Open <a href="' + escapeHtml_(url) + '" target="_top">Tail Wag Rewards</a> ' : 'Open Tail Wag Rewards on the ACT intranet ') +
    'while signed in with your ACT Google account.</p></div>'
  ).setTitle('Tail Wag');
}

// ---------------------------------------------------------------------------
// Slack emoji shortcodes → something a browser can draw
// ---------------------------------------------------------------------------

var EMOJI_MAP = {
  fire: '🔥', zap: '⚡', rocket: '🚀', trophy: '🏆', eyes: '👀', handshake: '🤝', star2: '🌟',
  star: '⭐', dart: '🎯', heart: '❤️', seedling: '🌱', house: '🏠', tada: '🎉', gift: '🎁',
  small_blue_diamond: '🔹', medal: '🏅', sparkles: '✨', coffee: '☕', pizza: '🍕', dog: '🐕',
  money_with_wings: '💸', ticket: '🎟️', crown: '👑', gem: '💎', sunglasses: '😎', clap: '👏'
};

/** ':fire:' → '🔥'. Unknown codes (and :jackson:) come back as '' so the page can draw Jackson. */
function emojiOf_(code) {
  var m = String(code || '').match(/^:?([a-z0-9_+\-]+):?$/i);
  if (!m) return String(code || '');
  return EMOJI_MAP[m[1].toLowerCase()] || '';
}

// ---------------------------------------------------------------------------
// Data for the page
// ---------------------------------------------------------------------------

/** A pod as the page sees it. `others` is everyone else's ticket counts, anonymous, for the odds maths. */
function podForPage_(pod, totals, userId, t) {
  var tt = totals || emptyTotals_();
  var mine = userId ? (tt.byUser[userId] || 0) : 0;
  var others = [];
  Object.keys(tt.byUser).forEach(function (uid) { if (uid !== userId) others.push(tt.byUser[uid]); });
  return {
    pod_id: pod.pod_id, title: pod.title, description: pod.description, emoji: pod.emoji,
    image_url: pod.image_url, prize_value: pod.prize_value, winners_count: pod.winners_count,
    max_tickets_per_person: pod.max_tickets_per_person, opens_ts: pod.opens_ts, closes_ts: pod.closes_ts,
    status: pod.status, phase: podPhase_(pod, t), drawn_ts: pod.drawn_ts,
    total: tt.total, entrants: tt.entrants, mine: mine, others: others, sort: pod.sort
  };
}

function winnerForPage_(w, podsById) {
  var pod = podsById[w.pod_id];
  return {
    hidden: !!(pod && pod.hidden_ts),
    pod_id: w.pod_id, pod_title: w.pod_title, emoji: pod ? pod.emoji : '🎁',
    prize_value: pod ? pod.prize_value : '', place: w.place, user_id: w.user_id, name: w.name,
    tickets_in: w.tickets_in, pod_total_tickets: w.pod_total_tickets, entrants: w.entrants,
    drawn_ts: w.drawn_ts, fulfilled: w.fulfilled
  };
}

function valueIndex_() {
  var out = {};
  valueList_().forEach(function (v) { out[v.tag] = { label: v.label, emoji: emojiOf_(v.emoji) }; });
  return out;
}

function ledgerForPage_(r, values) {
  var v = values[String(r.value_tag || '')];
  return {
    ts: tsIso_(r.ts_iso), giver_id: String(r.giver_id), giver: String(r.giver_name || r.giver_id),
    receiver_id: String(r.receiver_id), receiver: String(r.receiver_name || r.receiver_id),
    dots: num_(r.dots), reason: String(r.reason || ''), source: String(r.source || ''),
    value: v ? v.label : '', value_emoji: v ? v.emoji : ''
  };
}

/**
 * Everything the page needs for one person, in one round trip.
 * Callable from the page.
 */
function portalLoad() {
  var me = requirePortalUser_();
  return portalState_(me);
}

function portalState_(me) {
  rewardsCacheDrop_();
  var t = now_().getTime();
  var totals = podTotals_();
  var pods = podsAll_();
  var podsById = {};
  pods.forEach(function (p) { podsById[p.pod_id] = p; });

  // Staff see live pods, plus anything settled in the last 45 days.
  var recentCut = t - 45 * 86400000;
  var visible = pods.filter(function (p) {
    if (p.hidden_ts) return false;   // an admin hid it
    if (p.status === 'live') return true;
    if (p.status === 'drawn') return tsMs_(p.drawn_ts) >= recentCut;
    return false;   // drafts are admin-only; a cancelled pod shows up as a refund in history
  }).map(function (p) { return podForPage_(p, totals[p.pod_id], me.userId, t); });

  var wallet = walletFor_(me.userId);
  var bal = balanceReadOnly_(me.userId, me.name);
  var values = valueIndex_();
  var ledger = readSheet_(SHEETS.LEDGER);
  var received = [];
  var given = [];
  for (var i = ledger.length - 1; i >= 0 && (received.length < 150 || given.length < 150); i--) {
    var r = ledger[i];
    if (String(r.receiver_id) === me.userId && received.length < 150) received.push(ledgerForPage_(r, values));
    if (String(r.giver_id) === me.userId && given.length < 150) given.push(ledgerForPage_(r, values));
  }

  var history = ticketRows_().filter(function (x) { return x.user_id === me.userId; })
    .map(function (x) {
      return { ts: x.ts, delta: x.delta, kind: x.kind, pod: x.pod_id && podsById[x.pod_id] ? podsById[x.pod_id].title : '', note: x.note };
    });
  pendingCredits_().credits.forEach(function (c) {
    if (c.user_id === me.userId) history.push({ ts: c.ts, delta: c.delta, kind: c.kind, pod: '', note: c.note, pending: true });
  });
  history.sort(function (a, b) { return tsMs_(b.ts) - tsMs_(a.ts); });

  var winners = winnerRows_().filter(function (w) {
    return !(podsById[w.pod_id] && podsById[w.pod_id].hidden_ts);
  }).sort(function (a, b) {
    return tsMs_(b.drawn_ts) - tsMs_(a.drawn_ts) || a.place - b.place;
  }).map(function (w) { return winnerForPage_(w, podsById); });

  var badges = badgesFor_(bal).map(function (b) { return { label: b.label, emoji: emojiOf_(b.emoji), track: b.track }; });
  var next = nextBadge_(bal);

  return {
    me: { userId: me.userId, name: me.name, email: me.email, isAdmin: me.isAdmin },
    wallet: {
      available: wallet.available, spendable: wallet.spendable, inPlay: wallet.inPlay, spent: wallet.spent,
      earned: wallet.earned, granted: wallet.granted, ideas: wallet.ideas, pending: wallet.pending, byPod: wallet.byPod
    },
    kudos: {
      receivedTotal: num_(bal.received_total), receivedMonth: num_(bal.received_month),
      receivedPeriod: num_(bal.received_this_period), givenTotal: num_(bal.given_total),
      remaining: num_(bal.remaining), allowance: num_(bal.allowance), periodWord: periodWord_(),
      resets: periodResetText_(), streak: num_(bal.streak), badges: badges,
      next: next ? { label: next.badge.label, emoji: emojiOf_(next.badge.emoji), need: next.need, threshold: next.badge.threshold } : null
    },
    received: received,
    given: given,
    history: history.slice(0, 300),
    pods: visible,
    winners: winners.slice(0, 200),
    ideas: cfgBool_('IDEAS_ENABLED') ? ideasForPage_(me.userId, me.isAdmin) : [],
    rules: {
      perReceived: num_(cfgNum_('TICKETS_PER_WAG_RECEIVED')),
      perGiven: num_(cfgNum_('TICKETS_PER_WAG_GIVEN')),
      launch: tsIso_(cfgStr_('REWARDS_LAUNCH_TS')),
      enabled: cfgBool_('REWARDS_ENABLED'),
      ideasEnabled: cfgBool_('IDEAS_ENABLED'),
      ideaTickets: num_(cfgNum_('IDEA_SELECTED_TICKETS')),
      ideaMaxOpen: Math.floor(num_(cfgNum_('IDEA_MAX_OPEN_PER_PERSON')))
    },
    now: new Date(t).toISOString()
  };
}

/** Sets how many tickets the viewer has in a pod. Callable from the page. */
function portalSetAllocation(podId, target) {
  var me = requirePortalUser_();
  if (!me.userId) return { ok: false, error: 'Your Google account is not linked to a Slack account, so it has no tickets.', state: portalState_(me) };
  var res = setAllocation_(me.userId, me.name, String(podId || ''), target);
  res.state = portalState_(me);
  return res;
}

/** Nominates a reward idea as the signed-in person. Callable from the page. */
function portalSubmitIdea(title, details) {
  var me = requirePortalUser_();
  if (!me.userId) return { ok: false, error: 'Your Google account is not linked to a Slack account yet, so ideas cannot be credited to you.', state: portalState_(me) };
  var res = submitIdea_(me.userId, me.name, title, details);
  res.state = portalState_(me);
  return res;
}

/** Upvotes (or un-upvotes) an idea as the signed-in person. Callable from the page. */
function portalToggleIdeaVote(ideaId) {
  var me = requirePortalUser_();
  if (!me.userId) return { ok: false, error: 'Your Google account is not linked to a Slack account yet.', state: portalState_(me) };
  var res = toggleIdeaVote_(me.userId, String(ideaId || ''));
  res.state = portalState_(me);
  return res;
}

/** Withdraws one of the signed-in person's own open ideas. Callable from the page. */
function portalWithdrawIdea(ideaId) {
  var me = requirePortalUser_();
  var res = withdrawIdea_(me.userId, String(ideaId || ''));
  res.state = portalState_(me);
  return res;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * A person's Balances row without creating or rewriting it. The Slack project
 * owns that tab; the portal only ever reads it.
 */
function balanceReadOnly_(userId, name) {
  var idx = balanceIndex_();
  if (!idx[userId]) return emptyBalance_(userId, name);
  var cols = headerOf_(SHEETS.BALANCES).order;
  var row = sheet_(SHEETS.BALANCES).getRange(idx[userId], 1, 1, cols.length).getValues()[0];
  var bal = {};
  for (var c = 0; c < cols.length; c++) if (cols[c]) bal[cols[c]] = row[c];
  if (String(bal.user_id).trim() !== userId) {
    cacheDrop_('balances.index');
    return emptyBalance_(userId, name);
  }
  rollForward_(bal);
  return bal;
}

/** Everything the Admin tab needs. Callable from the page by admins. */
function portalAdminLoad() {
  requirePortalAdmin_();
  return portalAdminState_();
}

function portalAdminState_() {
  rewardsCacheDrop_();
  var t = now_().getTime();
  var roster = getRoster_();
  var totals = podTotals_();
  var wallets = allWallets_();
  var podsById = {};

  var pods = podsAll_().map(function (p) {
    podsById[p.pod_id] = p;
    var tt = totals[p.pod_id] || emptyTotals_();
    var entrants = Object.keys(tt.byUser).map(function (uid) {
      var r = roster[uid];
      return { user_id: uid, name: r ? String(r.display_name || r.real_name || uid) : (tt.names[uid] || uid), tickets: tt.byUser[uid] };
    }).sort(function (a, b) { return b.tickets - a.tickets; });
    var out = podForPage_(p, tt, '', t);
    delete out.others;
    out.entrantList = entrants;
    out.announced_ts = p.announced_ts;
    out.created_by = p.created_by;
    out.hidden = !!p.hidden_ts;
    return out;
  });

  var people = {};
  Object.keys(roster).forEach(function (uid) {
    var r = roster[uid];
    var active = r.active;
    if (typeof active === 'string') active = active.trim().toLowerCase() !== 'false';
    if (active === false) return;
    people[uid] = { user_id: uid, name: String(r.display_name || r.real_name || uid), email: String(r.email || ''), google_email: String(r.google_email || '') };
  });
  Object.keys(wallets).forEach(function (uid) {
    if (!people[uid]) people[uid] = { user_id: uid, name: wallets[uid].name, email: roster[uid] ? String(roster[uid].email || '') : '' };
  });
  var totalsAll = { earned: 0, granted: 0, ideas: 0, available: 0, inPlay: 0, spent: 0, pending: 0 };
  var list = Object.keys(people).map(function (uid) {
    var w = wallets[uid] || { available: 0, earned: 0, granted: 0, ideas: 0, inPlay: 0, spent: 0, pending: 0, byPod: {} };
    ['earned', 'granted', 'ideas', 'available', 'inPlay', 'spent', 'pending'].forEach(function (k) { totalsAll[k] = tix_(totalsAll[k] + num_(w[k])); });
    var p = people[uid];
    p.available = w.available; p.earned = w.earned; p.granted = w.granted; p.ideas = w.ideas || 0; p.inPlay = w.inPlay;
    p.spent = w.spent; p.pending = w.pending; p.byPod = w.byPod;
    return p;
  }).sort(function (a, b) { return (b.earned + b.granted) - (a.earned + a.granted) || a.name.localeCompare(b.name); });

  var winners = winnerRows_().slice().sort(function (a, b) {
    return tsMs_(b.drawn_ts) - tsMs_(a.drawn_ts) || a.place - b.place;
  }).map(function (w) { return winnerForPage_(w, podsById); });

  var activity = ticketRows_().slice(-120).reverse().map(function (x) {
    return { ts: x.ts, name: x.name, user_id: x.user_id, delta: x.delta, kind: x.kind, pod: x.pod_id && podsById[x.pod_id] ? podsById[x.pod_id].title : '', note: x.note, actor: x.actor };
  });

  var jobOwner = cfgStr_('REWARDS_JOB_SCRIPT_ID');
  var here = '';
  try { here = ScriptApp.getScriptId(); } catch (e) { here = ''; }

  return {
    pods: pods,
    people: list,
    totals: totalsAll,
    winners: winners,
    activity: activity,
    settings: {
      perReceived: num_(cfgNum_('TICKETS_PER_WAG_RECEIVED')),
      perGiven: num_(cfgNum_('TICKETS_PER_WAG_GIVEN')),
      launch: tsIso_(cfgStr_('REWARDS_LAUNCH_TS')),
      enabled: cfgBool_('REWARDS_ENABLED'),
      announce: cfgBool_('REWARDS_ANNOUNCE_PODS'),
      dmWinners: cfgBool_('REWARDS_DM_WINNERS'),
      excludeDays: num_(cfgNum_('REWARDS_EXCLUDE_RECENT_WINNERS_DAYS')),
      portalUrl: cfgStr_('REWARDS_PORTAL_URL'),
      channel: cfgStr_('ANNOUNCE_CHANNEL'),
      ideasEnabled: cfgBool_('IDEAS_ENABLED'),
      ideaTickets: num_(cfgNum_('IDEA_SELECTED_TICKETS')),
      ideaMaxOpen: Math.floor(num_(cfgNum_('IDEA_MAX_OPEN_PER_PERSON'))),
      scheduler: jobOwner ? (jobOwner === here ? 'running in this project' : 'running in another project') : 'NOT INSTALLED — run installRewardsTriggers()'
    }
  };
}

function adminResult_(res) {
  res = res || {};
  res.admin = portalAdminState_();
  return res;
}

/** Create or update a pod. */
function portalAdminSavePod(input) {
  var me = requirePortalAdmin_();
  input = input || {};
  var res = savePod_(input, me.email);
  // Turning a nominated idea into a reward selects the idea and pays its nominator.
  if (res.ok && input.from_idea) {
    var picked = decideIdea_(String(input.from_idea), 'selected', me.email, { podId: res.pod_id });
    res.message = res.message + (picked.ok ? ' ' + picked.message : ' (The idea was not updated: ' + picked.error + ')');
  }
  return adminResult_(res);
}

/** Selects, declines or reopens a reward idea. */
function portalAdminDecideIdea(ideaId, decision, note) {
  var me = requirePortalAdmin_();
  return adminResult_(decideIdea_(String(ideaId || ''), String(decision || ''), me.email, { note: String(note || '') }));
}

function portalAdminPublish(podId) {
  var me = requirePortalAdmin_();
  return adminResult_(publishPod_(String(podId || ''), me.email));
}

function portalAdminCancel(podId, reason) {
  var me = requirePortalAdmin_();
  return adminResult_(cancelPod_(String(podId || ''), me.email, String(reason || '')));
}

/** Hides a finished reward from staff (hide = true) or shows it again. */
function portalAdminHide(podId, hide) {
  var me = requirePortalAdmin_();
  return adminResult_(setPodHidden_(String(podId || ''), me.email, hide !== false));
}

function portalAdminDraw(podId) {
  var me = requirePortalAdmin_();
  return adminResult_(drawPod_(String(podId || ''), me.email, true));
}

function portalAdminGrant(userIds, amount, note) {
  var me = requirePortalAdmin_();
  var ids = (userIds || []).map(String).filter(function (x) { return /^[UW][A-Z0-9]{2,}$/.test(x); });
  return adminResult_(grantTickets_(ids, amount, note, me.email));
}

function portalAdminFulfill(podId, userId, on) {
  var me = requirePortalAdmin_();
  return adminResult_(markFulfilled_(String(podId || ''), String(userId || ''), me.email, on !== false));
}

/** Changes the earn rates and switches. Rate changes apply to tailwags not yet credited. */
function portalAdminSettings(s) {
  var me = requirePortalAdmin_();
  s = s || {};
  var changed = [];
  function rate(key, v) {
    if (v === undefined || v === null || v === '') return;
    var n = Math.round(num_(v) * 100) / 100;
    if (n < 0 || n > 100) throw new Error('Rates must be between 0 and 100.');
    if (n !== num_(cfgNum_(key))) {
      // Credit everything earned so far at the OLD rate, and switch, under one
      // lock — so nothing slips in between and the change is forward-only.
      withLock_(function () {
        accrueTickets_();
        setConfig_(key, n);
      });
      changed.push(key + ' = ' + n);
    }
  }
  function flag(key, v) {
    if (v === undefined || v === null) return;
    if (!!v !== cfgBool_(key)) { setConfig_(key, !!v); changed.push(key + ' = ' + (!!v)); }
  }
  rate('TICKETS_PER_WAG_RECEIVED', s.perReceived);
  rate('TICKETS_PER_WAG_GIVEN', s.perGiven);
  flag('REWARDS_ANNOUNCE_PODS', s.announce);
  flag('REWARDS_DM_WINNERS', s.dmWinners);
  flag('IDEAS_ENABLED', s.ideasEnabled);
  if (s.ideaTickets !== undefined && s.ideaTickets !== null && s.ideaTickets !== '') {
    var it = Math.round(num_(s.ideaTickets) * 100) / 100;
    if (it < 0 || it > 1000) throw new Error('Idea tickets must be between 0 and 1000.');
    if (it !== num_(cfgNum_('IDEA_SELECTED_TICKETS'))) { setConfig_('IDEA_SELECTED_TICKETS', it); changed.push('IDEA_SELECTED_TICKETS = ' + it); }
  }
  if (s.excludeDays !== undefined && s.excludeDays !== '' && num_(s.excludeDays) !== num_(cfgNum_('REWARDS_EXCLUDE_RECENT_WINNERS_DAYS'))) {
    var d = Math.max(0, Math.floor(num_(s.excludeDays)));
    setConfig_('REWARDS_EXCLUDE_RECENT_WINNERS_DAYS', d);
    changed.push('REWARDS_EXCLUDE_RECENT_WINNERS_DAYS = ' + d);
  }
  if (s.portalUrl !== undefined && String(s.portalUrl).trim() !== cfgStr_('REWARDS_PORTAL_URL')) {
    var u = safeUrl_(s.portalUrl);
    if (String(s.portalUrl).trim() && !u) throw new Error('The portal link must start with https://');
    setConfig_('REWARDS_PORTAL_URL', u);
    changed.push('REWARDS_PORTAL_URL');
  }
  if (changed.length) {
    logInfo_('rewards.settings', me.email, changed);
    pingSlackCacheDrop_();
  }
  return adminResult_({ ok: true, message: changed.length ? 'Saved: ' + changed.join(', ') + '.' : 'Nothing changed.' });
}

/**
 * Links a Google login to a Slack person, for people whose Google account and
 * Slack email differ. Writes the Roster's google_email column, which roster
 * sync never touches. Pass an empty email to unlink.
 */
function portalAdminLinkEmail(userId, googleEmail) {
  var me = requirePortalAdmin_();
  var uid = String(userId || '').trim();
  var email = String(googleEmail || '').trim().toLowerCase();
  if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email)) return adminResult_({ ok: false, error: 'That is not an email address.' });
  var res = withLock_(function () {
    var roster = getRoster_();
    var row = roster[uid];
    if (!row) return { ok: false, error: 'That person is not on the Roster.' };
    var taken = Object.keys(roster).filter(function (id) {
      return id !== uid && email && String(roster[id].google_email || '').trim().toLowerCase() === email;
    });
    if (taken.length) return { ok: false, error: email + ' is already linked to someone else.' };
    var col = headerOf_(SHEETS.ROSTER).index.google_email;
    if (col === undefined) return { ok: false, error: 'The Roster has no google_email column yet — run setupRewards().' };
    sheet_(SHEETS.ROSTER).getRange(row.__row, col + 1).setValue(email);
    cacheDrop_('roster');
    if (email) cacheDrop_('portal.who.' + email);
    return { ok: true, message: email ? 'Linked ' + email + ' to ' + String(row.display_name || uid) + '.' : 'Unlinked.' };
  });
  logInfo_('rewards.link_email', me.email, { user: uid, email: email });
  return adminResult_(res);
}
