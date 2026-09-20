/**
 * Tail Wag — test harness.
 *
 * Apps Script code cannot be required, and Google's runtime cannot be run
 * locally, so this harness recreates enough of it — SpreadsheetApp, Utilities,
 * CacheService, PropertiesService, LockService, UrlFetchApp, ScriptApp — to load
 * the real .gs files into a Node VM and exercise the actual business logic
 * rather than a reimplementation of it.
 *
 * The fake spreadsheet is a real 2D array with the same range semantics as
 * Sheets (1-indexed rows and columns), so off-by-one bugs in the store layer
 * surface here exactly as they would in production.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// Fake Sheets
// ---------------------------------------------------------------------------

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this.sheet._get(this.row + r, this.col + c));
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(matrix) {
    if (matrix.length !== this.numRows) {
      throw new Error(`setValues row mismatch: got ${matrix.length}, range is ${this.numRows}`);
    }
    for (let r = 0; r < this.numRows; r++) {
      if (matrix[r].length !== this.numCols) {
        throw new Error(`setValues column mismatch on row ${r}: got ${matrix[r].length}, range is ${this.numCols}`);
      }
      for (let c = 0; c < this.numCols; c++) {
        this.sheet._set(this.row + r, this.col + c, matrix[r][c]);
      }
    }
    return this;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setWrap() { return this; }
  setNumberFormat(fmt) {
    if (fmt === '@') {
      for (let c = 0; c < this.numCols; c++) this.sheet.textColumns[this.col + c] = true;
    }
    return this;
  }
  setNumberFormats() { return this; }
}

/**
 * Google Sheets does not store what you hand it. A string that looks like a
 * date ("2026-09", "2026-09-16") is parsed into a real Date and comes back as a
 * Date object, and a string starting with "=" becomes a live formula. A leading
 * apostrophe is the escape hatch: it forces text, and is stripped on read.
 *
 * Simulating all three is the difference between a test suite that passes and
 * one that is worth anything — every one of these bit this app in review.
 */
const DATEY = /^\d{4}-\d{2}(-\d{2})?$/;

function coerceLikeSheets(value, isTextFormatted) {
  if (typeof value !== 'string') return value;
  if (isTextFormatted) return value.charAt(0) === "'" ? value.slice(1) : value;
  if (value.charAt(0) === "'") return value.slice(1);   // forced text
  if (DATEY.test(value)) {
    const parts = value.split('-').map((n) => parseInt(n, 10));
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] || 1));
  }
  return value;
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = [];            // array of rows, each an array of cells
    this.frozenRows = 0;
    this.textColumns = {};     // 1-indexed column → forced plain text
    this.formulas = {};        // "row,col" → true when the cell is a live formula
  }
  getName() { return this.name; }
  _get(row, col) {
    const r = this.data[row - 1];
    if (!r) return '';
    const v = r[col - 1];
    return v === undefined ? '' : v;
  }
  _set(row, col, value) {
    while (this.data.length < row) this.data.push([]);
    const r = this.data[row - 1];
    while (r.length < col) r.push('');
    const v = value === undefined || value === null ? '' : value;
    const key = row + ',' + col;
    // A string entered without a leading apostrophe and starting with = or +
    // becomes a LIVE FORMULA. With the apostrophe it is inert text, and the
    // apostrophe itself never appears when the value is read back.
    const isLive = row > 1 && typeof v === 'string' &&
      v.charAt(0) !== "'" && !this.textColumns[col] && /^[=+]/.test(v);
    if (isLive) this.formulas[key] = true; else delete this.formulas[key];
    r[col - 1] = row === 1 ? String(v) : coerceLikeSheets(v, !!this.textColumns[col]);
  }
  _formulaCells() {
    return Object.keys(this.formulas).map((k) => {
      const [row, col] = k.split(',').map(Number);
      return { row, col, value: this._get(row, col) };
    });
  }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => {
      if (row && row.some((c) => c !== '' && c !== null && c !== undefined)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach((row) => {
      if (!row) return;
      for (let c = row.length; c > 0; c--) {
        if (row[c - 1] !== '' && row[c - 1] !== null && row[c - 1] !== undefined) {
          if (c > last) last = c;
          break;
        }
      }
    });
    return last;
  }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows,
      numCols === undefined ? 1 : numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this._set(row, i + 1, v));
    return this;
  }
  _shiftFormulas(fromRow, by) {
    const next = {};
    Object.keys(this.formulas).forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      if (r < fromRow) next[k] = true;
      else if (r >= fromRow - by) next[(r + by) + ',' + c] = true;
    });
    this.formulas = next;
  }
  deleteRow(row) { this.data.splice(row - 1, 1); this._shiftFormulas(row, -1); return this; }
  deleteRows(row, count) { this.data.splice(row - 1, count); this._shiftFormulas(row, -count); return this; }
  clear() { this.data = []; this.formulas = {}; return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth() { return this; }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [];
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.push(s); return s; }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); }
}

// ---------------------------------------------------------------------------
// Date formatting that matches Utilities.formatDate closely enough
// ---------------------------------------------------------------------------

function parts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
  });
  const out = {};
  dtf.formatToParts(date).forEach((p) => { out[p.type] = p.value; });
  // Intl returns hour "24" at midnight in some ICU versions.
  if (out.hour === '24') out.hour = '00';
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatDate(date, tz, pattern) {
  const p = parts(date, tz);
  const y = p.year, mo = p.month, d = p.day, h = p.hour, mi = p.minute, s = p.second;
  const monthIdx = parseInt(mo, 10) - 1;
  const dow = DOW_SHORT[p.weekday];            // 0=Sun
  const isoDow = dow === 0 ? 7 : dow;          // 1=Mon…7=Sun, matches 'u'
  const h12 = (parseInt(h, 10) % 12) || 12;
  const ampm = parseInt(h, 10) < 12 ? 'AM' : 'PM';

  // Longest tokens first so yyyy does not get eaten by yy.
  return pattern
    .replace(/yyyy/g, y)
    .replace(/MMMM/g, MONTHS[monthIdx])
    .replace(/MMM/g, MONTHS[monthIdx].slice(0, 3))
    .replace(/MM/g, mo)
    .replace(/EEE/g, p.weekday)
    .replace(/dd/g, d)
    .replace(/\bd\b/g, String(parseInt(d, 10)))
    .replace(/HH/g, h)
    .replace(/mm/g, mi)
    .replace(/ss/g, s)
    .replace(/\bu\b/g, String(isoDow))
    .replace(/\bh\b/g, String(h12))
    .replace(/\ba\b/g, ampm);
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

function createEnvironment(options = {}) {
  const state = {
    spreadsheet: new FakeSpreadsheet('SHEET_TEST_ID', 'Tail Wag (test)'),
    properties: {},
    cache: {},
    fetches: [],           // every UrlFetchApp call, for assertions
    fetchResponses: {},    // method name → response object
    users: {},             // user id → users.info profile
    channels: [{ id: 'C_KUDOS', name: 'kudos' }, { id: 'C_GENERAL', name: 'general' }],
    nowValue: options.now || new Date('2026-09-16T18:00:00Z'),
    randomQueue: [],
    lockHeld: false,
    uuidCounter: 0,
    batchSeq: 0,        // which fetchAll batch a recorded call belonged to
    currentBatch: null,
    ownerEmail: 'robots@actaba.com',
    activeUser: 'robots@actaba.com',   // '' = anonymous visitor
    scriptId: 'SCRIPT_TEST_ID'
  };

  function jsonResponse(obj) {
    const text = JSON.stringify(obj);
    return { getContentText: () => text, getResponseCode: () => 200 };
  }

  function handleFetch(url, params) {
    const batchId = state.currentBatch;
    const method = String(url).replace('https://slack.com/api/', '').split('?')[0];
    let payload = {};
    try { payload = params && params.payload ? JSON.parse(params.payload) : {}; } catch (e) { payload = {}; }
    state.fetches.push({ url, method, payload, params, batchId });

    // Slack's read methods take query parameters. Sent as a JSON POST they come
    // back invalid_arguments, which reads exactly like a bad ID — so the fake
    // refuses them the same way, and a POST-shaped read fails a test here
    // instead of at 5pm on a Friday.
    const READ_ONLY_METHODS = [
      'users.info', 'users.lookupByEmail', 'users.list', 'conversations.list',
      'conversations.info', 'conversations.history'
    ];
    const isGet = !params || String(params.method || 'get').toLowerCase() === 'get';
    if (READ_ONLY_METHODS.indexOf(method) !== -1 && !isGet) {
      return jsonResponse({ ok: false, error: 'invalid_arguments' });
    }

    if (state.fetchResponses[method]) return jsonResponse(state.fetchResponses[method]);

    switch (method) {
      case 'users.info': {
        const id = decodeURIComponent(String(url).split('user=')[1] || '').split('&')[0];
        const u = state.users[id];
        return jsonResponse(u ? { ok: true, user: u } : { ok: false, error: 'user_not_found' });
      }
      case 'users.lookupByEmail': {
        const email = decodeURIComponent(String(url).split('email=')[1] || '').split('&')[0].toLowerCase();
        const u = Object.keys(state.users).map((k) => state.users[k])
          .find((x) => String(x.profile && x.profile.email || '').toLowerCase() === email);
        return jsonResponse(u ? { ok: true, user: u } : { ok: false, error: 'users_not_found' });
      }
      case 'conversations.list':
        return jsonResponse({ ok: true, channels: state.channels, response_metadata: { next_cursor: '' } });
      case 'users.list':
        return jsonResponse({
          ok: true,
          members: Object.keys(state.users).map((k) => state.users[k]),
          response_metadata: { next_cursor: '' }
        });
      case 'chat.postMessage':
      case 'chat.postEphemeral':
      case 'views.publish':
        return jsonResponse({ ok: true, ts: String(Date.now() / 1000) });
      case 'auth.test':
        return jsonResponse({ ok: true, team: 'ACT', team_id: 'T_TEST', user: 'tailwag' });
      case 'conversations.info':
        return jsonResponse({ ok: true, channel: { id: 'C_KUDOS', name: 'kudos', is_member: true } });
      case 'conversations.history':
        return jsonResponse({ ok: true, messages: [{ text: 'the message that was reacted to' }] });
      default:
        return jsonResponse({ ok: true });
    }
  }

  const sandbox = {
    console: {
      log: options.verbose ? console.log : () => {},
      error: options.verbose ? console.error : () => {},
      warn: options.verbose ? console.warn : () => {}
    },
    JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, isNaN, parseInt, parseFloat,
    Intl,

    SpreadsheetApp: {
      openById: () => state.spreadsheet,
      getActiveSpreadsheet: () => state.spreadsheet,
      create: (name) => { state.spreadsheet = new FakeSpreadsheet('NEW_ID', name); return state.spreadsheet; }
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (state.properties[k] === undefined ? null : state.properties[k]),
        getProperties: () => Object.assign({}, state.properties),
        setProperty: (k, v) => { state.properties[k] = String(v); },
        deleteProperty: (k) => { delete state.properties[k]; }
      })
    },

    CacheService: {
      getScriptCache: () => ({
        get: (k) => (state.cache[k] === undefined ? null : state.cache[k]),
        put: (k, v) => { state.cache[k] = v; },
        remove: (k) => { delete state.cache[k]; }
      })
    },

    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (state.lockHeld) return false;
          state.lockHeld = true;
          return true;
        },
        releaseLock: () => { state.lockHeld = false; }
      })
    },

    Utilities: {
      formatDate,
      getUuid: () => {
        state.uuidCounter += 1;
        // Unique in the leading characters too, because ids are cut from the
        // front of the UUID (od_ + 16 hex) exactly as in production.
        const c = state.uuidCounter.toString(16).padStart(8, '0');
        return `${c}-0000-4000-8000-${String(state.uuidCounter).padStart(12, '0')}`;
      },
      computeHmacSha256Signature: (value, key) => {
        const buf = crypto.createHmac('sha256', key).update(value, 'utf8').digest();
        // Apps Script returns signed bytes, exactly as Java does.
        return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
      },
      sleep: () => {}
    },

    UrlFetchApp: {
      // A lone fetch is its own batch; a fetchAll is one batch however many
      // requests it carries. Tests use this to prove that a path with a
      // three-second budget is not making serial round trips.
      fetch: (url, params) => {
        state.batchSeq += 1;
        state.currentBatch = 'single-' + state.batchSeq;
        try { return handleFetch(url, params); } finally { state.currentBatch = null; }
      },
      fetchAll: (requests) => {
        state.batchSeq += 1;
        state.currentBatch = 'batch-' + state.batchSeq;
        try { return requests.map((r) => handleFetch(r.url, r)); } finally { state.currentBatch = null; }
      }
    },

    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput: (s) => {
        const o = {
          _content: s === undefined ? '' : s,
          _mime: 'TEXT',
          setMimeType(m) { this._mime = m; return this; },
          getContent() { return this._content; },
          getMimeType() { return this._mime; }
        };
        return o;
      }
    },

    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutput: (html) => ({
        _html: html,
        setTitle() { return this; },
        addMetaTag() { return this; },
        setXFrameOptionsMode() { return this; },
        getContent() { return this._html; }
      }),
      createHtmlOutputFromFile: (name) => ({
        getContent() { return name === 'PortalLogo' ? 'data:image/webp;base64,TEST' : ''; }
      }),
      createTemplateFromFile: (name) => ({
        _name: name,
        evaluate() {
          return {
            _data: this.data,
            _boot: this.boot,
            setTitle() { return this; },
            addMetaTag() { return this; },
            setXFrameOptionsMode() { return this; },
            getContent() { return `<html data-template="${name}"></html>`; }
          };
        }
      })
    },

    Session: {
      getActiveUser: () => ({ getEmail: () => state.activeUser }),
      getEffectiveUser: () => ({ getEmail: () => state.ownerEmail })
    },

    ScriptApp: {
      _triggers: [],
      getScriptId: () => state.scriptId,
      getProjectTriggers() { return this._triggers.slice(); },
      deleteTrigger(t) { this._triggers = this._triggers.filter((x) => x !== t); },
      newTrigger(fn) {
        const self = this;
        const spec = { handler: fn, kind: '', everyMinutes: 0 };
        const t = {
          getHandlerFunction: () => fn,
          getUniqueId: () => 'trig-' + spec.handler + '-' + (self._triggers.length + 1),
          _spec: spec,
          timeBased() { spec.kind = 'time'; return this; },
          forSpreadsheet() { spec.kind = 'spreadsheet'; return this; },
          onEdit() { spec.kind = 'edit'; return this; },
          atHour() { return this; },
          nearMinute() { return this; },
          everyDays() { return this; },
          everyHours() { return this; },
          // Apps Script throws on anything but these, and a throw here means a
          // broken install in production — so the fake refuses them too.
          everyMinutes(n) {
            if ([1, 5, 10, 15, 30].indexOf(n) === -1) {
              throw new Error('Invalid value for everyMinutes: ' + n);
            }
            spec.everyMinutes = n;
            return this;
          },
          inTimezone() { return this; },
          create() { self._triggers.push(t); return t; }
        };
        return t;
      },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
    }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Load the .gs sources in filename order, exactly as Apps Script concatenates them.
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: f });
    } catch (e) {
      throw new Error(`Failed loading ${f}: ${e.message}`);
    }
  });

  // Deterministic time and randomness for the tests.
  vm.runInContext(`
    function now_() { return __state_now(); }
    function random_() { return __state_random(); }
  `, sandbox);
  sandbox.__state_now = () => new Date(state.nowValue.getTime());
  sandbox.__state_random = () => (state.randomQueue.length ? state.randomQueue.shift() : 0.5);

  const api = {
    sandbox,
    state,
    run: (expr) => vm.runInContext(expr, sandbox),
    call: (fn, ...args) => {
      sandbox.__args = args;
      return vm.runInContext(`${fn}.apply(null, __args)`, sandbox);
    },
    setActiveUser: (email) => { state.activeUser = email; },
    setNow: (d) => { state.nowValue = d instanceof Date ? d : new Date(d); },
    setRandom: (values) => { state.randomQueue = values.slice(); },
    addUser: (id, name, extra = {}) => {
      state.users[id] = Object.assign({
        id, name, is_bot: false, deleted: false,
        profile: { display_name: name, real_name: name, email: `${name}@actaba.com` }
      }, extra);
    },
    setConfigValue: (key, value) => {
      api.call('setConfig_', key, value);
      vm.runInContext('__configCache = null;', sandbox);
    },
    sheetRows: (name) => api.call('readSheet_', name),
    formulaCells: (name) => {
      const sheet = state.spreadsheet.getSheetByName(name);
      return sheet ? sheet._formulaCells() : [];
    },
    rawCell: (name, row, col) => {
      const sheet = state.spreadsheet.getSheetByName(name);
      return sheet ? sheet._get(row, col) : undefined;
    },
    fetchesTo: (method) => state.fetches.filter((f) => f.method === method),
    clearFetches: () => { state.fetches.length = 0; },
    setup: () => {
      api.call('setupSpreadsheet');
      vm.runInContext('cacheDropAll_(); __configCache = null;', sandbox);
    }
  };

  return api;
}

module.exports = { createEnvironment, FakeSheet, FakeSpreadsheet, formatDate };
