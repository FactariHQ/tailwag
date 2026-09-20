/**
 * Tail Wag — 13_Rewards.gs
 * The rewards economy: tailwags earn tickets, the org puts up reward pods, and
 * people choose which pods to put their tickets in. More tickets in a pod means
 * better odds in that pod's draw.
 *
 * The model
 * ---------
 * Pods tab     — one row per reward. Status is draft | live | drawn | cancelled;
 *                whether a live pod is "opening soon", "open" or "awaiting draw"
 *                is derived from opens_ts / closes_ts so it can never go stale.
 * Tickets tab  — an append-only wallet ledger. Every row is a signed delta for
 *                one person:
 *                  earn_received / earn_given   +  credited from the tailwag Ledger
 *                  grant                        ±  an admin bonus or correction
 *                  enter                        −  tickets put into a pod
 *                  withdraw                     +  taken back out before close
 *                  refund                       +  pod cancelled, or entrant excluded
 *                A person's available balance is simply the sum of their rows,
 *                and what they have in a pod is minus the sum of that pod's rows.
 *                Nothing is ever edited in place, so the tab is its own audit log.
 * Winners tab  — one row per winner per draw, with the numbers behind it.
 *
 * Tickets are spent at the draw, win or lose: entering debits the wallet
 * immediately, withdrawing is allowed until the pod closes, and the draw simply
 * leaves the debits where they are.
 *
 * Earning ("accrual")
 * -------------------
 * Tickets are derived from the tailwag Ledger, but only rows given on or after
 * REWARDS_LAUNCH_TS count (the fresh start). Accrual copies each qualifying
 * Ledger row into Tickets at the CURRENT rate, and a cursor remembers how far it
 * got — so changing TICKETS_PER_WAG_RECEIVED only affects tailwags not yet
 * credited, never the history. Until a row is credited, wallets include it as
 * "pending" at the current rate, so every reader (the portal, /wags, App Home)
 * shows the true balance without having to write anything.
 *
 * Who writes
 * ----------
 * Only the rewards portal project writes the rewards tabs. The Slack project
 * shares the spreadsheet but only reads them. That keeps every write behind one
 * script lock, because LockService locks are per Apps Script project.
 */

var POD_STATUSES = ['draft', 'live', 'drawn', 'cancelled'];
var TICKET_KINDS = ['earn_received', 'earn_given', 'grant', 'enter', 'withdraw', 'refund'];

// Per-execution memo; the tabs are read once per request at most.
var __rw = { tickets: null, pods: null, winners: null };

/** Forgets the per-execution memo after a write. */
function rewardsCacheDrop_() {
  __rw = { tickets: null, pods: null, winners: null };
}

/** Epoch ms from whatever a cell hands back: Date, number, ISO string or blank. */
function tsMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return 0;
  var t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

/** ISO string for a cell value, or '' when blank. */
function tsIso_(v) {
  var ms = tsMs_(v);
  return ms ? new Date(ms).toISOString() : '';
}

/** Rounds a ticket amount to 2 dp so fractional earn rates stay tidy. */
function tix_(n) {
  return Math.round(num_(n) * 100) / 100;
}

function isTrue_(v) {
  return v === true || String(v).trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every Tickets row, normalized. */
function ticketRows_() {
  if (__rw.tickets) return __rw.tickets;
  __rw.tickets = readSheet_(SHEETS.TICKETS).map(function (r) {
    return {
      id: String(r.id || ''),
      ts: tsIso_(r.ts_iso),
      user_id: String(r.user_id || '').trim(),
      name: String(r.name || ''),
      delta: tix_(r.delta),
      kind: String(r.kind || '').trim(),
      pod_id: String(r.pod_id || '').trim(),
      ref: String(r.ref || '').trim(),
      note: String(r.note || ''),
      actor: String(r.actor || '')
    };
  }).filter(function (r) { return r.user_id; });
  return __rw.tickets;
}

/** Every pod, normalized, in display order. */
function podsAll_() {
  if (__rw.pods) return __rw.pods;
  __rw.pods = readSheet_(SHEETS.PODS).map(podFromRow_).filter(function (p) { return p.pod_id; });
  __rw.pods.sort(function (a, b) {
    if (a.sort !== b.sort) return a.sort - b.sort;
    return tsMs_(a.closes_ts) - tsMs_(b.closes_ts);
  });
  return __rw.pods;
}

function podFromRow_(r) {
  var status = String(r.status || 'draft').trim().toLowerCase();
  if (POD_STATUSES.indexOf(status) === -1) status = 'draft';
  return {
    pod_id: String(r.pod_id || '').trim(),
    title: String(r.title || ''),
    description: String(r.description || ''),
    emoji: String(r.emoji || '🎁'),
    image_url: String(r.image_url || ''),
    prize_value: String(r.prize_value || ''),
    winners_count: Math.max(1, Math.floor(num_(r.winners_count) || 1)),
    max_tickets_per_person: Math.max(0, Math.floor(num_(r.max_tickets_per_person))),
    opens_ts: tsIso_(r.opens_ts),
    closes_ts: tsIso_(r.closes_ts),
    status: status,
    announced_ts: tsIso_(r.announced_ts),
    reminded_ts: tsIso_(r.reminded_ts),
    drawn_ts: tsIso_(r.drawn_ts),
    created_by: String(r.created_by || ''),
    created_ts: tsIso_(r.created_ts),
    updated_ts: tsIso_(r.updated_ts),
    sort: num_(r.sort),
    __row: r.__row
  };
}

/** One pod by id, or null. */
function podById_(podId) {
  var id = String(podId || '').trim();
  var hit = podsAll_().filter(function (p) { return p.pod_id === id; });
  return hit.length ? hit[0] : null;
}

/**
 * Where a pod is in its life, as people see it.
 *   draft     — only admins can see it
 *   soon      — live, not open yet
 *   open      — live, taking tickets
 *   closed    — live, past its close time, waiting for the draw
 *   drawn / cancelled
 */
function podPhase_(pod, atMs) {
  if (pod.status !== 'live') return pod.status;
  var t = atMs || now_().getTime();
  var opens = tsMs_(pod.opens_ts);
  var closes = tsMs_(pod.closes_ts);
  if (opens && t < opens) return 'soon';
  if (closes && t >= closes) return 'closed';
  return 'open';
}

/** Every Winners row, normalized. */
function winnerRows_() {
  if (__rw.winners) return __rw.winners;
  __rw.winners = readSheet_(SHEETS.WINNERS).map(function (r) {
    return {
      pod_id: String(r.pod_id || '').trim(),
      pod_title: String(r.pod_title || ''),
      place: Math.floor(num_(r.place)) || 1,
      user_id: String(r.user_id || '').trim(),
      name: String(r.name || ''),
      tickets_in: tix_(r.tickets_in),
      pod_total_tickets: tix_(r.pod_total_tickets),
      entrants: Math.floor(num_(r.entrants)),
      drawn_ts: tsIso_(r.drawn_ts),
      draw_roll: num_(r.draw_roll),
      fulfilled: isTrue_(r.fulfilled),
      fulfilled_ts: tsIso_(r.fulfilled_ts),
      fulfilled_by: String(r.fulfilled_by || ''),
      notes: String(r.notes || ''),
      __row: r.__row
    };
  }).filter(function (w) { return w.pod_id; });
  return __rw.winners;
}

// ---------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------

/** Launch moment in ms; 0 means rewards have not been set up. */
function rewardsLaunchMs_() {
  return tsMs_(cfgStr_('REWARDS_LAUNCH_TS'));
}

/**
 * True once setupRewards() has run and rewards are switched on. Until then
 * nothing earns, nothing is pending, and the job does nothing — an empty launch
 * time must never be read as "count the whole history".
 */
function rewardsLive_() {
  return cfgBool_('REWARDS_ENABLED') && rewardsLaunchMs_() > 0;
}

/**
 * True when this Apps Script project is the one that owns the rewards tabs
 * (the portal project, recorded by setupRewards). Every rewards write checks
 * it: the Slack project shares the spreadsheet but holds a different script
 * lock, so a write from there could race one from the portal.
 */
function isRewardsProject_() {
  var owner = cfgStr_('REWARDS_JOB_SCRIPT_ID');
  var me = '';
  try { me = ScriptApp.getScriptId(); } catch (e) { me = ''; }
  return !!owner && !!me && owner === me;
}

/** The refusal every write path returns outside the rewards project. */
function notRewardsProject_() {
  return { ok: false, error: 'Rewards can only be changed from the Tail Wag Rewards site.' };
}

/** Forces the next config and Tickets reads to come from the sheet. */
function freshRewardsRead_() {
  rewardsCacheDrop_();
  __configCache = null;
  cacheDrop_('config');
}

/**
 * The ticket credits owed for tailwags that have not been credited yet, at the
 * current earn rates. Pure — writes nothing.
 * @return {{credits:Array<Object>, cursor:?{row:number,id:string}}}
 */
function pendingCredits_() {
  if (!rewardsLive_()) return { credits: [], cursor: parseCursor_(cfgStr_('REWARDS_ACCRUAL_CURSOR')) };
  var launch = rewardsLaunchMs_();
  var rateRecv = num_(cfgNum_('TICKETS_PER_WAG_RECEIVED'));
  var rateGive = num_(cfgNum_('TICKETS_PER_WAG_GIVEN'));
  var cursor = parseCursor_(cfgStr_('REWARDS_ACCRUAL_CURSOR'));
  var ledger = ledgerAfterCursor_(cursor);

  var seen = {};
  ticketRows_().forEach(function (t) { if (t.ref) seen[t.ref] = true; });

  var credits = [];
  var last = cursor;
  for (var j = 0; j < ledger.length; j++) {
    var r = ledger[j];
    var id = ledgerRowId_(r);
    last = { row: r.__row, id: id };
    var dots = num_(r.dots);
    if (dots <= 0) continue;
    var ts = tsMs_(r.ts_iso);
    if (launch && ts && ts < launch) continue;
    if (launch && !ts) continue;

    var recvId = String(r.receiver_id || '').trim();
    var giverId = String(r.giver_id || '').trim();
    if (recvId && rateRecv > 0 && !seen['recv:' + id]) {
      credits.push({
        user_id: recvId, name: String(r.receiver_name || recvId), delta: tix_(dots * rateRecv),
        kind: 'earn_received', ref: 'recv:' + id, ts: tsIso_(r.ts_iso),
        note: dots + ' ' + wagWord_(dots) + ' from ' + String(r.giver_name || giverId)
      });
    }
    if (giverId && rateGive > 0 && String(r.source) !== 'admin' && !seen['give:' + id]) {
      credits.push({
        user_id: giverId, name: String(r.giver_name || giverId), delta: tix_(dots * rateGive),
        kind: 'earn_given', ref: 'give:' + id, ts: tsIso_(r.ts_iso),
        note: 'gave ' + dots + ' ' + wagWord_(dots) + ' to ' + String(r.receiver_name || recvId)
      });
    }
  }
  return { credits: credits, cursor: last };
}

/** "412|od_abc" → {row:412, id:'od_abc'}; anything else → null. */
function parseCursor_(s) {
  var m = String(s || '').match(/^(\d+)\|(.+)$/);
  return m ? { row: parseInt(m[1], 10), id: m[2] } : null;
}

function formatCursor_(c) {
  return c ? c.row + '|' + c.id : '';
}

/**
 * Ledger rows after the accrual cursor, read as a tail rather than the whole
 * tab — the Ledger only grows, and /wags rewards has Slack's three seconds.
 * If the cursor row no longer holds the id it remembers (someone deleted rows
 * by hand), fall back to the whole Ledger; the ref check in pendingCredits_
 * still stops anything being credited twice.
 */
function ledgerAfterCursor_(cursor) {
  var sh = sheet_(SHEETS.LEDGER);
  var last = sh.getLastRow();
  if (last < 2) return [];
  if (!cursor || cursor.row < 2 || cursor.row > last) return readSheet_(SHEETS.LEDGER);

  var head = headerOf_(SHEETS.LEDGER);
  var idCol = head.index.id;
  if (idCol === undefined) return readSheet_(SHEETS.LEDGER);
  var at = String(sh.getRange(cursor.row, idCol + 1).getValue()).trim() || ('row' + cursor.row);
  if (at !== cursor.id) return readSheet_(SHEETS.LEDGER);
  if (cursor.row === last) return [];

  var width = head.order.length;
  var values = sh.getRange(cursor.row + 1, 1, last - cursor.row, width).getValues();
  var out = [];
  values.forEach(function (v, i) {
    var row = {};
    var empty = true;
    for (var c = 0; c < width; c++) {
      if (!head.order[c]) continue;
      row[head.order[c]] = v[c];
      if (v[c] !== '' && v[c] !== null) empty = false;
    }
    if (empty) return;
    row.__row = cursor.row + 1 + i;
    out.push(row);
  });
  return out;
}

/** A stable id for a Ledger row, even for rows written before ids existed. */
function ledgerRowId_(r) {
  var id = String(r.id || '').trim();
  return id || ('row' + r.__row);
}

/**
 * Credits every pending tailwag into the Tickets tab and moves the cursor.
 * Must run under the rewards lock (callers use withLock_).
 * @return {number} rows credited
 */
function accrueTickets_() {
  if (!isRewardsProject_()) return 0;
  // Always from the sheet: a cursor or Tickets snapshot read earlier in this
  // execution (before the lock was taken) would credit a tailwag twice.
  freshRewardsRead_();
  if (!rewardsLive_()) return 0;
  var p = pendingCredits_();
  if (p.credits.length) {
    appendTicketRows_(p.credits.map(function (c) {
      return {
        user_id: c.user_id, name: c.name, delta: c.delta, kind: c.kind, ts_iso: c.ts,
        pod_id: '', ref: c.ref, note: c.note, actor: 'system'
      };
    }));
  }
  var next = formatCursor_(p.cursor);
  if (next && next !== cfgStr_('REWARDS_ACCRUAL_CURSOR')) setConfig_('REWARDS_ACCRUAL_CURSOR', next);
  return p.credits.length;
}

/** Appends several Tickets rows in one write. */
function appendTicketRows_(rows) {
  if (!rows.length) return;
  var sh = sheet_(SHEETS.TICKETS);
  var cols = headerOf_(SHEETS.TICKETS).order;
  var ts = iso_();
  var matrix = rows.map(function (r) {
    var full = {
      id: r.id || ('tk_' + Utilities.getUuid().replace(/-/g, '').slice(0, 14)),
      ts_iso: r.ts_iso || ts,
      user_id: r.user_id, name: r.name || '', delta: tix_(r.delta), kind: r.kind,
      pod_id: r.pod_id || '', ref: r.ref || '', note: r.note || '', actor: r.actor || ''
    };
    return cols.map(function (c) {
      var v = c ? full[c] : '';
      return sanitizeCell_(v === undefined || v === null ? '' : v);
    });
  });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, matrix.length, cols.length).setValues(matrix);
  __rw.tickets = null;
}

// ---------------------------------------------------------------------------
// Wallets and pod totals
// ---------------------------------------------------------------------------

/**
 * Everyone's wallet at once, including pending credits.
 * @return {Object<string, Object>} user_id → wallet
 */
function allWallets_() {
  var wallets = {};
  function w(id, name) {
    if (!wallets[id]) {
      wallets[id] = {
        user_id: id, name: name || id,
        available: 0, earned: 0, granted: 0, pending: 0,
        inPlay: 0, spent: 0, refunded: 0, byPod: {}
      };
    }
    if (name && wallets[id].name === id) wallets[id].name = name;
    return wallets[id];
  }
  var pods = {};
  podsAll_().forEach(function (p) { pods[p.pod_id] = p; });

  ticketRows_().forEach(function (t) {
    var x = w(t.user_id, t.name);
    x.available = tix_(x.available + t.delta);
    if (t.kind === 'earn_received' || t.kind === 'earn_given') x.earned = tix_(x.earned + t.delta);
    if (t.kind === 'grant') x.granted = tix_(x.granted + t.delta);
    if (t.kind === 'refund') x.refunded = tix_(x.refunded + t.delta);
    if (t.pod_id && (t.kind === 'enter' || t.kind === 'withdraw' || t.kind === 'refund')) {
      x.byPod[t.pod_id] = tix_((x.byPod[t.pod_id] || 0) - t.delta);
    }
  });

  pendingCredits_().credits.forEach(function (c) {
    var x = w(c.user_id, c.name);
    x.pending = tix_(x.pending + c.delta);
    x.available = tix_(x.available + c.delta);
    x.earned = tix_(x.earned + c.delta);
  });

  Object.keys(wallets).forEach(function (id) {
    var x = wallets[id];
    Object.keys(x.byPod).forEach(function (pid) {
      var n = x.byPod[pid];
      if (n <= 0) { delete x.byPod[pid]; return; }
      var pod = pods[pid];
      if (pod && pod.status === 'drawn') x.spent = tix_(x.spent + n);
      else x.inPlay = tix_(x.inPlay + n);
    });
    // Whole tickets are what can be entered; fractions accumulate quietly.
    x.spendable = Math.floor(x.available + 1e-9);
  });
  return wallets;
}

/** One person's wallet (an empty one if they have never earned). */
function walletFor_(userId) {
  var all = allWallets_();
  return all[userId] || {
    user_id: userId, name: userId, available: 0, spendable: 0, earned: 0, granted: 0,
    pending: 0, inPlay: 0, spent: 0, refunded: 0, byPod: {}
  };
}

/**
 * Tickets in each pod, and who put them there.
 * @return {Object<string,{total:number, entrants:number, byUser:Object<string,number>}>}
 */
function podTotals_() {
  var out = {};
  ticketRows_().forEach(function (t) {
    if (!t.pod_id || (t.kind !== 'enter' && t.kind !== 'withdraw' && t.kind !== 'refund')) return;
    if (!out[t.pod_id]) out[t.pod_id] = { total: 0, entrants: 0, byUser: {}, names: {} };
    var o = out[t.pod_id];
    o.byUser[t.user_id] = tix_((o.byUser[t.user_id] || 0) - t.delta);
    if (t.name) o.names[t.user_id] = t.name;
  });
  Object.keys(out).forEach(function (pid) {
    var o = out[pid];
    var total = 0;
    var entrants = 0;
    Object.keys(o.byUser).forEach(function (uid) {
      if (o.byUser[uid] <= 0) { delete o.byUser[uid]; return; }
      total += o.byUser[uid];
      entrants++;
    });
    o.total = tix_(total);
    o.entrants = entrants;
  });
  return out;
}

function emptyTotals_() {
  return { total: 0, entrants: 0, byUser: {}, names: {} };
}

// ---------------------------------------------------------------------------
// Entering and withdrawing
// ---------------------------------------------------------------------------

/**
 * Sets how many tickets a person has in a pod, entering or withdrawing the
 * difference. The one write path behind the portal's +/- controls.
 *
 * @param {string} userId
 * @param {string} name
 * @param {string} podId
 * @param {number} target the number of tickets they want in the pod
 * @return {{ok:boolean, error?:string, message?:string, inPod?:number, available?:number}}
 */
function setAllocation_(userId, name, podId, target) {
  if (!isRewardsProject_()) return notRewardsProject_();
  if (!rewardsLive_()) return { ok: false, error: 'Rewards are switched off right now.' };
  target = Math.floor(num_(target));
  if (target < 0 || !isFinite(target)) return { ok: false, error: 'That is not a number of tickets.' };

  return withLock_(function () {
    accrueTickets_();
    rewardsCacheDrop_();
    var pod = podById_(podId);
    if (!pod || pod.status === 'draft') return { ok: false, error: 'That reward does not exist.' };
    var phase = podPhase_(pod);
    if (phase === 'soon') return { ok: false, error: 'This reward opens ' + prettyWhen_(pod.opens_ts) + '.' };
    if (phase !== 'open') return { ok: false, error: 'This reward is closed — tickets can no longer be moved.' };

    var wallet = walletFor_(userId);
    var current = wallet.byPod[podId] || 0;
    var diff = target - current;
    if (diff === 0) return { ok: true, inPod: current, available: wallet.available, message: 'No change.' };

    if (diff > 0) {
      if (pod.max_tickets_per_person > 0 && target > pod.max_tickets_per_person) {
        return { ok: false, error: 'This reward takes at most ' + pod.max_tickets_per_person + ' tickets per person.' };
      }
      if (diff > wallet.spendable) {
        return { ok: false, error: 'You have ' + wallet.spendable + ' ticket' + (wallet.spendable === 1 ? '' : 's') + ' available.' };
      }
      appendTicketRows_([{
        user_id: userId, name: name, delta: -diff, kind: 'enter', pod_id: podId,
        note: 'entered ' + diff + ' into ' + pod.title, actor: userId
      }]);
    } else {
      appendTicketRows_([{
        user_id: userId, name: name, delta: -diff, kind: 'withdraw', pod_id: podId,
        note: 'withdrew ' + (-diff) + ' from ' + pod.title, actor: userId
      }]);
    }
    logInfo_('rewards.allocate', userId, { pod: podId, from: current, to: target });
    var after = walletFor_(userId);
    return {
      ok: true, inPod: after.byPod[podId] || 0, available: after.available,
      message: diff > 0
        ? 'Entered ' + diff + ' ticket' + (diff === 1 ? '' : 's') + ' into ' + pod.title + '.'
        : 'Took ' + (-diff) + ' ticket' + (diff === -1 ? '' : 's') + ' back from ' + pod.title + '.'
    };
  });
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

/**
 * Creates or updates a pod. Fields that would change the odds after people have
 * entered (the close time moving earlier, the ticket cap dropping below what
 * someone already has in) are refused rather than silently applied.
 * @param {Object} input
 * @param {string} actor
 */
function savePod_(input, actor) {
  if (!isRewardsProject_()) return notRewardsProject_();
  input = input || {};
  var title = String(input.title || '').trim();
  if (!title) return { ok: false, error: 'A reward needs a title.' };
  var closes = tsMs_(input.closes_ts);
  var opens = tsMs_(input.opens_ts);
  if (!closes) return { ok: false, error: 'Pick when the reward closes and draws.' };
  if (opens && opens >= closes) return { ok: false, error: 'It has to open before it closes.' };
  var winners = Math.max(1, Math.floor(num_(input.winners_count) || 1));
  var cap = Math.max(0, Math.floor(num_(input.max_tickets_per_person)));

  return withLock_(function () {
    rewardsCacheDrop_();
    var existing = input.pod_id ? podById_(input.pod_id) : null;
    if (input.pod_id && !existing) return { ok: false, error: 'That reward no longer exists.' };
    if (existing && (existing.status === 'drawn' || existing.status === 'cancelled')) {
      return { ok: false, error: 'A ' + existing.status + ' reward cannot be edited.' };
    }
    var nowMs = now_().getTime();
    var goingLive = (existing ? existing.status === 'live' : false) || input.publish === true;
    if (goingLive && closes <= nowMs) return { ok: false, error: 'The close time has already passed.' };
    if (existing && existing.status === 'live') {
      var totals = podTotals_()[existing.pod_id] || emptyTotals_();
      if (totals.entrants > 0) {
        // People chose to enter on the terms they saw. Moving the draw earlier,
        // or pushing the opening into the future (which locks their tickets in
        // "opening soon"), changes those terms under them.
        if (closes < tsMs_(existing.closes_ts)) {
          return { ok: false, error: 'People have entered already, so the draw can only move later, not earlier. Cancel and refund instead.' };
        }
        if (opens !== tsMs_(existing.opens_ts) && opens > nowMs) {
          return { ok: false, error: 'People have entered already, so the opening time cannot move into the future.' };
        }
      }
      if (cap > 0) {
        var over = Object.keys(totals.byUser).filter(function (u) { return totals.byUser[u] > cap; });
        if (over.length) {
          return { ok: false, error: over.length + ' ' + (over.length === 1 ? 'person has' : 'people have') +
            ' more than ' + cap + ' tickets in already. Raise the cap or leave it.' };
        }
      }
    }

    var status = existing ? existing.status : 'draft';
    if (input.publish === true && status === 'draft') status = 'live';

    var row = {
      pod_id: existing ? existing.pod_id : 'pod_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
      title: title,
      description: String(input.description || '').trim(),
      emoji: String(input.emoji || '🎁').trim() || '🎁',
      image_url: safeUrl_(input.image_url),
      prize_value: String(input.prize_value || '').trim(),
      winners_count: winners,
      max_tickets_per_person: cap,
      opens_ts: opens ? new Date(opens).toISOString() : '',
      closes_ts: new Date(closes).toISOString(),
      status: status,
      announced_ts: existing ? existing.announced_ts : '',
      reminded_ts: existing && tsMs_(existing.closes_ts) === closes ? existing.reminded_ts : '',
      drawn_ts: '',
      created_by: existing ? existing.created_by : actor,
      created_ts: existing ? existing.created_ts : iso_(),
      updated_ts: iso_(),
      sort: num_(input.sort) || (existing ? existing.sort : 0)
    };
    writePodRow_(row, existing ? existing.__row : 0);
    logInfo_(existing ? 'rewards.pod_updated' : 'rewards.pod_created', actor, { pod: row.pod_id, title: title, status: status });
    return { ok: true, pod_id: row.pod_id, message: (existing ? 'Saved ' : 'Created ') + title + (status === 'live' ? ' (live).' : ' (draft).') };
  });
}

/** Only http(s) image links are kept; anything else would be an XSS vector. */
function safeUrl_(u) {
  var s = String(u || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

/** Writes a pod object to its row (or a new row), by live header order. */
function writePodRow_(pod, rowNum) {
  var sh = sheet_(SHEETS.PODS);
  var cols = headerOf_(SHEETS.PODS).order;
  var values = cols.map(function (c) {
    var v = c ? pod[c] : '';
    return sanitizeCell_(v === undefined || v === null ? '' : v);
  });
  if (rowNum) {
    // Confirm the row still holds this pod before overwriting it.
    var at = cols.indexOf('pod_id');
    var occupant = String(sh.getRange(rowNum, at + 1).getValue()).trim();
    if (occupant !== pod.pod_id) rowNum = 0;
  }
  if (!rowNum) rowNum = sh.getLastRow() + 1;
  sh.getRange(rowNum, 1, 1, cols.length).setValues([values]);
  __rw.pods = null;
}

/** Sets individual fields on a pod row. */
function patchPod_(pod, fields) {
  var merged = {};
  Object.keys(pod).forEach(function (k) { merged[k] = pod[k]; });
  Object.keys(fields).forEach(function (k) { merged[k] = fields[k]; });
  merged.updated_ts = iso_();
  writePodRow_(merged, pod.__row);
  return merged;
}

/** Moves a draft pod live. */
function publishPod_(podId, actor) {
  if (!isRewardsProject_()) return notRewardsProject_();
  return withLock_(function () {
    rewardsCacheDrop_();
    var pod = podById_(podId);
    if (!pod) return { ok: false, error: 'That reward no longer exists.' };
    if (pod.status !== 'draft') return { ok: false, error: 'Only a draft can be published.' };
    if (tsMs_(pod.closes_ts) <= now_().getTime()) return { ok: false, error: 'Its close time has already passed — edit it first.' };
    patchPod_(pod, { status: 'live' });
    logInfo_('rewards.pod_published', actor, { pod: podId });
    return { ok: true, message: pod.title + ' is live.' };
  });
}

/** Cancels a pod and refunds every ticket in it. */
function cancelPod_(podId, actor, reason) {
  if (!isRewardsProject_()) return notRewardsProject_();
  return withLock_(function () {
    rewardsCacheDrop_();
    var pod = podById_(podId);
    if (!pod) return { ok: false, error: 'That reward no longer exists.' };
    if (pod.status === 'drawn' || pod.status === 'cancelled') return { ok: false, error: 'It is already ' + pod.status + '.' };
    var totals = podTotals_()[podId] || emptyTotals_();
    var refunds = Object.keys(totals.byUser).map(function (uid) {
      return {
        user_id: uid, name: totals.names[uid] || uid, delta: totals.byUser[uid], kind: 'refund',
        pod_id: podId, note: 'refund — ' + pod.title + ' was cancelled' + (reason ? ': ' + reason : ''), actor: actor
      };
    });
    appendTicketRows_(refunds);
    patchPod_(pod, { status: 'cancelled' });
    logWarn_('rewards.pod_cancelled', actor, { pod: podId, refunded: totals.total, people: refunds.length });
    return { ok: true, message: pod.title + ' cancelled. Refunded ' + totals.total + ' tickets to ' + refunds.length + ' ' + (refunds.length === 1 ? 'person' : 'people') + '.' };
  });
}

/** Grants (or, with a negative amount, removes) bonus tickets. */
function grantTickets_(userIds, amount, note, actor) {
  if (!isRewardsProject_()) return notRewardsProject_();
  amount = tix_(amount);
  if (!amount) return { ok: false, error: 'Grant a non-zero number of tickets.' };
  if (!userIds || !userIds.length) return { ok: false, error: 'Pick at least one person.' };
  note = String(note || '').trim();
  if (note.length < 3) return { ok: false, error: 'Say why — it shows in their ticket history.' };
  return withLock_(function () {
    accrueTickets_();
    rewardsCacheDrop_();
    var roster = getRoster_();
    if (amount < 0) {
      var wallets = allWallets_();
      var short = userIds.filter(function (u) { return (wallets[u] ? wallets[u].available : 0) + amount < 0; });
      if (short.length) return { ok: false, error: 'That would take ' + short.length + ' ' + (short.length === 1 ? 'person' : 'people') + ' below zero available tickets.' };
    }
    appendTicketRows_(userIds.map(function (uid) {
      var r = roster[uid];
      return {
        user_id: uid, name: r ? String(r.display_name || r.real_name || uid) : uid,
        delta: amount, kind: 'grant', note: note, actor: actor
      };
    }));
    logWarn_('rewards.grant', actor, { users: userIds, amount: amount, note: note });
    return { ok: true, message: (amount > 0 ? 'Granted ' : 'Removed ') + Math.abs(amount) + ' ticket' + (Math.abs(amount) === 1 ? '' : 's') + (amount > 0 ? ' to ' : ' from ') + userIds.length + ' ' + (userIds.length === 1 ? 'person' : 'people') + '.' };
  });
}

/** Marks a prize as handed over. */
function markFulfilled_(podId, userId, actor, fulfilled) {
  if (!isRewardsProject_()) return notRewardsProject_();
  return withLock_(function () {
    rewardsCacheDrop_();
    var hit = winnerRows_().filter(function (w) { return w.pod_id === podId && w.user_id === userId; });
    if (!hit.length) return { ok: false, error: 'No such winner.' };
    var sh = sheet_(SHEETS.WINNERS);
    var cols = headerOf_(SHEETS.WINNERS).index;
    var on = fulfilled !== false;
    sh.getRange(hit[0].__row, cols.fulfilled + 1).setValue(on);
    sh.getRange(hit[0].__row, cols.fulfilled_ts + 1).setValue(on ? iso_() : '');
    sh.getRange(hit[0].__row, cols.fulfilled_by + 1).setValue(on ? actor : '');
    __rw.winners = null;
    logInfo_('rewards.fulfilled', actor, { pod: podId, user: userId, fulfilled: on });
    return { ok: true, message: on ? 'Marked as delivered.' : 'Marked as not yet delivered.' };
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Draws a pod. Winners are picked weighted by tickets, without replacement, so
 * nobody wins the same pod twice. Everyone's tickets in the pod are spent.
 *
 * @param {string} podId
 * @param {string} actor 'system' for scheduled draws
 * @param {boolean} early allow drawing before the close time (admin "draw now")
 */
function drawPod_(podId, actor, early) {
  if (!isRewardsProject_()) return notRewardsProject_();
  return withLock_(function () {
    accrueTickets_();
    rewardsCacheDrop_();
    var pod = podById_(podId);
    if (!pod) return { ok: false, error: 'That reward no longer exists.' };
    if (pod.status !== 'live') return { ok: false, error: 'Only a live reward can be drawn (this one is ' + pod.status + ').' };
    var phase = podPhase_(pod);
    if (phase !== 'closed' && !early) return { ok: false, error: 'It has not closed yet.' };

    var totals = podTotals_()[podId] || emptyTotals_();
    var roster = getRoster_();
    var pool = Object.keys(totals.byUser).map(function (uid) {
      var r = roster[uid];
      var name = (r && String(r.display_name || r.real_name || '')) || totals.names[uid] || uid;
      return { user_id: uid, name: name, entries: totals.byUser[uid] };
    });

    // Optional cooling-off: recent winners are refunded and sit this one out.
    var excludeDays = num_(cfgNum_('REWARDS_EXCLUDE_RECENT_WINNERS_DAYS'));
    var refunds = [];
    if (excludeDays > 0) {
      var since = now_().getTime() - excludeDays * 86400000;
      var recent = {};
      winnerRows_().forEach(function (w) { if (tsMs_(w.drawn_ts) >= since) recent[w.user_id] = true; });
      pool = pool.filter(function (p) {
        if (!recent[p.user_id]) return true;
        refunds.push({
          user_id: p.user_id, name: p.name, delta: p.entries, kind: 'refund', pod_id: podId,
          note: 'refund — recent winners sit out ' + pod.title, actor: 'system'
        });
        return false;
      });
      appendTicketRows_(refunds);
    }

    var totalTickets = 0;
    pool.forEach(function (p) { totalTickets += p.entries; });
    totalTickets = tix_(totalTickets);

    var want = Math.min(pod.winners_count, pool.length);
    var picked = drawWeightedWithRolls_(pool, want);
    var drawnAt = iso_();

    if (picked.length) {
      var sh = sheet_(SHEETS.WINNERS);
      var cols = headerOf_(SHEETS.WINNERS).order;
      var matrix = picked.map(function (p, i) {
        var row = {
          pod_id: podId, pod_title: pod.title, place: i + 1, user_id: p.row.user_id, name: p.row.name,
          tickets_in: p.row.entries, pod_total_tickets: totalTickets, entrants: pool.length,
          drawn_ts: drawnAt, draw_roll: Math.round(p.roll * 1e6) / 1e6, fulfilled: false,
          fulfilled_ts: '', fulfilled_by: '', notes: ''
        };
        return cols.map(function (c) {
          var v = c ? row[c] : '';
          return sanitizeCell_(v === undefined || v === null ? '' : v);
        });
      });
      sh.getRange(sh.getLastRow() + 1, 1, matrix.length, cols.length).setValues(matrix);
      __rw.winners = null;
    }
    patchPod_(pod, { status: 'drawn', drawn_ts: drawnAt });

    var winners = picked.map(function (p) {
      return { user_id: p.row.user_id, name: p.row.name, entries: p.row.entries };
    });
    logInfo_('rewards.drawn', actor, { pod: podId, winners: winners.map(function (w) { return w.user_id; }), totalTickets: totalTickets, entrants: pool.length });

    announceDraw_(pod, winners, totalTickets, pool.length);

    return {
      ok: true,
      winners: winners,
      message: winners.length
        ? 'Drew ' + winners.map(function (w) { return w.name; }).join(', ') + ' from ' + totalTickets + ' tickets.'
        : 'Nobody entered ' + pod.title + ', so there was no winner.'
    };
  }, 30000);
}

/**
 * drawWeighted_ with the roll kept, so the Winners tab can show the number that
 * picked each person — the draw is auditable after the fact.
 */
function drawWeightedWithRolls_(rows, n) {
  var remaining = rows.slice();
  var picked = [];
  for (var k = 0; k < n && remaining.length; k++) {
    var total = 0;
    remaining.forEach(function (r) { total += num_(r.entries); });
    if (total <= 0) break;
    var roll = random_();
    var target = roll * total;
    var acc = 0;
    var chosen = remaining.length - 1;
    for (var i = 0; i < remaining.length; i++) {
      acc += num_(remaining[i].entries);
      if (target < acc) { chosen = i; break; }
    }
    picked.push({ row: remaining[chosen], roll: roll });
    remaining.splice(chosen, 1);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Slack posts
// ---------------------------------------------------------------------------

function portalLink_(label) {
  var url = cfgStr_('REWARDS_PORTAL_URL');
  return url ? '<' + url + '|' + (label || 'Open the rewards site') + '>' : '';
}

function prettyWhen_(iso) {
  var ms = tsMs_(iso);
  return ms ? fmt_(new Date(ms), "EEE MMM d 'at' h:mm a") : 'soon';
}

/** Header line on every Slack post, per ACT house style. */
var SLACK_DIVIDER = '=========================================================';

function announceDraw_(pod, winners, totalTickets, entrants) {
  if (!cfgBool_('REWARDS_ANNOUNCE_PODS')) return;
  try {
    var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
    var head = SLACK_DIVIDER + '\n' + pod.emoji + ' *' + escapeSlack_(pod.title) + '* has been drawn';
    var body = winners.length
      ? winners.map(function (w, i) {
        return (winners.length > 1 ? ordinal_(i + 1) + ' ' : '') + ':tada: ' + mention_(w.user_id) +
          ' — ' + w.entries + ' ticket' + (w.entries === 1 ? '' : 's') + ' in';
      }).join('\n')
      : '_Nobody entered, so nobody won this one._';
    var blocks = [
      sectionBlock_(head),
      sectionBlock_(body + (pod.prize_value ? '\n\nPrize: *' + escapeSlack_(pod.prize_value) + '*' : '')),
      contextBlock_('Drawn from ' + totalTickets + ' tickets across ' + entrants + ' ' +
        (entrants === 1 ? 'person' : 'people') + '. More tickets in, better odds — every tailwag you receive is a ticket.' +
        (portalLink_() ? '  ·  ' + portalLink_('See what is up for grabs next') : ''))
    ];
    postMessage_(channel, pod.title + ' drawn: ' + winners.map(function (w) { return w.name; }).join(', '), blocks);

    if (cfgBool_('REWARDS_DM_WINNERS') && winners.length) {
      slackApiAll_(winners.map(function (w) {
        return {
          method: 'chat.postMessage',
          payload: {
            channel: w.user_id,
            text: 'You won ' + pod.title + '!',
            blocks: [sectionBlock_(SLACK_DIVIDER + '\n:tada: *You won ' + escapeSlack_(pod.title) + '* ' + pod.emoji +
              '\nYou had ' + w.entries + ' of the ' + totalTickets + ' tickets in the draw.' +
              (pod.prize_value ? '\nPrize: *' + escapeSlack_(pod.prize_value) + '*' : '') +
              '\nSomeone from the team will be in touch to get it to you.')]
          }
        };
      }));
    }
  } catch (e) {
    logError_('rewards.announce_failed', 'system', String(e && e.stack || e));
  }
}

function announcePodOpen_(pod) {
  var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
  var lines = [SLACK_DIVIDER, pod.emoji + ' *New reward: ' + escapeSlack_(pod.title) + '*'];
  if (pod.description) lines.push(escapeSlack_(truncate_(pod.description, 400)));
  if (pod.prize_value) lines.push('Prize: *' + escapeSlack_(pod.prize_value) + '*' +
    (pod.winners_count > 1 ? '  ·  ' + pod.winners_count + ' winners' : ''));
  lines.push('Draws ' + prettyWhen_(pod.closes_ts) + '. Put your tickets in — more tickets, better odds.');
  var blocks = [sectionBlock_(lines.join('\n'))];
  if (portalLink_()) blocks.push(contextBlock_(portalLink_('Enter your tickets')));
  return postMessage_(channel, 'New reward: ' + pod.title, blocks);
}

function announcePodClosing_(pod, totals) {
  var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
  var blocks = [sectionBlock_(SLACK_DIVIDER + '\n:hourglass_flowing_sand: *' + escapeSlack_(pod.title) +
    '* draws ' + prettyWhen_(pod.closes_ts) + '. ' + totals.total + ' tickets in from ' + totals.entrants + ' ' +
    (totals.entrants === 1 ? 'person' : 'people') + ' so far.')];
  if (portalLink_()) blocks.push(contextBlock_(portalLink_('Last chance to move your tickets')));
  return postMessage_(channel, pod.title + ' draws soon', blocks);
}

// ---------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------

/**
 * Every 15 minutes: credit new tailwags, announce pods that have opened, remind
 * people 24 hours before a close, and draw anything past its close time.
 *
 * Every step is idempotent — a pod is announced once, reminded once and drawn
 * once, whatever calls this and however often — which matters because Apps
 * Script lets any page the web app serves call a public function.
 */
function rewardsJob(e) {
  if (!calledByOwnTrigger_(e, 'rewardsJob')) ownerOnly_('rewardsJob');
  if (!isRewardsProject_()) return 'Scheduled rewards work belongs to another project (or setupRewards has not run).';
  if (!rewardsLive_()) return 'Rewards are off.';
  return rewardsJob_();
}

function rewardsJob_() {
  var out = [];
  try {
    freshRewardsRead_();
    var credited = withLock_(function () { return accrueTickets_(); });
    if (credited) out.push('credited ' + credited);

    rewardsCacheDrop_();
    var t = now_().getTime();
    var totals = podTotals_();
    podsAll_().forEach(function (pod) {
      if (pod.status !== 'live') return;
      var phase = podPhase_(pod, t);
      if (cfgBool_('REWARDS_ANNOUNCE_PODS')) {
        if ((phase === 'open') && !pod.announced_ts) {
          var claimed = claimPodFlag_(pod.pod_id, 'announced_ts');
          if (claimed) { announcePodOpen_(pod); out.push('announced ' + pod.pod_id); }
        }
        var closes = tsMs_(pod.closes_ts);
        if (phase === 'open' && !pod.reminded_ts && closes - t <= 86400000 && closes - t > 0 &&
            closes - tsMs_(pod.opens_ts || pod.created_ts) > 2 * 86400000) {
          if (claimPodFlag_(pod.pod_id, 'reminded_ts')) {
            announcePodClosing_(pod, totals[pod.pod_id] || emptyTotals_());
            out.push('reminded ' + pod.pod_id);
          }
        }
      }
      if (phase === 'closed') {
        var res = drawPod_(pod.pod_id, 'system', false);
        out.push('drew ' + pod.pod_id + ': ' + (res.ok ? res.message : res.error));
      }
    });
  } catch (e) {
    if (String(e && e.message) === 'BUSY') return 'Busy; will run next time.';
    logError_('rewards.job_failed', 'system', String(e && e.stack || e));
    return 'Failed: ' + e;
  }
  return out.length ? out.join('; ') : 'Nothing to do.';
}

/**
 * Stamps a timestamp column on a pod if it is still empty, under the lock.
 * @return {boolean} true when this call did the stamping (so should post)
 */
function claimPodFlag_(podId, column) {
  if (!isRewardsProject_()) return false;
  return withLock_(function () {
    rewardsCacheDrop_();
    var pod = podById_(podId);
    if (!pod || pod[column]) return false;
    var f = {};
    f[column] = iso_();
    patchPod_(pod, f);
    return true;
  });
}

/**
 * Asks the Slack project to drop its cached config. Each Apps Script project
 * has its own CacheService, so a setting changed here would otherwise sit
 * stale on the Slack side for as long as its cache lives. Best effort.
 */
function pingSlackCacheDrop_() {
  var url = cfgStr_('SLACK_APP_URL');
  var k = cfgStr_('URL_SECRET');
  if (!url || !k || !/^https:\/\/script\.google\.com\//.test(url)) return false;
  try {
    var res = UrlFetchApp.fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(k), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ type: 'tailwag_cache_drop', team_id: cfgStr_('ALLOWED_TEAM_ID') }),
      muteHttpExceptions: true,
      followRedirects: true
    });
    return res.getResponseCode() < 400;
  } catch (e) {
    logWarn_('rewards.cache_ping_failed', 'system', String(e));
    return false;
  }
}

/** Installs the 15-minute rewards job in THIS project. Owner only. */
function installRewardsTriggers() {
  ownerOnly_('installRewardsTriggers');
  return installRewardsTriggers_();
}

function installRewardsTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'rewardsJob') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('rewardsJob').timeBased().everyMinutes(15).create();
  // Hand edits to the Config tab should reach this project's cache too; the
  // Slack project's own watcher only drops the Slack project's cache.
  var watching = ScriptApp.getProjectTriggers().some(function (tr) { return tr.getHandlerFunction() === 'onConfigEdit'; });
  if (!watching) {
    try { ScriptApp.newTrigger('onConfigEdit').forSpreadsheet(ss_()).onEdit().create(); } catch (e) {
      logWarn_('rewards.on_edit_failed', 'system', String(e));
    }
  }
  var id = '';
  try { id = ScriptApp.getScriptId(); } catch (e) { id = ''; }
  if (id) setConfig_('REWARDS_JOB_SCRIPT_ID', id);
  logInfo_('rewards.triggers_installed', 'system', 'rewardsJob every 15 minutes in ' + id);
  return 'Rewards job installed (every 15 minutes) in project ' + id + '.';
}

/**
 * One-time rewards bootstrap, run from the editor of the rewards portal project:
 * adds the tabs and config keys, stamps the launch moment (fresh start), and
 * retires the automatic monthly raffle, which pods replace.
 */
function setupRewards() {
  ownerOnly_('setupRewards');
  return setupRewards_();
}

function setupRewards_() {
  // A fresh portal project with no sheet configured would otherwise create a
  // brand-new empty spreadsheet and quietly run a second, separate economy.
  var hasSheet = !!(PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID) || builtInSpreadsheetId_());
  if (!hasSheet) {
    var active = null;
    try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
    if (!active) {
      throw new Error('This project does not know which Tail Wag spreadsheet to use. Build the portal with ' +
        'portal/.clasp.json "spreadsheetId" set, or add the script property ' + PROP_SPREADSHEET_ID + '.');
    }
  }
  if (!builtInSpreadsheetId_()) {
    // Only the portal build (scripts/build-portal.js) carries PORTAL_SPREADSHEET_ID.
    // Running this in the Slack project would make it the rewards writer, with
    // a web app that cannot tell who anyone is.
    throw new Error('setupRewards belongs in the Tail Wag Rewards project (built with npm run build:portal), ' +
      'not the Slack project.');
  }
  setupSpreadsheet_();
  freshRewardsRead_();
  var notes = [];
  var owner = cfgStr_('REWARDS_JOB_SCRIPT_ID');
  var me = '';
  try { me = ScriptApp.getScriptId(); } catch (e) { me = ''; }
  if (owner && me && owner !== me) {
    throw new Error('Another project (' + owner + ') already runs Tail Wag Rewards. Clear REWARDS_JOB_SCRIPT_ID ' +
      'on the Config tab first if this project is meant to take over.');
  }
  var stamped = false;
  if (!cfgStr_('REWARDS_LAUNCH_TS')) {
    setConfig_('REWARDS_LAUNCH_TS', iso_());
    stamped = true;
    notes.push('Launch stamped at ' + cfgStr_('REWARDS_LAUNCH_TS') + ' — only tailwags from now on earn tickets.');
  } else {
    notes.push('Launch already set: ' + cfgStr_('REWARDS_LAUNCH_TS') + '.');
  }
  if (!cfgBool_('REWARDS_ENABLED')) {
    setConfig_('REWARDS_ENABLED', true);
    notes.push('Rewards switched on (REWARDS_ENABLED = TRUE).');
  }
  if (cfgBool_('RAFFLE_ENABLED')) {
    setConfig_('RAFFLE_ENABLED', false);
    notes.push('Retired the automatic monthly raffle (RAFFLE_ENABLED = FALSE).');
  }
  if (stamped && !cfgStr_('REWARDS_ACCRUAL_CURSOR')) {
    // Start the cursor at the current end of the Ledger: everything before the
    // launch is history, and scanning it on every request would be waste.
    var ledger = readSheet_(SHEETS.LEDGER);
    if (ledger.length) {
      var tail = ledger[ledger.length - 1];
      setConfig_('REWARDS_ACCRUAL_CURSOR', formatCursor_({ row: tail.__row, id: ledgerRowId_(tail) }));
    }
  }
  notes.push(installRewardsTriggers_());
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  if (url && !cfgStr_('REWARDS_PORTAL_URL')) {
    setConfig_('REWARDS_PORTAL_URL', String(url).replace(/\/dev$/, '/exec'));
    notes.push('REWARDS_PORTAL_URL set to ' + cfgStr_('REWARDS_PORTAL_URL') + '.');
  }
  var msg = 'Rewards are set up.\n  ' + notes.join('\n  ');
  console.log(msg);
  return msg;
}

/**
 * End-to-end check of the rewards wiring, run from the editor of the rewards
 * project. It makes one throwaway draft pod, cancels it and removes the row, so
 * the write path is proven against the real sheet without anyone seeing it.
 */
function selfTestRewards() {
  ownerOnly_('selfTestRewards');
  return selfTestRewards_();
}

function selfTestRewards_() {
  var ok = [];
  var bad = [];
  freshRewardsRead_();

  if (isRewardsProject_()) ok.push('This project owns the rewards (REWARDS_JOB_SCRIPT_ID matches).');
  else bad.push('REWARDS_JOB_SCRIPT_ID does not match this project — run setupRewards() here.');
  if (rewardsLive_()) ok.push('Rewards are on; tickets count from ' + cfgStr_('REWARDS_LAUNCH_TS') + '.');
  else bad.push('Rewards are off or have no launch time.');

  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ['rewardsJob', 'onConfigEdit'].forEach(function (h) {
    if (handlers.indexOf(h) !== -1) ok.push('Trigger installed: ' + h + '.');
    else bad.push('Missing trigger: ' + h + ' — run installRewardsTriggers().');
  });

  if (cfgStr_('REWARDS_PORTAL_URL')) ok.push('Rewards site: ' + cfgStr_('REWARDS_PORTAL_URL'));
  else bad.push('REWARDS_PORTAL_URL is empty.');
  if (cfgStr_('SLACK_APP_URL')) {
    if (pingSlackCacheDrop_()) ok.push('Slack project answered the cache ping.');
    else bad.push('Slack project did not answer the cache ping at SLACK_APP_URL.');
  } else {
    bad.push('SLACK_APP_URL is empty, so settings changed here reach Slack only when its cache expires.');
  }

  // The write path, against the real sheet.
  var t = now_().getTime();
  var made = savePod_({ title: '[self-test] safe to ignore', closes_ts: new Date(t + 86400000).toISOString() }, 'selfTest');
  if (!made.ok) {
    bad.push('Could not create a draft pod: ' + made.error);
  } else {
    var cancelled = cancelPod_(made.pod_id, 'selfTest', 'self-test');
    rewardsCacheDrop_();
    var pod = podById_(made.pod_id);
    if (cancelled.ok && pod && pod.status === 'cancelled') ok.push('Created, read back and cancelled a draft pod.');
    else bad.push('Draft pod round trip failed: ' + (cancelled.error || 'status ' + (pod && pod.status)));
    if (pod) {
      withLock_(function () { sheet_(SHEETS.PODS).deleteRow(pod.__row); });
      rewardsCacheDrop_();
      ok.push('Removed the test pod row.');
    }
  }

  // Wallet maths over the real data.
  var wallets = allWallets_();
  ok.push('Wallets computed for ' + Object.keys(wallets).length + ' people.');

  // Can people be recognized?
  var roster = getRoster_();
  var ids = Object.keys(roster);
  var noEmail = ids.filter(function (id) { return !String(roster[id].email || '').trim(); });
  ok.push('Roster: ' + ids.length + ' people, ' + (ids.length - noEmail.length) + ' with an email on file.');
  if (noEmail.length) {
    bad.push('No email on the Roster for: ' + noEmail.map(function (id) {
      return String(roster[id].display_name || id);
    }).join(', ') + '. They are matched through Slack when they first open the site; run /wag-admin sync to fill it now.');
  }
  cfgList_('REWARDS_ADMIN_EMAILS').forEach(function (email) {
    var res = slackApiGet_('users.lookupByEmail', { email: email }, true);
    ok.push('Admin ' + email + ': ' + (res && res.ok ? 'Slack member ' + res.user.id : 'no Slack account (Admin tab only, no wallet)'));
  });

  var out = (bad.length ? 'PROBLEMS\n  ' + bad.join('\n  ') + '\n\n' : 'No problems found.\n\n') + 'CHECKED\n  ' + ok.join('\n  ');
  console.log(out);
  return out;
}
