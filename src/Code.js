/*******************************************************
 * FOH STOCK APP  —  Code.gs
 * Whimsiland FOH crockery stock (Cafe + Barista)
 *
 * Golden rule: stock is NEVER stored as a running number.
 * Opening / Closing / Summary are always calculated from
 * ITEM_MASTER (base opening) + TRANSACTIONS (ledger).
 * So an opening/closing mismatch is simply not possible.
 *******************************************************/

const CFG = {
  OLD_SHEET_ID: '1GQ-37Mv0M2ImzDlL1z7zLNbpbiLlW8qRGCMzRir7sj8', // FOH SHEET NEW
  OLD_TAB: 'sep26',                                              // import yahi tab se
  SECTIONS: ['Cafe', 'Barista'],
  MAX_QTY: 10000,
  MAX_LINES: 60,
  MAX_SUMMARY_DAYS: 400,
  DEFAULT_PIN: '1234',
  SH: {
    MASTER: 'ITEM_MASTER',
    TXN: 'TRANSACTIONS',
    STOCK: 'STOCK_NOW',
    SUMMARY: 'SUMMARY',
    STAFF: 'STAFF',
    SETTINGS: 'SETTINGS'
  }
};

const TYPES = {
  ADD:      { label: 'Add',       sign: +1 },
  BREAKAGE: { label: 'Breakage',  sign: -1 },
  MISSING:  { label: 'Missing',   sign: -1 },
  ADJUST:   { label: 'Adjust',    sign: 0 }   // legacy: no longer offered in the app (old rows are still read correctly)
};

const HEAD = {
  MASTER: ['Item ID', 'Item Name', 'Category', 'Section', 'Base Opening', 'Base Date', 'Active', 'Remark'],
  TXN: ['Txn ID', 'Timestamp', 'Date', 'Section', 'Item ID', 'Item Name', 'Category', 'Type', 'Qty',
        'Signed Qty', 'Remark', 'Entered By', 'Request ID', 'Status', 'Void Reason', 'Void At', 'Void By'],
  STOCK: ['Item ID', 'Item Name', 'Category', 'Section', 'Opening (Today)', 'Added', 'Breakage',
          'Missing', 'Adjust', 'Current Stock', 'Updated At'],
  STAFF: ['Staff Name', 'Active'],
  SUM_ITEMS: ['Item ID', 'Item Name', 'Category', 'Section', 'Opening', 'Added', 'Breakage',
              'Missing', 'Adjust', 'Closing'],
  SUM_ENTRIES: ['Date', 'Time', 'Txn ID', 'Section', 'Item', 'Type', 'Qty', 'Remark', 'Entered By', 'Status']
};

// TRANSACTIONS column numbers (1-based)
const TC = {
  ID: 1, TS: 2, DATE: 3, SECTION: 4, ITEM_ID: 5, ITEM_NAME: 6, CATEGORY: 7, TYPE: 8, QTY: 9,
  SIGNED: 10, REMARK: 11, BY: 12, REQ: 13, STATUS: 14, VOID_REASON: 15, VOID_AT: 16, VOID_BY: 17
};

/* =====================================================
 * WEB APP
 * ===================================================== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('FOH Stock')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** App load par: date, sections, staff, warnings */
function getInitData() {
  const master = readItems_();
  return {
    today: today_(),
    monthStart: today_().slice(0, 8) + '01',
    sections: CFG.SECTIONS.slice(),
    staff: readStaff_(),
    warnings: master.warnings,
    noSectionCount: master.items.filter(function (it) { return it.active && !it.section; }).length,
    defaultPin: getSetting_('Manager PIN') === CFG.DEFAULT_PIN
  };
}

/** Ek section ka aaj ka live stock */
function getStock(section) {
  section = normSection_(section);
  if (!section) throw new Error('Invalid section.');
  const master = readItems_();
  const tx = readTxns_();
  const today = today_();
  const calc = computeStock_(master.items, tx.rows, today, today);

  const items = master.items
    .filter(function (it) { return it.active && it.section === section && it.baseDate <= today; })
    .map(function (it) {
      const c = calc[it.id];
      return {
        id: it.id, name: it.name, category: it.category || 'Other',
        opening: c.opening, added: c.added, breakage: c.breakage,
        missing: c.missing, adjust: c.adjust, closing: c.closing
      };
    })
    .sort(sortItems_);

  return { date: today, section: section, items: items, updatedAt: nowStr_('HH:mm:ss') };
}

/**
 * Entries save (single ya multiple).
 * payload = { requestId, section, enteredBy, pin?, lines:[{itemId, type, qty, remark}] }
 * All-or-nothing: if even one line is invalid, nothing is saved.
 */
function saveEntries(payload) {
  const p = payload || {};
  const reqId = cleanReqId_(p.requestId);
  const section = normSection_(p.section);
  const by = cleanText_(p.enteredBy);
  const lines = Array.isArray(p.lines) ? p.lines : [];

  if (!reqId) throw new Error('Request ID is missing. Refresh the page and try again.');
  if (!section) throw new Error('Select a section (Cafe / Barista).');
  if (!lines.length) throw new Error('The list is empty. Add at least one entry.');
  if (lines.length > CFG.MAX_LINES) throw new Error('You can save at most ' + CFG.MAX_LINES + ' entries at a time.');
  assertStaff_(by);

  if (lines.some(function (l) { return String(l && l.type).toUpperCase() === 'ADJUST'; })) {
    throw new Error('Adjust (physical count) entries are not available in this app. Use Add, Breakage or Missing.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Another entry is being saved right now. Wait 10 seconds and press Save again.');

  let saved = [];
  let duplicate = false;
  try {
    const cache = CacheService.getScriptCache();
    const tx = readTxns_();

    // Duplicate submit protection (double tap / network retry)
    if (cache.get('REQ_' + reqId) || tx.rows.some(function (r) { return r.reqId.indexOf(reqId + '#') === 0; })) {
      duplicate = true;
    } else {
      const master = readItems_();
      const itemMap = mapById_(master.items);
      const today = today_();
      const calc = computeStock_(master.items, tx.rows, today, today);
      const running = {};
      const ts = nowStr_('yyyy-MM-dd HH:mm:ss');
      let seq = maxTxnSeq_(tx.rows);
      const out = [];

      lines.forEach(function (l, i) {
        const n = 'Entry ' + (i + 1) + ': ';
        const it = itemMap[String(l && l.itemId || '').trim()];
        if (!it) throw new Error(n + 'item was not found in ITEM_MASTER. Refresh the app.');
        if (!it.active) throw new Error(n + it.name + ' is inactive.');
        if (it.section !== section) throw new Error(n + it.name + ' ' + section + ' is not an item of this section.');
        if (it.baseDate > today) throw new Error(n + it.name + ' has a Base Date in the future (' + it.baseDate + ').');

        const type = String(l.type || '').toUpperCase();
        if (!TYPES[type]) throw new Error(n + 'invalid entry type.');

        const qty = Number(l.qty);
        if (!Number.isInteger(qty) || qty < 0 || qty > CFG.MAX_QTY) {
          throw new Error(n + it.name + ': quantity must be a whole number from 0 to ' + CFG.MAX_QTY + '.');
        }
        if (type !== 'ADJUST' && qty === 0) throw new Error(n + it.name + ': quantity cannot be 0.');

        const remark = cleanText_(l.remark).slice(0, 300);
        const cur = (running[it.id] !== undefined) ? running[it.id] : calc[it.id].closing;

        let signed, recQty, rem = remark;
        if (type === 'ADJUST') {
          signed = qty - cur;
          if (signed === 0) throw new Error(n + it.name + ': the physical count (' + qty + ') equals the system stock, no adjustment needed.');
          recQty = Math.abs(signed);
          rem = 'Physical count ' + qty + ', system ' + cur + (remark ? ' | ' + remark : '');
        } else {
          signed = TYPES[type].sign * qty;
          recQty = qty;
        }

        if (cur + signed < 0) {
          throw new Error(n + it.name + ': ' + TYPES[type].label + ' ' + qty + ' is not possible, stock is only ' + cur + '.');
        }
        running[it.id] = cur + signed;

        seq++;
        out.push([
          'TXN-' + pad_(seq, 6), ts, today, section, it.id, it.name, it.category, type,
          recQty, signed, rem, by, reqId + '#' + (i + 1), 'ACTIVE', '', '', ''
        ]);
      });

      appendTxnRows_(tx.sh, out);
      SpreadsheetApp.flush();
      cache.put('REQ_' + reqId, '1', 21600);
      saved = out.map(function (r) { return r[0]; });
    }
  } finally {
    lock.releaseLock();
  }

  safeRefreshStockNow_();
  return { ok: true, duplicate: duplicate, txnIds: saved, stock: getStock(section) };
}

/**
 * A wrong entry is VOIDed (never deleted). PIN required.
 * payload = { txnId, reason, enteredBy, pin }
 */
function voidEntry(payload) {
  const p = payload || {};
  const txnId = String(p.txnId || '').trim();
  const reason = cleanText_(p.reason).slice(0, 300);
  const by = cleanText_(p.enteredBy);
  if (!txnId) throw new Error('Txn ID missing.');
  if (reason.length < 3) throw new Error('Enter a reason for the void (at least 3 characters).');
  assertStaff_(by);
  checkPin_(p.pin);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Another entry is being saved right now. Try again in a moment.');

  let section = '';
  try {
    const tx = readTxns_();
    const target = tx.rows.filter(function (r) { return r.txnId === txnId; });
    if (target.length !== 1) throw new Error('Txn ' + txnId + ' was not found (or is duplicated). Run the Health Check.');
    const t = target[0];
    if (t.status !== 'ACTIVE') throw new Error(txnId + ' is already VOID.');

    const master = readItems_();
    const it = mapById_(master.items)[t.itemId];
    if (!it) throw new Error('The item of this entry is not in ITEM_MASTER.');

    // After the void, the item's stock must not be negative on any day
    let bal = it.base;
    tx.rows.forEach(function (r) {
      if (r.itemId !== it.id || r.status !== 'ACTIVE' || r.txnId === txnId || r.date < it.baseDate) return;
      bal += r.signed;
      if (bal < 0) {
        throw new Error('This entry cannot be voided: because of later entries, the stock of ' + it.name +
          ' would go negative on ' + r.date + '. Check the later entry (' + r.txnId + ') first.');
      }
    });

    // Re-verify the row, then write
    const sh = tx.sh;
    if (String(sh.getRange(t.row, TC.ID).getValue()).trim() !== txnId) throw new Error('The row in the sheet has changed. Refresh the app and try again.');
    sh.getRange(t.row, TC.STATUS, 1, 4).setValues([['VOID', reason, nowStr_('yyyy-MM-dd HH:mm:ss'), by]]);
    SpreadsheetApp.flush();
    section = t.section;
  } finally {
    lock.releaseLock();
  }

  safeRefreshStockNow_();
  return { ok: true, txnId: txnId, section: section };
}

/**
 * Summary: item-wise + entries list
 * p = { from:'yyyy-MM-dd', to:'yyyy-MM-dd', section:'All'|'Cafe'|'Barista' }
 */
function getSummary(p) {
  p = p || {};
  const from = normDate_(p.from);
  const to = normDate_(p.to);
  if (!from || !to) throw new Error('Enter valid From and To dates.');
  if (from > to) throw new Error('The From date must be on or before the To date.');
  const days = (toDateObj_(to) - toDateObj_(from)) / 86400000;
  if (days > CFG.MAX_SUMMARY_DAYS) throw new Error('A summary can cover at most ' + CFG.MAX_SUMMARY_DAYS + ' days at a time.');
  const secAll = !p.section || String(p.section).toLowerCase() === 'all';
  const section = secAll ? '' : normSection_(p.section);
  if (!secAll && !section) throw new Error('Invalid section.');

  const res = buildSummary_(from, to, section);
  return {
    from: from, to: to, section: section || 'All',
    rows: res.rows, totals: res.totals,
    entries: res.entries.slice(0, 1500), entriesTotal: res.entries.length
  };
}

/* =====================================================
 * CALCULATION ENGINE  (single source of truth)
 * ===================================================== */

/**
 * Har item ke liye [from..to] range ka opening / movement / closing.
 * Opening = Base Opening + (Base Date se from-1 tak ki saari ACTIVE entries)
 * Closing = Opening + Added − Breakage − Missing + Adjust
 */
function computeStock_(items, txns, from, to) {
  const res = {};
  const effFrom = {};
  items.forEach(function (it) {
    effFrom[it.id] = it.baseDate > from ? it.baseDate : from;
    res[it.id] = {
      opening: it.base, added: 0, breakage: 0, missing: 0, adjust: 0, closing: 0,
      notStarted: it.baseDate > to
    };
  });

  txns.forEach(function (t) {
    if (t.status !== 'ACTIVE') return;
    const r = res[t.itemId];
    if (!r || r.notStarted) return;
    const it = items._map ? items._map[t.itemId] : null;
    const baseDate = it ? it.baseDate : '';
    if (baseDate && t.date < baseDate) return;           // entries before the base date are not counted
    if (t.date < effFrom[t.itemId]) { r.opening += t.signed; return; }
    if (t.date > to) return;
    if (t.type === 'ADD') r.added += t.qty;
    else if (t.type === 'BREAKAGE') r.breakage += t.qty;
    else if (t.type === 'MISSING') r.missing += t.qty;
    else if (t.type === 'ADJUST') r.adjust += t.signed;
  });

  Object.keys(res).forEach(function (id) {
    const r = res[id];
    if (r.notStarted) { r.opening = 0; r.closing = 0; return; }
    r.closing = r.opening + r.added - r.breakage - r.missing + r.adjust;
  });
  return res;
}

function buildSummary_(from, to, section) {
  const master = readItems_();
  const tx = readTxns_();
  const calc = computeStock_(master.items, tx.rows, from, to);

  const rows = master.items
    .filter(function (it) { return !section || it.section === section; })
    .filter(function (it) {
      const c = calc[it.id];
      if (c.notStarted) return false;
      return it.active || c.opening || c.added || c.breakage || c.missing || c.adjust || c.closing;
    })
    .map(function (it) {
      const c = calc[it.id];
      return {
        id: it.id, name: it.name, category: it.category || 'Other', section: it.section || '-',
        opening: c.opening, added: c.added, breakage: c.breakage, missing: c.missing,
        adjust: c.adjust, closing: c.closing
      };
    })
    .sort(sortItems_);

  const totals = rows.reduce(function (a, r) {
    a.opening += r.opening; a.added += r.added; a.breakage += r.breakage;
    a.missing += r.missing; a.adjust += r.adjust; a.closing += r.closing;
    return a;
  }, { opening: 0, added: 0, breakage: 0, missing: 0, adjust: 0, closing: 0 });

  const entries = tx.rows
    .filter(function (t) { return t.date >= from && t.date <= to && (!section || t.section === section); })
    .map(function (t) {
      return {
        txnId: t.txnId, date: t.date, time: t.time, section: t.section, itemName: t.itemName,
        type: t.type, qty: t.qty, signed: t.signed, remark: t.remark, by: t.by,
        status: t.status, voidReason: t.voidReason
      };
    })
    .reverse(); // newest first

  return { rows: rows, totals: totals, entries: entries };
}

/* =====================================================
 * SHEET VIEWS: STOCK_NOW + SUMMARY
 * ===================================================== */

function refreshStockNow() {
  const sh = getSheet_(CFG.SH.STOCK);
  const master = readItems_();
  const tx = readTxns_();
  const today = today_();
  const calc = computeStock_(master.items, tx.rows, today, today);
  const stamp = nowStr_('yyyy-MM-dd HH:mm:ss');

  const rows = master.items
    .filter(function (it) { return it.active && it.baseDate <= today; })
    .sort(function (a, b) { return (a.section || 'zz').localeCompare(b.section || 'zz') || sortItems_(a, b); })
    .map(function (it) {
      const c = calc[it.id];
      return [it.id, it.name, it.category, it.section || '(no section)', c.opening, c.added,
              c.breakage, c.missing, c.adjust, c.closing, stamp];
    });

  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, HEAD.STOCK.length).clearContent();
  if (rows.length) {
    ensureRows_(sh, rows.length + 1);
    sh.getRange(2, 1, rows.length, HEAD.STOCK.length).setValues(rows);
  }
}

function refreshSummarySheet() {
  const sh = getSheet_(CFG.SH.SUMMARY);
  const from = normDate_(sh.getRange('B2').getValue());
  const to = normDate_(sh.getRange('B3').getValue());
  const secRaw = String(sh.getRange('B4').getValue() || 'All');
  const section = secRaw.toLowerCase() === 'all' ? '' : normSection_(secRaw);

  // purana output saaf
  const lastRow = Math.max(sh.getLastRow(), 8);
  sh.getRange(8, 1, lastRow - 7, 10).clearContent();
  sh.getRange(8, 12, lastRow - 7, 10).clearContent();
  sh.getRange('D2').clearContent();

  if (!from || !to || from > to) { sh.getRange('D2').setValue('Enter valid From / To dates (From ≤ To).'); return; }
  if (secRaw.toLowerCase() !== 'all' && !section) { sh.getRange('D2').setValue('Section: All / Cafe / Barista'); return; }

  const res = buildSummary_(from, to, section);
  const itemRows = res.rows.map(function (r) {
    return [r.id, r.name, r.category, r.section, r.opening, r.added, r.breakage, r.missing, r.adjust, r.closing];
  });
  const t = res.totals;
  itemRows.push(['', 'TOTAL', '', '', t.opening, t.added, t.breakage, t.missing, t.adjust, t.closing]);

  const entRows = res.entries.map(function (e) {
    return [e.date, e.time, e.txnId, e.section, e.itemName, e.type, e.signed, e.remark, e.by, e.status];
  });

  ensureRows_(sh, 8 + Math.max(itemRows.length, entRows.length));
  sh.getRange(8, 1, itemRows.length, 10).setValues(itemRows);
  if (entRows.length) {
    sh.getRange(8, 12, entRows.length, 3).setNumberFormat('@'); // Date, Time, Txn ID text
    sh.getRange(8, 12, entRows.length, 10).setValues(entRows);
  }
  sh.getRange('B5').setValue(nowStr_('dd-MMM-yyyy HH:mm'));
}

/* =====================================================
 * SPREADSHEET MENU + TRIGGERS
 * ===================================================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('FOH Stock')
    .addItem('Refresh Stock Now', 'refreshStockNow')
    .addItem('Refresh Summary', 'refreshSummarySheet')
    .addSeparator()
    .addItem('Fill missing Item IDs', 'fillMissingItemIds')
    .addItem('Go-Live: Base Date = Today', 'goLiveSetBaseDateToday')
    .addItem('Run Health Check', 'healthCheck')
    .addSeparator()
    .addItem('Setup / Repair Sheet', 'setupSheet')
    .addToUi();
}

/** SUMMARY tab mein B2:B4 badalte hi auto refresh */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== CFG.SH.SUMMARY) return;
    const r = e.range.getRow(), c = e.range.getColumn();
    if (c === 2 && r >= 2 && r <= 4) refreshSummarySheet();
  } catch (err) {
    // simple trigger: chupchaap fail na ho, message dikhao
    try { e.range.getSheet().getRange('D2').setValue('Error: ' + err.message); } catch (x) {}
  }
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshStockNow') ScriptApp.deleteTrigger(t);
  });
  // After midnight, refresh STOCK_NOW with the new day's opening
  ScriptApp.newTrigger('refreshStockNow').timeBased().everyDays(1).atHour(0).nearMinute(5).create();
}

/* =====================================================
 * SETUP (run once; running it again is safe)
 * ===================================================== */

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be run from inside the new Google Sheet (Extensions → Apps Script).');
  PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());
  ss.setSpreadsheetTimeZone(tz_());

  const master = ensureSheet_(ss, CFG.SH.MASTER, HEAD.MASTER);
  const txn = ensureSheet_(ss, CFG.SH.TXN, HEAD.TXN);
  const stock = ensureSheet_(ss, CFG.SH.STOCK, HEAD.STOCK);
  const staff = ensureSheet_(ss, CFG.SH.STAFF, HEAD.STAFF);
  ensureSettings_(ss);
  ensureSummary_(ss);

  // Text formats (dates/IDs stay text → no timezone mismatch)
  ['A:A', 'F:F'].forEach(function (a) { master.getRange(a).setNumberFormat('@'); });
  ['A:A', 'B:B', 'C:C', 'M:M', 'P:P'].forEach(function (a) { txn.getRange(a).setNumberFormat('@'); });
  master.getRange('E:E').setNumberFormat('0');
  txn.getRange('I:J').setNumberFormat('0');

  // Dropdowns
  master.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(CFG.SECTIONS, true).setAllowInvalid(false).build());
  master.getRange('G2:G').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Y', 'N'], true).setAllowInvalid(false).build());
  master.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build());
  staff.getRange('B2:B').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Y', 'N'], true).setAllowInvalid(false).build());

  // TRANSACTIONS pe warning protection (galti se edit na ho)
  if (!txn.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    txn.protect().setDescription('Ledger: entries only through the app. Do not edit manually.').setWarningOnly(true);
  }
  if (!stock.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    stock.protect().setDescription('Auto-generated view').setWarningOnly(true);
  }

  // Default blank "Sheet1" hatao
  ['Sheet1', 'Sheet 1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  let imported = 0;
  if (master.getLastRow() < 2) imported = importFromOldSheet_(master);
  if (staff.getLastRow() < 2) staff.getRange(2, 1, 1, 2).setValues([['Staff 1', 'Y']]);

  installTriggers_();
  refreshStockNow();
  refreshSummarySheet();

  const msg = 'Setup done. Items imported: ' + imported +
    '. Next: fill Section (Cafe/Barista) in ITEM_MASTER, add names in STAFF, and change the PIN in SETTINGS.';
  Logger.log(msg);
  try { ss.toast(msg, 'FOH Stock', 10); } catch (e) {}
  return msg;
}

function importFromOldSheet_(master) {
  const old = SpreadsheetApp.openById(CFG.OLD_SHEET_ID).getSheetByName(CFG.OLD_TAB);
  if (!old) throw new Error('Tab \"' + CFG.OLD_TAB + '\" was not found in the old sheet.');
  const v = old.getDataRange().getValues();
  const today = today_();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const name = cleanText_(v[r][0]);
    if (!name || name.toLowerCase() === 'item name') continue;
    let open = toInt_(v[r][5]);            // total opening
    if (open === null) open = toInt_(v[r][3]); // fallback: opening
    if (open === null || open < 0) open = 0;
    out.push(['FOH-' + pad_(out.length + 1, 3), name, cleanText_(v[r][2]), '', open, today, 'Y',
              'Imported from ' + CFG.OLD_TAB]);
  }
  if (out.length) {
    ensureRows_(master, out.length + 1);
    master.getRange(2, 1, out.length, HEAD.MASTER.length).setValues(out);
  }
  return out.length;
}

/** Write a new item in ITEM_MASTER (name/category/section only) → this fills ID, Base Date, Base 0, Active Y */
function fillMissingItemIds() {
  const sh = getSheet_(CFG.SH.MASTER);
  const last = sh.getLastRow();
  if (last < 2) return;
  const rng = sh.getRange(2, 1, last - 1, HEAD.MASTER.length);
  const v = rng.getValues();
  let max = 0;
  v.forEach(function (r) { const m = String(r[0]).match(/(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  const today = today_();
  let filled = 0;
  v.forEach(function (r) {
    if (!cleanText_(r[1])) return;
    if (!String(r[0]).trim()) { max++; r[0] = 'FOH-' + pad_(max, 3); filled++; }
    if (r[4] === '' || r[4] === null) r[4] = 0;
    if (!normDate_(r[5])) r[5] = today;
    if (!String(r[6]).trim()) r[6] = 'Y';
  });
  rng.setValues(v);
  uiAlert_('Done. ' + filled + ' new Item IDs created. For a new item keep Base Opening at 0 and use \"Add\" in the stock app.');
}

/**
 * Go-live: after the physical count, update Base Opening in ITEM_MASTER,
 * then run this. It only runs while there is no ACTIVE entry.
 */
function goLiveSetBaseDateToday() {
  const ui = SpreadsheetApp.getUi();
  const tx = readTxns_();
  if (tx.rows.some(function (r) { return r.status === 'ACTIVE'; })) {
    ui.alert('Entries already exist. Do not change the base date now; correct any difference with Add, Breakage or Missing entries in the app.');
    return;
  }
  const ok = ui.alert('Set the Base Date of all items to today (' + today_() + ')?\n' +
    'Enter the physical count in Base Opening first.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const sh = getSheet_(CFG.SH.MASTER);
  const last = sh.getLastRow();
  if (last < 2) return;
  const rng = sh.getRange(2, 6, last - 1, 1);
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  rng.setValues(ids.map(function (r) { return [String(r[0]).trim() ? today_() : '']; }));
  refreshStockNow();
  ui.alert('Base Date set. The app is now live.');
}

/** Pura data check: koi bhi gadbad ho to list dikhata hai */
function healthCheck() {
  const issues = [];
  let master;
  try { master = readItems_(); } catch (e) { uiAlert_('ITEM_MASTER error: ' + e.message); return; }
  master.warnings.forEach(function (w) { issues.push(w); });
  const noSec = master.items.filter(function (it) { return it.active && !it.section; }).length;
  if (noSec) issues.push(noSec + ' active items have no Section (they will not show in the app).');

  const map = mapById_(master.items);
  const tx = readTxns_();
  const seenId = {};
  let prevDate = '';
  const bal = {};
  tx.rows.forEach(function (t) {
    const at = 'Row ' + t.row + ' (' + t.txnId + '): ';
    if (!t.txnId) issues.push(at + 'Txn ID is empty.');
    if (seenId[t.txnId]) issues.push(at + 'duplicate Txn ID.');
    seenId[t.txnId] = true;
    if (!t.date) issues.push(at + 'invalid date.');
    if (t.date && prevDate && t.date < prevDate) issues.push(at + 'date order is reversed (was the sheet sorted?).');
    if (t.date) prevDate = t.date;
    if (!TYPES[t.type]) issues.push(at + 'invalid type: ' + t.type);
    if (['ACTIVE', 'VOID'].indexOf(t.status) < 0) issues.push(at + 'invalid status: ' + t.status);
    if (!Number.isInteger(t.qty) || !Number.isInteger(t.signed)) issues.push(at + 'quantity is not a number.');
    else if (TYPES[t.type] && t.type !== 'ADJUST' && t.signed !== TYPES[t.type].sign * t.qty) issues.push(at + 'Qty and Signed Qty do not match.');
    else if (t.type === 'ADJUST' && Math.abs(t.signed) !== t.qty) issues.push(at + 'Adjust qty does not match.');
    const it = map[t.itemId];
    if (!it) { issues.push(at + 'item ' + t.itemId + ' is not in ITEM_MASTER.'); return; }
    if (t.status !== 'ACTIVE' || t.date < it.baseDate) return;
    if (bal[it.id] === undefined) bal[it.id] = it.base;
    bal[it.id] += t.signed;
    if (bal[it.id] < 0) issues.push(at + it.name + ' has negative stock (' + bal[it.id] + ').');
  });

  uiAlert_(issues.length
    ? 'Issues (' + issues.length + '):\n\n' + issues.slice(0, 25).join('\n') + (issues.length > 25 ? '\n...' : '')
    : 'All good. Items: ' + master.items.length + ', Entries: ' + tx.rows.length);
}

/* =====================================================
 * READERS
 * ===================================================== */

function readItems_() {
  const sh = getSheet_(CFG.SH.MASTER);
  const last = sh.getLastRow();
  const items = [];
  const warnings = [];
  const seen = {};
  if (last >= 2) {
    const v = sh.getRange(2, 1, last - 1, HEAD.MASTER.length).getValues();
    v.forEach(function (r, i) {
      const row = i + 2;
      const id = String(r[0]).trim();
      const name = cleanText_(r[1]);
      if (!id && !name) return;
      if (!id) { warnings.push('ITEM_MASTER row ' + row + ': Item ID is empty (menu → Fill missing Item IDs).'); return; }
      if (!name) { warnings.push('ITEM_MASTER row ' + row + ': Item Name is empty.'); return; }
      if (seen[id]) throw new Error('Item ID \"' + id + '\" appears twice in ITEM_MASTER (rows ' + seen[id] + ' and ' + row + '). Change one of them.');
      seen[id] = row;
      const base = toInt_(r[4]);
      if (base === null || base < 0) { warnings.push('ITEM_MASTER row ' + row + ' (' + name + '): invalid Base Opening.'); return; }
      const baseDate = normDate_(r[5]);
      if (!baseDate) { warnings.push('ITEM_MASTER row ' + row + ' (' + name + '): invalid Base Date.'); return; }
      items.push({
        id: id, name: name, category: cleanText_(r[2]), section: normSection_(r[3]),
        base: base, baseDate: baseDate, active: String(r[6]).trim().toUpperCase() !== 'N', row: row
      });
    });
  }
  items._map = mapById_(items);
  return { items: items, warnings: warnings };
}

function readTxns_() {
  const sh = getSheet_(CFG.SH.TXN);
  const last = sh.getLastRow();
  if (last < 2) return { sh: sh, rows: [] };
  const v = sh.getRange(2, 1, last - 1, HEAD.TXN.length).getValues();
  const rows = [];
  v.forEach(function (r, i) {
    if (!String(r[0]).trim() && !String(r[4]).trim()) return; // empty row
    const tsStr = (r[1] instanceof Date) ? Utilities.formatDate(r[1], tz_(), 'yyyy-MM-dd HH:mm:ss') : String(r[1]);
    rows.push({
      row: i + 2,
      txnId: String(r[0]).trim(),
      ts: tsStr,
      time: tsStr.length >= 16 ? tsStr.slice(11, 16) : '',
      date: normDate_(r[2]),
      section: String(r[3]).trim(),
      itemId: String(r[4]).trim(),
      itemName: String(r[5]),
      category: String(r[6]),
      type: String(r[7]).trim().toUpperCase(),
      qty: Number(r[8]),
      signed: Number(r[9]),
      remark: String(r[10]),
      by: String(r[11]),
      reqId: String(r[12]),
      status: String(r[13]).trim().toUpperCase(),
      voidReason: String(r[14])
    });
  });
  return { sh: sh, rows: rows };
}

function readStaff_() {
  const sh = getSheet_(CFG.SH.STAFF);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getValues()
    .filter(function (r) { return cleanText_(r[0]) && String(r[1]).trim().toUpperCase() !== 'N'; })
    .map(function (r) { return cleanText_(r[0]); });
}

/* =====================================================
 * SECURITY
 * ===================================================== */

function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('PIN_FAILS') || 0);
  if (fails >= 5) throw new Error('Wrong PIN 5 times. Try again after 15 minutes.');
  const real = String(getSetting_('Manager PIN') || '').trim();
  if (!real) throw new Error('The Manager PIN is not set in SETTINGS.');
  if (String(pin || '').trim() !== real) {
    cache.put('PIN_FAILS', String(fails + 1), 900);
    throw new Error('The Manager PIN is wrong.');
  }
  cache.remove('PIN_FAILS');
}

function assertStaff_(name) {
  if (!name) throw new Error('Select who is making the entry.');
  if (readStaff_().indexOf(name) < 0) throw new Error('\"' + name + '\" is not an active name in the STAFF list.');
}

/* =====================================================
 * SHEET HELPERS
 * ===================================================== */

function ss_() {
  const a = SpreadsheetApp.getActiveSpreadsheet();
  if (a) return a;
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (!id) throw new Error('Setup has not been done. Run setupSheet() once in the sheet.');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Tab \"' + name + '\" was not found. Run menu → Setup / Repair Sheet.');
  return sh;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(function (x) { return String(x).trim(); });
  const empty = cur.every(function (x) { return !x; });
  if (empty) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (cur.join('|') !== headers.join('|')) {
    throw new Error('The headers of tab \"' + name + '\" differ from the expected ones. Do not change headers: ' + headers.join(', '));
  }
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  return sh;
}

function ensureSettings_(ss) {
  let sh = ss.getSheetByName(CFG.SH.SETTINGS);
  if (!sh) sh = ss.insertSheet(CFG.SH.SETTINGS);
  if (!String(sh.getRange('A1').getValue()).trim()) {
    sh.getRange('A1:B2').setValues([['Setting', 'Value'], ['Manager PIN', CFG.DEFAULT_PIN]]);
    sh.getRange('B2').setNumberFormat('@');
    sh.getRange('A1:B1').setFontWeight('bold');
  }
  return sh;
}

function ensureSummary_(ss) {
  let sh = ss.getSheetByName(CFG.SH.SUMMARY);
  if (!sh) sh = ss.insertSheet(CFG.SH.SUMMARY);
  if (!String(sh.getRange('A1').getValue()).trim()) {
    const now = new Date();
    sh.getRange('A1').setValue('FOH STOCK SUMMARY').setFontWeight('bold').setFontSize(14);
    sh.getRange('A2:A5').setValues([['From'], ['To'], ['Section'], ['Last refreshed']]).setFontWeight('bold');
    sh.getRange('B2').setValue(new Date(now.getFullYear(), now.getMonth(), 1));
    sh.getRange('B3').setValue(now);
    sh.getRange('B2:B3').setNumberFormat('dd-MMM-yyyy')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
    sh.getRange('B4').setValue('All').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['All'].concat(CFG.SECTIONS), true).setAllowInvalid(false).build());
    sh.getRange('B2:B4').setBackground('#FFF8D6');
    sh.getRange(7, 1, 1, 10).setValues([HEAD.SUM_ITEMS]).setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
    sh.getRange(7, 12, 1, 10).setValues([HEAD.SUM_ENTRIES]).setFontWeight('bold').setBackground('#5B3A29').setFontColor('#FFFFFF');
    sh.getRange('A6').setValue('Item-wise (date range)');
    sh.getRange('L6').setValue('Entries detail (newest first)');
    sh.setFrozenRows(7);
  }
  return sh;
}

function getSetting_(key) {
  const sh = getSheet_(CFG.SH.SETTINGS);
  const last = sh.getLastRow();
  if (last < 2) return '';
  const v = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < v.length; i++) if (String(v[i][0]).trim() === key) return String(v[i][1]).trim();
  return '';
}

function appendTxnRows_(sh, rows) {
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  ensureRows_(sh, start + rows.length - 1);
  const rng = sh.getRange(start, 1, rows.length, HEAD.TXN.length);
  // set text format first so a date/ID never turns into a Date object
  [TC.ID, TC.TS, TC.DATE, TC.REQ, TC.VOID_AT].forEach(function (c) {
    sh.getRange(start, c, rows.length, 1).setNumberFormat('@');
  });
  rng.setValues(rows);
}

function ensureRows_(sh, needLastRow) {
  const max = sh.getMaxRows();
  if (needLastRow > max) sh.insertRowsAfter(max, needLastRow - max + 200);
}

/* =====================================================
 * SMALL UTILS
 * ===================================================== */

function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function nowStr_(fmt) { return Utilities.formatDate(new Date(), tz_(), fmt); }
function pad_(n, w) { return String(n).padStart(w, '0'); }

function cleanText_(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim(); }
function cleanReqId_(s) { const x = String(s || '').trim(); return /^[A-Za-z0-9-]{8,64}$/.test(x) ? x : ''; }

function toInt_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function normSection_(s) {
  const x = String(s || '').trim().toLowerCase();
  for (let i = 0; i < CFG.SECTIONS.length; i++) if (CFG.SECTIONS[i].toLowerCase() === x) return CFG.SECTIONS[i];
  return '';
}

/** Date or text → 'yyyy-MM-dd'. Returns '' if invalid */
function normDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validYmd_(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dd/MM/yyyy
  if (m) return validYmd_(+m[3], +m[2], +m[1]);
  return '';
}

function validYmd_(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return y + '-' + pad_(mo, 2) + '-' + pad_(d, 2);
}

function toDateObj_(ymd) { const p = ymd.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

function mapById_(items) {
  const m = {};
  items.forEach(function (it) { m[it.id] = it; });
  return m;
}

function maxTxnSeq_(rows) {
  let max = 0;
  rows.forEach(function (r) { const m = r.txnId.match(/(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  return max;
}

function sortItems_(a, b) {
  return String(a.category || '').localeCompare(String(b.category || '')) ||
         String(a.name).localeCompare(String(b.name));
}

function safeRefreshStockNow_() {
  try { refreshStockNow(); } catch (e) { Logger.log('STOCK_NOW refresh failed: ' + e.message); }
}

function uiAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}