/**
 * Tail Wag — 16_Ideas.gs
 * Reward ideas: staff nominate things they would like to win, everyone can
 * upvote, and when an admin selects one the nominator earns
 * IDEA_SELECTED_TICKETS (20 to start).
 *
 * The Ideas tab holds one row per idea. Status is
 *   open      — waiting for a decision; can be upvoted and withdrawn
 *   selected  — an admin picked it (usually by turning it into a pod); paid
 *   declined  — an admin passed, with an optional note; can be reopened
 *   withdrawn — the nominator took it back
 * Selection is final: the payout is a Tickets row with ref idea:<id>, written
 * at most once, so a double click or a retried request can never pay twice.
 *
 * Like the rest of the rewards tabs, only the portal project writes here.
 */

var IDEA_STATUSES = ['open', 'selected', 'declined', 'withdrawn'];
var IDEA_TITLE_MAX = 80;
var IDEA_DETAILS_MAX = 600;

/** Every idea, normalized. Memoized for the execution alongside the other rewards tabs. */
function ideasAll_() {
  if (__rw.ideas) return __rw.ideas;
  __rw.ideas = readSheet_(SHEETS.IDEAS).map(function (r) {
    var status = String(r.status || 'open').trim().toLowerCase();
    if (IDEA_STATUSES.indexOf(status) === -1) status = 'open';
    var voters = String(r.voters || '').split(',').map(function (x) { return x.trim(); })
      .filter(function (x) { return /^[UW][A-Z0-9]{2,}$/.test(x); });
    return {
      idea_id: String(r.idea_id || '').trim(),
      title: String(r.title || ''),
      details: String(r.details || ''),
      nominator_id: String(r.nominator_id || '').trim(),
      nominator_name: String(r.nominator_name || ''),
      status: status,
      voters: voters,
      votes: voters.length,
      created_ts: tsIso_(r.created_ts),
      decided_ts: tsIso_(r.decided_ts),
      decided_by: String(r.decided_by || ''),
      decision_note: String(r.decision_note || ''),
      pod_id: String(r.pod_id || '').trim(),
      paid_tickets: tix_(r.paid_tickets),
      __row: r.__row
    };
  }).filter(function (i) { return i.idea_id; });
  return __rw.ideas;
}

function ideaById_(ideaId) {
  var id = String(ideaId || '').trim();
  var hit = ideasAll_().filter(function (i) { return i.idea_id === id; });
  return hit.length ? hit[0] : null;
}

/** Writes an idea object back to its row (or a new row), by the live header. */
function writeIdeaRow_(idea, rowNum) {
  var sh = sheet_(SHEETS.IDEAS);
  var cols = headerOf_(SHEETS.IDEAS).order;
  var row = {};
  Object.keys(idea).forEach(function (k) { row[k] = idea[k]; });
  row.voters = (idea.voters || []).join(',');
  var values = cols.map(function (c) {
    var v = c ? row[c] : '';
    return sanitizeCell_(v === undefined || v === null ? '' : v);
  });
  if (rowNum) {
    var at = cols.indexOf('idea_id');
    if (String(sh.getRange(rowNum, at + 1).getValue()).trim() !== idea.idea_id) rowNum = 0;
  }
  if (!rowNum) rowNum = sh.getLastRow() + 1;
  sh.getRange(rowNum, 1, 1, cols.length).setValues([values]);
  __rw.ideas = null;
}

function ideasOff_() {
  return { ok: false, error: 'Reward ideas are switched off right now.' };
}

/** Case- and punctuation-insensitive key, so "Extra PTO day!" matches "extra pto day". */
function ideaKey_(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

/** Nominates a reward idea. */
function submitIdea_(userId, name, title, details) {
  if (!isRewardsProject_()) return notRewardsProject_();
  if (!cfgBool_('IDEAS_ENABLED')) return ideasOff_();
  title = String(title || '').replace(/\s+/g, ' ').trim();
  details = String(details || '').trim();
  if (title.length < 4) return { ok: false, error: 'Give the idea a name of at least a few words.' };
  if (title.length > IDEA_TITLE_MAX) return { ok: false, error: 'Keep the name under ' + IDEA_TITLE_MAX + ' characters — put the rest in the details.' };
  if (details.length > IDEA_DETAILS_MAX) return { ok: false, error: 'Keep the details under ' + IDEA_DETAILS_MAX + ' characters.' };

  return withLock_(function () {
    rewardsCacheDrop_();
    var all = ideasAll_();
    var key = ideaKey_(title);
    var dupe = all.filter(function (i) { return i.status === 'open' && ideaKey_(i.title) === key; })[0];
    if (dupe) {
      return { ok: false, duplicate: dupe.idea_id, error: '"' + dupe.title + '" is already on the board — give it an upvote instead.' };
    }
    var cap = Math.floor(num_(cfgNum_('IDEA_MAX_OPEN_PER_PERSON')));
    if (cap > 0) {
      var mine = all.filter(function (i) { return i.nominator_id === userId && i.status === 'open'; }).length;
      if (mine >= cap) {
        return { ok: false, error: 'You have ' + mine + ' ideas waiting already. Once one is decided (or you withdraw one) you can add another.' };
      }
    }
    var idea = {
      idea_id: 'idea_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
      title: title, details: details, nominator_id: userId, nominator_name: name || userId,
      status: 'open', voters: [], created_ts: iso_(), decided_ts: '', decided_by: '',
      decision_note: '', pod_id: '', paid_tickets: ''
    };
    writeIdeaRow_(idea, 0);
    logInfo_('ideas.submitted', userId, { idea: idea.idea_id, title: title });
    return { ok: true, idea_id: idea.idea_id, message: 'Nominated. If it gets picked you earn ' + ticketWord_(cfgNum_('IDEA_SELECTED_TICKETS')) + '.' };
  });
}

/** Adds or removes the viewer's upvote. You cannot vote for your own idea. */
function toggleIdeaVote_(userId, ideaId) {
  if (!isRewardsProject_()) return notRewardsProject_();
  if (!cfgBool_('IDEAS_ENABLED')) return ideasOff_();
  return withLock_(function () {
    rewardsCacheDrop_();
    var idea = ideaById_(ideaId);
    if (!idea) return { ok: false, error: 'That idea no longer exists.' };
    if (idea.status !== 'open') return { ok: false, error: 'Voting is closed on this one — it has been ' + idea.status + '.' };
    if (idea.nominator_id === userId) return { ok: false, error: 'You cannot upvote your own idea — get someone else to.' };
    var at = idea.voters.indexOf(userId);
    var on = at === -1;
    if (on) idea.voters.push(userId); else idea.voters.splice(at, 1);
    writeIdeaRow_(idea, idea.__row);
    return { ok: true, voted: on, votes: idea.voters.length, message: on ? 'Upvoted.' : 'Vote removed.' };
  });
}

/** The nominator takes back an idea that has not been decided. */
function withdrawIdea_(userId, ideaId) {
  if (!isRewardsProject_()) return notRewardsProject_();
  return withLock_(function () {
    rewardsCacheDrop_();
    var idea = ideaById_(ideaId);
    if (!idea) return { ok: false, error: 'That idea no longer exists.' };
    if (idea.nominator_id !== userId) return { ok: false, error: 'Only the person who nominated it can withdraw it.' };
    if (idea.status !== 'open') return { ok: false, error: 'It has already been ' + idea.status + '.' };
    idea.status = 'withdrawn';
    idea.decided_ts = iso_();
    idea.decided_by = userId;
    writeIdeaRow_(idea, idea.__row);
    logInfo_('ideas.withdrawn', userId, { idea: ideaId });
    return { ok: true, message: 'Withdrawn.' };
  });
}

// ---------------------------------------------------------------------------
// Admin decisions
// ---------------------------------------------------------------------------

/**
 * Selects, declines or reopens an idea. Selecting pays the nominator once.
 *
 * @param {string} ideaId
 * @param {string} decision 'selected' | 'declined' | 'open'
 * @param {string} actor admin email
 * @param {{note?:string, podId?:string}=} opts
 */
function decideIdea_(ideaId, decision, actor, opts) {
  if (!isRewardsProject_()) return notRewardsProject_();
  opts = opts || {};
  if (['selected', 'declined', 'open'].indexOf(decision) === -1) return { ok: false, error: 'Unknown decision.' };
  var note = String(opts.note || '').trim().slice(0, 300);
  var podId = String(opts.podId || '').trim();

  var res = withLock_(function () {
    rewardsCacheDrop_();
    var idea = ideaById_(ideaId);
    if (!idea) return { ok: false, error: 'That idea no longer exists.' };
    if (idea.status === 'selected') {
      // Final: the nominator has been paid. Linking a pod afterwards is still allowed.
      if (decision === 'selected' && podId && !idea.pod_id) {
        idea.pod_id = podId;
        writeIdeaRow_(idea, idea.__row);
        return { ok: true, message: 'Linked to the reward.' };
      }
      return { ok: false, error: 'This idea was already selected and paid — that is final.' };
    }
    if (idea.status === 'withdrawn') return { ok: false, error: 'The nominator withdrew this idea.' };
    if (decision === idea.status && decision !== 'selected') return { ok: true, message: 'No change.' };

    if (decision === 'open') {
      idea.status = 'open';
      idea.decided_ts = ''; idea.decided_by = ''; idea.decision_note = '';
      writeIdeaRow_(idea, idea.__row);
      logInfo_('ideas.reopened', actor, { idea: ideaId });
      return { ok: true, message: 'Reopened.' };
    }
    if (decision === 'declined') {
      idea.status = 'declined';
      idea.decided_ts = iso_(); idea.decided_by = actor; idea.decision_note = note;
      writeIdeaRow_(idea, idea.__row);
      logInfo_('ideas.declined', actor, { idea: ideaId, note: note });
      return { ok: true, message: 'Declined.' };
    }

    // Selected: pay once, keyed by ref so nothing can pay twice.
    var amount = tix_(cfgNum_('IDEA_SELECTED_TICKETS'));
    var ref = 'idea:' + idea.idea_id;
    var already = ticketRows_().some(function (t) { return t.ref === ref; });
    var paid = 0;
    if (amount > 0 && !already && idea.nominator_id) {
      appendTicketRows_([{
        user_id: idea.nominator_id, name: idea.nominator_name, delta: amount, kind: 'idea',
        ref: ref, note: 'your reward idea "' + truncate_(idea.title, 60) + '" was selected', actor: actor
      }]);
      paid = amount;
    }
    idea.status = 'selected';
    idea.decided_ts = iso_(); idea.decided_by = actor; idea.decision_note = note;
    if (podId) idea.pod_id = podId;
    idea.paid_tickets = paid || idea.paid_tickets || '';
    writeIdeaRow_(idea, idea.__row);
    logInfo_('ideas.selected', actor, { idea: ideaId, paid: paid, pod: podId });
    return { ok: true, paid: paid, idea: idea, message: 'Selected' + (paid ? ' — ' + (idea.nominator_name || 'the nominator') + ' earned ' + ticketWord_(paid) + '.' : '.') };
  });

  if (res.ok && res.idea) {
    announceIdeaSelected_(res.idea, res.paid);
    delete res.idea;
  }
  return res;
}

/** A post in the announcement channel and a DM to the nominator. Best effort. */
function announceIdeaSelected_(idea, paid) {
  try {
    var pod = idea.pod_id ? podById_(idea.pod_id) : null;
    var line = ':bulb: *' + escapeSlack_(idea.title) + '* — ' + mention_(idea.nominator_id) + '\'s reward idea was picked' +
      (paid ? ' and earned them *' + ticketWord_(paid) + '*' : '') + '.' +
      (pod && pod.status === 'live' ? ' It is up for grabs now.' : '');
    if (cfgBool_('REWARDS_ANNOUNCE_PODS')) {
      var blocks = [sectionBlock_(SLACK_DIVIDER + '\n' + line)];
      blocks.push(contextBlock_('Got an idea for something worth winning? Nominate it on the rewards site' +
        (portalLink_() ? ' — ' + portalLink_('Ideas tab') : '') + '. Picked ideas earn ' + ticketWord_(cfgNum_('IDEA_SELECTED_TICKETS')) + '.'));
      postMessage_(resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL')), 'Reward idea picked: ' + idea.title, blocks);
    }
    if (cfgBool_('REWARDS_DM_WINNERS') && idea.nominator_id) {
      postMessage_(idea.nominator_id, 'Your reward idea was picked!', [sectionBlock_(SLACK_DIVIDER +
        '\n:bulb: *Your reward idea "' + escapeSlack_(idea.title) + '" was picked.*' +
        (paid ? '\n' + ticketWord_(paid) + ' are in your wallet.' : '') +
        (portalLink_() ? '\n' + portalLink_('Spend them on the rewards site') : ''))]);
    }
  } catch (e) {
    logWarn_('ideas.announce_failed', 'system', String(e));
  }
}

// ---------------------------------------------------------------------------
// For the page
// ---------------------------------------------------------------------------

/** Ideas as the page sees them: voter ids are replaced by a count and "did I vote". */
function ideasForPage_(userId, isAdmin) {
  var roster = getRoster_();
  var pods = {};
  podsAll_().forEach(function (p) { pods[p.pod_id] = p; });
  return ideasAll_().filter(function (i) {
    return i.status !== 'withdrawn' || i.nominator_id === userId;
  }).map(function (i) {
    var r = roster[i.nominator_id];
    var pod = i.pod_id ? pods[i.pod_id] : null;
    var out = {
      idea_id: i.idea_id, title: i.title, details: i.details,
      nominator_id: i.nominator_id,
      nominator: (r && String(r.display_name || r.real_name || '')) || i.nominator_name || 'someone',
      status: i.status, votes: i.votes, voted: !!userId && i.voters.indexOf(userId) !== -1,
      mine: !!userId && i.nominator_id === userId,
      created_ts: i.created_ts, decided_ts: i.decided_ts, decision_note: i.decision_note,
      pod_id: i.pod_id, pod_title: pod ? pod.title : '', pod_phase: pod ? podPhase_(pod) : '',
      paid_tickets: i.paid_tickets
    };
    if (isAdmin) {
      out.voter_names = i.voters.map(function (v) {
        var vr = roster[v];
        return vr ? String(vr.display_name || vr.real_name || v) : v;
      });
    }
    return out;
  }).sort(function (a, b) {
    var rank = { open: 0, selected: 1, declined: 2, withdrawn: 3 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (a.status === 'open' && b.votes !== a.votes) return b.votes - a.votes;
    return tsMs_(b.decided_ts || b.created_ts) - tsMs_(a.decided_ts || a.created_ts);
  });
}
