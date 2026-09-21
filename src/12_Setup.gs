/**
 * Tail Wag — 12_Setup.gs
 * One-time bootstrap, run from the Apps Script editor.
 *
 * setupSpreadsheet() is idempotent: run it again after upgrading and it will add
 * missing tabs, add missing config keys, refresh the notes column, and leave
 * existing data and edited values alone.
 */

/**
 * Creates or repairs the backing spreadsheet, writes the config defaults, and
 * generates a URL secret. Run this first.
 */
function setupSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_SPREADSHEET_ID) || builtInSpreadsheetId_();
  if (id && !props.getProperty(PROP_SPREADSHEET_ID)) props.setProperty(PROP_SPREADSHEET_ID, id);
  var ss;

  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    var active = null;
    try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
    ss = active || SpreadsheetApp.create('Tail Wag');
    props.setProperty(PROP_SPREADSHEET_ID, ss.getId());
  }
  __ssCache = ss;
  __sheetCache = {};

  // --- tabs ----------------------------------------------------------------
  ['CONFIG', 'ROSTER', 'LEDGER', 'BALANCES', 'BADGES', 'RAFFLE', 'EVENTS', 'PODS', 'TICKETS', 'WINNERS', 'IDEAS'].forEach(function (key) {
    var name = SHEETS[key];
    var s = ss.getSheetByName(name);
    if (!s) s = ss.insertSheet(name);
    var cols = COLUMNS[key];
    var existing = s.getLastColumn() > 0 && s.getLastRow() > 0
      ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String)
      : [];
    // Add any columns a newer version introduced, without disturbing the old ones.
    var missing = cols.filter(function (c) { return existing.indexOf(c) === -1; });
    if (!existing.length) {
      s.getRange(1, 1, 1, cols.length).setValues([cols]);
    } else if (missing.length) {
      s.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, Math.max(cols.length, s.getLastColumn()))
      .setFontWeight('bold').setBackground('#fff1e0');

    // Columns holding period keys must be plain text. Left as "automatic",
    // Sheets parses "2026-09" and "2026-09-16" into Date values, which breaks
    // every key comparison downstream — monthly totals read as zero and the
    // raffle believes it has no entries at all.
    var live = s.getLastColumn() > 0
      ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String)
      : [];
    ['period_key', 'month_key', 'week_key', 'period', 'last_gave_period',
      'opens_ts', 'closes_ts', 'announced_ts', 'reminded_ts', 'drawn_ts', 'fulfilled_ts', 'pod_id', 'ref', 'idea_id', 'created_ts', 'decided_ts', 'hidden_ts'].forEach(function (colName) {
      var at = live.indexOf(colName);
      if (at !== -1) s.getRange(1, at + 1, Math.max(s.getMaxRows ? s.getMaxRows() : 1000, 1000), 1)
        .setNumberFormat('@');
    });
  });

  // Remove the default empty sheet a brand-new spreadsheet comes with.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  // --- config defaults -----------------------------------------------------
  var cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  var existingKeys = {};
  if (cfgSheet.getLastRow() > 1) {
    cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var k = String(r[0]).trim();
      if (k) existingKeys[k] = true;
    });
  }
  var toAdd = [];
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    if (existingKeys[k]) return;
    var d = CONFIG_DEFAULTS[k];
    var v = d.value;
    if (k === 'URL_SECRET' && !v) v = generateUrlSecret_();
    toAdd.push([k, v, d.notes]);
  });
  if (toAdd.length) {
    cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }
  cfgSheet.setColumnWidth(1, 250);
  cfgSheet.setColumnWidth(2, 260);
  cfgSheet.setColumnWidth(3, 620);
  cfgSheet.getRange(1, 3, cfgSheet.getLastRow(), 1).setWrap(true);

  cacheDropAll_();
  __configCache = null;

  // Notes are documentation, not data: bring them up to date with this version
  // so an upgraded sheet never explains the app it used to be.
  refreshConfigNotes_();

  var secret = cfgStr_('URL_SECRET');
  var msg = [
    'Tail Wag is set up.',
    '',
    'Spreadsheet: ' + ss.getUrl(),
    'URL secret:  ' + secret,
    '',
    'Next:',
    '  1. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone.',
    '  2. Paste the /exec URL plus ?k=' + secret + ' into the Slack app\'s three Request URLs.',
    '  3. Put the bot token into the Config tab (SLACK_BOT_TOKEN), plus ALLOWED_TEAM_ID.',
    '  4. Run installTriggers().',
    '  5. Run selfTest() to check the wiring.'
  ].join('\n');
  console.log(msg);
  return msg;
}

/**
 * Prints the Request URL to paste into Slack, secret included.
 * Run after the web app has been deployed at least once.
 */
function showRequestUrl_() {
  var url;
  try {
    url = ScriptApp.getService().getUrl();
  } catch (e) {
    url = '';
  }
  if (!url) {
    var msg = 'No web app deployment yet. Deploy → New deployment → Web app, then run this again.';
    console.log(msg);
    return msg;
  }
  // Run from the editor, getUrl() returns the /dev HEAD url, which only the
  // signed-in owner can open. Slack is anonymous, so it needs /exec.
  url = String(url).replace(/\/dev$/, '/exec');
  var full = url + '?k=' + cfgStr_('URL_SECRET');
  console.log('Request URL for all three Slack fields:\n\n' + full +
    '\n\nLeaderboard page (safe to share internally):\n\n' + full + '&period=period');
  return full;
}

/**
 * Checks the wiring end to end and reports what is missing, without sending
 * anything to the team.
 */
function selfTest_() {
  var problems = [];
  var notes = [];

  if (!cfgStr_('SLACK_BOT_TOKEN')) problems.push('SLACK_BOT_TOKEN is empty in the Config tab.');
  if (!cfgStr_('URL_SECRET')) problems.push('URL_SECRET is empty — run setupSpreadsheet().');
  if (!cfgStr_('ALLOWED_TEAM_ID')) notes.push('ALLOWED_TEAM_ID is empty. Set it to lock the app to your workspace.');

  if (cfgStr_('SLACK_BOT_TOKEN')) {
    var auth = slackApi_('auth.test', {}, true);
    if (!auth.ok) {
      problems.push('Slack rejected the bot token: ' + auth.error);
    } else {
      notes.push('Connected to ' + auth.team + ' as ' + auth.user + '.');
      if (!cfgStr_('ALLOWED_TEAM_ID')) {
        setConfig_('ALLOWED_TEAM_ID', auth.team_id);
        notes.push('ALLOWED_TEAM_ID set automatically to ' + auth.team_id + '.');
      }
    }

    var channel = resolveChannel_(cfgStr_('ANNOUNCE_CHANNEL'));
    if (!channel) {
      problems.push('Cannot resolve ANNOUNCE_CHANNEL (' + cfgStr_('ANNOUNCE_CHANNEL') + ').');
    } else if (channel.charAt(0) === '#') {
      // resolveChannel_ fell back to the raw name, so conversations.list never
      // matched it. Asking conversations.info about "#name" returns the useless
      // error invalid_arguments, so say the useful thing instead.
      problems.push('Could not turn ' + channel + ' into a channel ID. Either the channel does not exist, ' +
        'or the bot cannot list it yet. Put the channel ID in ANNOUNCE_CHANNEL instead of the name — ' +
        'in Slack, open the channel, click its name, and copy the ID at the bottom of the About tab.');
    } else {
      // conversations.info is a GET-family method: Slack answers a JSON POST
      // with invalid_arguments, which reads like a bad channel ID and is not.
      var probe = slackApiGet_('conversations.info', { channel: channel }, true);
      if (!probe.ok) {
        notes.push('Could not read ' + cfgStr_('ANNOUNCE_CHANNEL') + ' (' + probe.error +
          '). Invite the bot with /invite @TailWag.');
      } else if (probe.channel && probe.channel.is_member === false) {
        problems.push('The bot is not in ' + cfgStr_('ANNOUNCE_CHANNEL') + '. Run /invite @TailWag there.');
      } else {
        notes.push('Announcement channel OK: #' + (probe.channel ? probe.channel.name : channel) + '.');
      }
    }
  }

  try {
    var probeBal = getBalance_('U_SELFTEST_PROBE', 'self test');
    notes.push('Spreadsheet writable. Period key ' + probeBal.period_key + '.');
    removeUser_('U_SELFTEST_PROBE');
  } catch (e) {
    problems.push('Cannot write to the spreadsheet: ' + e);
  }

  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'dailyJob';
  });
  if (!triggers.length) problems.push('No daily trigger installed — run installTriggers().');
  else notes.push('Daily job is scheduled.');

  try {
    // getUrl() returns null when the editor has no HEAD deployment, so this
    // must not be chained onto blindly — it used to print "null?k=<secret>".
    var url = ScriptApp.getService().getUrl();
    if (url) {
      notes.push('Web app URL: ' + String(url).replace(/\/dev$/, '/exec') + '?k=' + cfgStr_('URL_SECRET'));
    } else {
      notes.push('Apps Script did not report a web app URL. That is normal when the deployment was ' +
        'made from Deploy → New deployment; copy the /exec URL from Deploy → Manage deployments.');
    }
  } catch (e) {
    notes.push('No deployment URL yet — deploy the web app.');
  }

  var out = (problems.length ? 'PROBLEMS\n  ' + problems.join('\n  ') + '\n\n' : 'No problems found.\n\n') +
    'NOTES\n  ' + notes.join('\n  ');
  console.log(out);
  return out;
}

/**
 * Rewrites the notes column on the Config tab from CONFIG_DEFAULTS, leaving
 * every value alone. Run it after a rename or an upgrade so the explanation
 * beside each key describes the app people are actually using — setup only
 * ever adds missing keys, so old notes would otherwise sit there forever.
 */
function refreshConfigNotes_() {
  var s = sheet_(SHEETS.CONFIG);
  var last = s.getLastRow();
  if (last < 2) return 'Config tab is empty — run setupSpreadsheet() first.';

  var keys = s.getRange(2, 1, last - 1, 1).getValues();
  var notes = s.getRange(2, 3, last - 1, 1).getValues();
  var changed = 0;
  var unknown = [];

  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i][0]).trim();
    if (!k) continue;
    var d = CONFIG_DEFAULTS[k];
    if (!d) { unknown.push(k); continue; }
    if (String(notes[i][0]) !== String(d.notes)) { notes[i][0] = d.notes; changed++; }
  }

  s.getRange(2, 3, last - 1, 1).setValues(notes);
  __configCache = null;
  cacheDropAll_();

  var msg = 'Refreshed ' + changed + ' config note' + (changed === 1 ? '' : 's') + '.' +
    (unknown.length ? ' Left alone, not a known key: ' + unknown.join(', ') + '.' : '');
  console.log(msg);
  return msg;
}

/** Deletes a person's balance row. Used by selfTest cleanup and by admins. */
function removeUser_(userId) {
  var idx = balanceIndex_();
  if (idx[userId]) {
    sheet_(SHEETS.BALANCES).deleteRow(idx[userId]);
    cacheDrop_('balances.index');
    return true;
  }
  return false;
}

/**
 * Seeds a handful of fake tailwags so the leaderboard and App Home can be reviewed
 * before the team is let loose. Run clearDemoData() afterwards.
 */
function seedDemoData_() {
  var people = [
    ['U_DEMO_1', 'Ada'], ['U_DEMO_2', 'Bo'], ['U_DEMO_3', 'Cleo'],
    ['U_DEMO_4', 'Dev'], ['U_DEMO_5', 'Esme']
  ];
  var reasons = [
    'covered two sessions at no notice on Tuesday',
    'rewrote the intake packet so families can actually read it',
    'stayed late to finish the auth before the deadline',
    'caught the billing error before it went out',
    'trained the new tech without being asked'
  ];
  var values = valueList_();

  people.forEach(function (p) {
    var bal = getBalance_(p[0], p[1], false);
    rollForward_(bal);
    writeBalance_(bal);
  });

  for (var i = 0; i < 18; i++) {
    var g = people[i % people.length];
    var r = people[(i * 3 + 1) % people.length];
    if (g[0] === r[0]) continue;
    var dots = (i % 4 === 0) ? 2 : 1;
    var v = values.length ? values[i % values.length] : null;

    var rb = getBalance_(r[0], r[1], false);
    rollForward_(rb);
    rb.received_this_period = num_(rb.received_this_period) + dots;
    rb.received_month = num_(rb.received_month) + dots;
    rb.received_total = num_(rb.received_total) + dots;
    awardBadges_(rb);
    addRaffleEntries_(r[0], r[1], dots, monthKey_());
    writeBalance_(rb);

    var gb = getBalance_(g[0], g[1], false);
    rollForward_(gb);
    gb.given_total = num_(gb.given_total) + dots;
    writeBalance_(gb);

    appendLedger_({
      giver_id: g[0], giver_name: g[1], receiver_id: r[0], receiver_name: r[1],
      dots: dots, reason: reasons[i % reasons.length],
      value_tag: v ? v.tag : '', source: 'demo', pool: 'peer'
    });
  }
  cacheDropAll_();
  return 'Seeded demo data for ' + people.length + ' fake people. Run clearDemoData() when you are done.';
}

/** Removes everything seedDemoData() created. */
function clearDemoData_() {
  var removed = 0;

  var ledger = sheet_(SHEETS.LEDGER);
  var lv = ledger.getDataRange().getValues();
  for (var r = lv.length - 1; r >= 1; r--) {
    if (String(lv[r][0]).indexOf('od_') === 0 &&
        (String(lv[r][4]).indexOf('U_DEMO_') === 0 || String(lv[r][6]).indexOf('U_DEMO_') === 0)) {
      ledger.deleteRow(r + 1); removed++;
    }
  }

  [SHEETS.BALANCES, SHEETS.BADGES, SHEETS.RAFFLE, SHEETS.ROSTER].forEach(function (name) {
    var s = sheet_(name);
    var v = s.getDataRange().getValues();
    var idCol = name === SHEETS.RAFFLE ? 1 : 0;
    for (var i = v.length - 1; i >= 1; i--) {
      if (String(v[i][idCol]).indexOf('U_DEMO_') === 0) { s.deleteRow(i + 1); removed++; }
    }
  });

  cacheDropAll_();
  return 'Removed ' + removed + ' demo rows.';
}

/** Editor entry point — owner only. See ownerOnly_(). */
function setupSpreadsheet() {
  ownerOnly_('setupSpreadsheet');
  return setupSpreadsheet_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function showRequestUrl() {
  ownerOnly_('showRequestUrl');
  return showRequestUrl_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function selfTest() {
  ownerOnly_('selfTest');
  return selfTest_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function refreshConfigNotes() {
  ownerOnly_('refreshConfigNotes');
  return refreshConfigNotes_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function seedDemoData() {
  ownerOnly_('seedDemoData');
  return seedDemoData_();
}

/** Editor entry point — owner only. See ownerOnly_(). */
function clearDemoData() {
  ownerOnly_('clearDemoData');
  return clearDemoData_();
}
