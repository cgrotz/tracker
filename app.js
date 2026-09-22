'use strict';
/* ---------------------------------------------------------------------------
   Budget — a minimal calorie + weight tracker. All state lives in localStorage.

   Budget model
     maintenance(day) = Mifflin-St Jeor BMR (from the 7-day average weight known
                        on that day) x activity multiplier
     dailyBudget(day) = maintenance(day) + goalKgPerWeek * 1100
                        (goal is negative when losing; 0.5 kg/wk = 550 kcal/day)
     bank(day)        = sum over earlier days this week of (budget - consumed),
                        optionally capped at one day's budget
     allowance(day)   = dailyBudget(day) + bank(day)
   The week runs Monday 00:00 to Sunday 23:59; the bank resets Sunday night.
--------------------------------------------------------------------------- */

var KEY = 'caltrack.v1';
var KCAL_PER_KG = 7700;
var ACTIVITY = {
  sedentary: { m: 1.2,   label: 'Sedentary — desk job, little exercise' },
  light:     { m: 1.375, label: 'Light — 1–3 workouts a week' },
  moderate:  { m: 1.55,  label: 'Moderate — 3–5 workouts a week' },
  active:    { m: 1.725, label: 'Active — 6–7 workouts a week' },
  athlete:   { m: 1.9,   label: 'Very active — physical job or twice daily' }
};
var GOALS = [
  { v: -1,    label: 'Lose 1.0 kg / week  (aggressive)' },
  { v: -0.75, label: 'Lose 0.75 kg / week' },
  { v: -0.5,  label: 'Lose 0.5 kg / week  (steady)' },
  { v: -0.25, label: 'Lose 0.25 kg / week  (slow)' },
  { v: 0,     label: 'Maintain weight' },
  { v: 0.25,  label: 'Gain 0.25 kg / week' },
  { v: 0.5,   label: 'Gain 0.5 kg / week' }
];
var MIN_BUDGET = 1200;

/* ---------- dates (all local, ISO yyyy-mm-dd) ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayISO() { return isoOf(new Date()); }
function parseISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function addDays(s, n) { var d = parseISO(s); d.setDate(d.getDate() + n); return isoOf(d); }
function weekStart(s) { var d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 864e5); }
function fmtDay(s) {
  var d = parseISO(s), t = todayISO();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtShort(s) { return parseISO(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

/* ---------- state ---------- */
function blank() {
  return { v: 1, createdAt: todayISO(), profile: null, weights: [], entries: [], pins: [], foods: {}, settings: { capRollover: true } };
}
var S = (function load() {
  try {
    var raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    var p = JSON.parse(raw), s = blank();
    for (var k in p) if (p[k] !== undefined) s[k] = p[k];
    s.settings = Object.assign({ capRollover: true }, p.settings || {});
    return s;
  } catch (e) { return blank(); }
})();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save — storage is full or blocked'); }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- derived numbers ---------- */
function weightOn(date) { for (var i = 0; i < S.weights.length; i++) if (S.weights[i].date === date) return S.weights[i]; return null; }

// 7-day average of the readings known on `date`; daily weight is too noisy to
// drive a budget directly.
function avgWeight(date) {
  var win = S.weights.filter(function (w) { return w.date <= date && daysBetween(w.date, date) < 7; });
  if (win.length) return win.reduce(function (a, w) { return a + w.kg; }, 0) / win.length;
  var prior = S.weights.filter(function (w) { return w.date <= date; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
  return prior ? prior.kg : null;
}
function ageOn(date) { return parseISO(date).getFullYear() - S.profile.birthYear; }
function maintenanceOn(date) {
  if (!S.profile) return null;
  var kg = avgWeight(date);
  if (kg == null) return null;
  var p = S.profile;
  var bmr = 10 * kg + 6.25 * p.heightCm - 5 * ageOn(date) + (p.sex === 'female' ? -161 : 5);
  return bmr * ACTIVITY[p.activity].m;
}
function budgetOn(date) {
  var m = maintenanceOn(date);
  if (m == null) return null;
  return Math.max(MIN_BUDGET, Math.round(m + S.profile.goalKgPerWeek * 1100));
}
function consumedOn(date) {
  return S.entries.reduce(function (a, e) { return e.date === date ? a + e.kcal : a; }, 0);
}
function entriesOn(date) {
  return S.entries.filter(function (e) { return e.date === date; }).sort(function (a, b) { return b.ts - a.ts; });
}
function firstTracked() {
  var d = null;
  S.entries.forEach(function (e) { if (!d || e.date < d) d = e.date; });
  return d;
}
// Unspent (or overspent) calories from the earlier days of this week.
function bankFor(date) {
  var ws = weekStart(date), first = firstTracked(), bank = 0;
  for (var d = ws; d < date; d = addDays(d, 1)) {
    if (first && d < first) continue;
    var b = budgetOn(d);
    if (b == null) continue;
    bank += b - consumedOn(d);
  }
  if (S.settings.capRollover) bank = Math.min(bank, budgetOn(date) || 0);
  return Math.round(bank);
}
function weekStats(date) {
  var ws = weekStart(date), budget = 0, consumed = 0, today = budgetOn(date) || 0;
  for (var i = 0; i < 7; i++) {
    var d = addDays(ws, i);
    budget += (d <= date ? (budgetOn(d) || today) : today);
    consumed += consumedOn(d);
  }
  return { start: ws, end: addDays(ws, 6), budget: Math.round(budget), consumed: consumed, left: Math.round(budget - consumed) };
}
// Everything logged before, most-used first. Drives the tile grid, the local
// half of search, and the chips in the manual sheet.
function foodHistory() {
  var tally = {};
  S.entries.slice(-500).forEach(function (e) {
    if (!e.label) return;
    var k = e.label + '|' + e.kcal;
    if (!tally[k]) tally[k] = { label: e.label, kcal: e.kcal, grams: e.grams, per100: e.per100, code: e.code, n: 0, last: '' };
    tally[k].n++;
    if (e.date > tally[k].last) tally[k].last = e.date;
  });
  return Object.keys(tally).map(function (k) { return tally[k]; })
    .sort(function (a, b) { return b.n - a.n || (a.last < b.last ? 1 : -1); });
}
function foldCase(s) { return String(s).toLowerCase(); }
function historyMatches(q, limit) {
  var n = foldCase(q);
  return foodHistory().filter(function (f) { return foldCase(f.label).indexOf(n) >= 0; }).slice(0, limit);
}
function quickAdds(limit) { return foodHistory().slice(0, limit); }

/* ---------- tiny DOM helpers ---------- */
var app = document.getElementById('app');
var overlay = document.getElementById('overlay');
var sheetBody = document.getElementById('sheetbody');
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
function n0(x) { return Math.round(x).toLocaleString(); }
function signed(x) { return (x > 0 ? '+' : '') + n0(x); }
var toastTimer;
function toast(msg, undo) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('actionable', !!undo);
  if (undo) {
    var b = document.createElement('button');
    b.className = 'undo'; b.type = 'button'; b.textContent = 'Undo';
    b.onclick = function () { t.classList.remove('show'); clearTimeout(toastTimer); undo(); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, undo ? 5000 : 2200);
}
// Sheets that hold a resource (the camera) register a teardown here.
var sheetCleanup = null;
function runCleanup() {
  if (!sheetCleanup) return;
  var f = sheetCleanup; sheetCleanup = null;
  try { f(); } catch (e) {}
}
var sheetTimer;
function openSheet(html, onMount) {
  runCleanup();
  clearTimeout(sheetTimer);   // a pending hide from a just-closed sheet must not fire
  sheetBody.innerHTML = html;
  overlay.hidden = false;
  requestAnimationFrame(function () { document.body.classList.add('open'); });
  if (onMount) onMount(sheetBody);
}
function closeSheet() {
  runCleanup();
  document.body.classList.remove('open');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(function () { overlay.hidden = true; sheetBody.innerHTML = ''; }, 260);
}
overlay.addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeSheet(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) closeSheet(); });

var ICON = {
  history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" transform="translate(1.5 1.5) scale(.86)"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13.5 8v8M17 8v8"/></svg>'
};

/* =========================== home =========================== */
// One tap logs a repeat food, so every quick log is undoable from the toast.
function logFood(date, item) {
  var e = { id: uid(), date: date, label: item.label, kcal: item.kcal, ts: Date.now() };
  if (item.grams) { e.grams = item.grams; e.per100 = item.per100; e.code = item.code; }
  S.entries.push(e);
  save(); render();
  toast(item.label + ' · ' + n0(item.kcal) + ' kcal', function () {
    S.entries = S.entries.filter(function (x) { return x.id !== e.id; });
    save(); render();
  });
}

function tileHTML(list) {
  return '<div class="grid3' + (list.length ? '' : ' empty') + '">' +
    list.map(function (t, i) {
      return '<button class="tile" data-t="' + i + '">' +
        '<span class="tl">' + esc(t.label) + '</span>' +
        '<span class="tk">' + n0(t.kcal) + '</span></button>';
    }).join('') +
    '<button class="tile manual" id="tile-manual">' +
      '<span class="tl">Calories</span><span class="tk">by hand</span></button>' +
    '</div>' +
    (list.length ? '' : '<p class="note center">Search or scan below to log your first food. It will show up here afterwards.</p>');
}

function rowsHTML(list, attr) {
  return '<div class="rows">' + list.map(function (p, i) {
    return '<button class="row" data-' + attr + '="' + i + '">' +
      '<span class="lbl"><b>' + esc(p.name || p.label) + '</b>' +
      (p.brand ? '<em>' + esc(p.brand) + '</em>' : '') + '</span>' +
      '<span class="kcal">' + (p.per100 != null && p.name ? p.per100 + ' / 100 g' : n0(p.kcal) + ' kcal') +
      '</span></button>';
  }).join('') + '</div>';
}

var searchTimer;
function showPanel(date, q) {
  var panel = document.getElementById('panel');
  if (!panel) return;
  clearTimeout(searchTimer);
  q = (q || '').trim();
  var finder = document.getElementById('finder');
  if (finder) finder.classList.toggle('searching', !!q);

  if (!q) {
    var tiles = foodHistory().slice(0, 8);
    panel.innerHTML = tileHTML(tiles);
    panel.querySelector('#tile-manual').onclick = function () { foodSheet(date, null, true); };
    Array.prototype.forEach.call(panel.querySelectorAll('[data-t]'), function (b) {
      b.onclick = function () { logFood(date, tiles[+b.getAttribute('data-t')]); };
    });
    return;
  }

  var mine = historyMatches(q, 6);
  panel.innerHTML =
    (mine.length ? '<div class="seclabel">Your foods</div>' + rowsHTML(mine, 'm') : '') +
    '<div id="remote"></div>';
  Array.prototype.forEach.call(panel.querySelectorAll('[data-m]'), function (b) {
    b.onclick = function () { logFood(date, mine[+b.getAttribute('data-m')]); };
  });

  // Open Food Facts search is flaky and rate sensitive — never per keystroke.
  if (q.length >= 3) searchTimer = setTimeout(function () { remoteSearch(date, q); }, 700);
  else document.getElementById('remote').innerHTML =
    '<p class="note">Keep typing to search Open Food Facts.</p>';
}

function remoteSearch(date, q) {
  var box = document.getElementById('remote');
  if (!box) return;
  var head = '<div class="seclabel">Open Food Facts</div>';
  box.innerHTML = head + '<p class="note">Searching…</p>';
  var stale = function () {
    var i = document.getElementById('q');
    return !box.isConnected || !i || i.value.trim() !== q;
  };
  offSearch(q).then(function (list) {
    if (stale()) return;
    if (!list.length) { box.innerHTML = head + '<p class="note">Nothing found for “' + esc(q) + '”.</p>'; return; }
    box.innerHTML = head + rowsHTML(list, 'p');
    Array.prototype.forEach.call(box.querySelectorAll('[data-p]'), function (b) {
      b.onclick = function () { portionSheet(date, list[+b.getAttribute('data-p')]); };
    });
  }).catch(function () {
    if (stale()) return;
    // The endpoint fails often enough that a retry is worth a button.
    box.innerHTML = head + '<p class="note">' + offError() + '</p>' +
      '<button class="btn ghost" type="button" id="retry">Try again</button>';
    box.querySelector('#retry').onclick = function () { remoteSearch(date, q); };
  });
}

function renderHome() {
  var today = todayISO();
  var budget = budgetOn(today);
  var bank = budget == null ? 0 : bankFor(today);
  var allowance = (budget || 0) + bank;
  var consumed = consumedOn(today);
  var left = allowance - consumed;
  var week = weekStats(today);
  var frac = allowance > 0 ? Math.min(1, Math.max(0, consumed / allowance)) : 0;
  var state = left < 0 ? 'red' : (allowance > 0 && left / allowance <= 0.2 ? 'yellow' : 'green');
  var hasWeightToday = !!weightOn(today);
  var list = entriesOn(today);
  var R = 112, C = 2 * Math.PI * R;

  app.innerHTML =
    '<div class="bar">' +
      '<button class="iconbtn" id="go-history" title="History" aria-label="History">' + ICON.history + '</button>' +
      '<div class="title">' + fmtDay(today).toUpperCase() + '</div>' +
      '<button class="iconbtn" id="go-settings" title="Settings" aria-label="Settings">' + ICON.gear + '</button>' +
    '</div>' +
    '<div class="home state-' + state + '">' +
      (budget == null
        ? '<div class="card center" style="width:100%"><h2>Almost there</h2><p class="note">Log your weight to get your first budget.</p></div>'
        : '<div class="ringwrap">' +
            '<svg viewBox="0 0 260 260" aria-hidden="true">' +
              '<circle class="ring-track" cx="130" cy="130" r="' + R + '" fill="none" stroke-width="14"/>' +
              '<circle class="ring-val" cx="130" cy="130" r="' + R + '" fill="none" stroke-width="14" stroke-linecap="round"' +
                ' stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - frac)).toFixed(1) + '"/>' +
            '</svg>' +
            '<div class="ringtext">' +
              '<div class="bignum">' + n0(Math.abs(left)) + '</div>' +
              '<div class="bigunit">' + (left < 0 ? 'kcal over' : 'kcal left') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="meta">' +
            '<div>' + n0(consumed) + ' of <b>' + n0(allowance) + '</b> today' +
              (bank ? ' <span class="' + (bank > 0 ? 'pos' : 'neg') + '">(' + signed(bank) + ' carried over)</span>' : '') +
            '</div>' +
            '<div>Week: <b>' + n0(week.left) + '</b> left of ' + n0(week.budget) + '</div>' +
          '</div>') +
      // Idle: grid on top, search below it (thumb reach). While searching the
      // search bar moves above the results so it stays put as they render.
      '<div class="finder" id="finder">' +
        '<div id="panel" class="panel"></div>' +
        '<form class="searchbar" id="sb" autocomplete="off">' +
          '<input id="q" type="search" enterkeyhint="search" placeholder="Search food" aria-label="Search food">' +
          (CAM.possible() ? '<button type="button" class="iconbtn scanbtn" id="scanbtn" aria-label="Scan barcode">' + ICON.scan + '</button>' : '') +
        '</form>' +
      '</div>' +
      (hasWeightToday ? '' : '<button class="btn secondary mt" id="add-weight">Log today’s weight</button>') +
      (list.length
        ? '<details class="today"><summary><span>Today</span><span>' + list.length + ' item' + (list.length > 1 ? 's' : '') + '</span></summary>' +
            '<div class="rows">' + list.map(function (e) {
              return '<button class="row" data-edit="' + e.id + '"><span class="lbl">' + esc(e.label || 'Food') + '</span><span class="kcal">' + n0(e.kcal) + ' kcal</span></button>';
            }).join('') + '</div></details>'
        : '') +
    '</div>';

  app.querySelector('#go-history').onclick = function () { location.hash = '#/history'; };
  app.querySelector('#go-settings').onclick = function () { location.hash = '#/settings'; };
  var wb = app.querySelector('#add-weight');
  if (wb) wb.onclick = function () { weightSheet(today); };
  Array.prototype.forEach.call(app.querySelectorAll('[data-edit]'), function (b) {
    b.onclick = function () { foodSheet(today, b.getAttribute('data-edit')); };
  });

  var form = app.querySelector('#sb'), input = app.querySelector('#q');
  input.oninput = function () { showPanel(today, input.value); };
  form.onsubmit = function (e) {
    e.preventDefault();
    var q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length >= 2) { showPanel(today, q); remoteSearch(today, q); }
    input.blur();
  };
  var sb = app.querySelector('#scanbtn');
  if (sb) sb.onclick = function () { scanSheet(today); };
  showPanel(today, '');
}

/* =========================== food sheet =========================== */
function foodSheet(date, editId, manualOnly) {
  var editing = editId ? S.entries.filter(function (e) { return e.id === editId; })[0] : null;
  var quick = editing ? [] : quickAdds(8);
  openSheet(
    '<h2>' + (editing ? 'Edit entry' : 'Add food') + (date !== todayISO() ? ' — ' + fmtDay(date) : '') + '</h2>' +
    (editing || manualOnly ? '' : '<div class="lookup">' +
      '<button class="chip" id="off-search">' + ICON.search + ' Search food</button>' +
      (CAM.possible() ? '<button class="chip" id="off-scan">' + ICON.scan + ' Scan barcode</button>' : '') +
    '</div>') +
    (quick.length ? '<div class="chips">' + quick.map(function (q, i) {
      return '<button class="chip" data-q="' + i + '">' + esc(q.label) + ' <b>' + n0(q.kcal) + '</b></button>';
    }).join('') + '</div>' : '') +
    '<form id="f">' +
      '<label class="f"><span>Calories</span><input name="kcal" type="number" inputmode="numeric" min="1" max="20000" step="1" required value="' + (editing ? editing.kcal : '') + '" autocomplete="off"></label>' +
      '<label class="f"><span>What was it? (optional)</span><input name="label" type="text" maxlength="40" value="' + (editing ? esc(editing.label || '') : '') + '" autocomplete="off" placeholder="Lunch"></label>' +
      '<button class="btn" type="submit">' + (editing ? 'Save' : 'Add') + '</button>' +
      (editing ? '<button class="btn danger mt" type="button" id="del">Delete entry</button>' : '') +
    '</form>',
    function (root) {
      var form = root.querySelector('#f');
      var kcal = form.kcal;
      if (!editing) setTimeout(function () { kcal.focus(); }, 320);
      Array.prototype.forEach.call(root.querySelectorAll('[data-q]'), function (b) {
        b.onclick = function () {
          var q = quick[+b.getAttribute('data-q')];
          S.entries.push({ id: uid(), date: date, label: q.label, kcal: q.kcal, ts: Date.now() });
          save(); closeSheet(); render(); toast(q.label + ' · ' + n0(q.kcal) + ' kcal');
        };
      });
      form.onsubmit = function (e) {
        e.preventDefault();
        var v = Math.round(+kcal.value);
        if (!(v > 0)) { toast('Enter a calorie amount'); return; }
        var label = form.label.value.trim();
        if (editing) { editing.kcal = v; editing.label = label; }
        else S.entries.push({ id: uid(), date: date, label: label, kcal: v, ts: Date.now() });
        save(); closeSheet(); render();
      };
      var srch = root.querySelector('#off-search');
      if (srch) srch.onclick = function () { searchSheet(date); };
      var scan = root.querySelector('#off-scan');
      if (scan) scan.onclick = function () { scanSheet(date); };
      var del = root.querySelector('#del');
      if (del) del.onclick = function () {
        S.entries = S.entries.filter(function (e) { return e.id !== editId; });
        save(); closeSheet(); render(); toast('Entry deleted');
      };
    }
  );
}

/* =========================== weight sheet =========================== */
function weightSheet(date) {
  var cur = weightOn(date);
  var last = S.weights.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
  openSheet(
    '<h2>Weight — ' + fmtDay(date) + '</h2>' +
    '<form id="w">' +
      '<label class="f"><span>Weight (kg)</span><input name="kg" type="number" inputmode="decimal" step="0.1" min="25" max="400" required value="' + (cur ? cur.kg : '') + '" placeholder="' + (last ? last.kg : '75.0') + '" autocomplete="off"></label>' +
      '<button class="btn" type="submit">Save</button>' +
      (cur ? '<button class="btn danger mt" type="button" id="delw">Delete reading</button>' : '') +
    '</form>' +
    '<p class="note">Your budget follows the 7-day average, so a single heavy day will not move it much.</p>',
    function (root) {
      var form = root.querySelector('#w');
      setTimeout(function () { form.kg.focus(); }, 320);
      form.onsubmit = function (e) {
        e.preventDefault();
        var kg = Math.round(+form.kg.value * 10) / 10;
        if (!(kg > 0)) { toast('Enter a weight'); return; }
        if (cur) cur.kg = kg;
        else S.weights.push({ date: date, kg: kg });
        S.weights.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        save(); closeSheet(); render(); toast('Weight saved');
      };
      var d = root.querySelector('#delw');
      if (d) d.onclick = function () {
        S.weights = S.weights.filter(function (w) { return w.date !== date; });
        save(); closeSheet(); render(); toast('Reading deleted');
      };
    }
  );
}

/* =========================== charts =========================== */
var W = 320, H = 140, PL = 34, PR = 8, PT = 10, PB = 20;
function sx(i, n) { return PL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PL - PR)); }
function sy(v, lo, hi) { return hi === lo ? PT + (H - PT - PB) / 2 : PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); }

function weightChart(from, to) {
  var pts = S.weights.filter(function (w) { return w.date >= from && w.date <= to; });
  if (pts.length < 2) return '<p class="note">Two or more readings needed to draw a trend.</p>';
  var span = Math.max(1, daysBetween(from, to));
  var vals = pts.map(function (p) { return p.kg; });
  var lo = Math.min.apply(null, vals) - 0.4, hi = Math.max.apply(null, vals) + 0.4;
  var X = function (d) { return PL + (daysBetween(from, d) / span) * (W - PL - PR); };
  var dots = pts.map(function (p) { return '<circle class="dot" cx="' + X(p.date).toFixed(1) + '" cy="' + sy(p.kg, lo, hi).toFixed(1) + '" r="2"/>'; }).join('');
  var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.date).toFixed(1) + ' ' + sy(avgWeight(p.date), lo, hi).toFixed(1); }).join(' ');
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Weight trend">' +
    '<line class="axis" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"/>' +
    '<text x="0" y="' + (PT + 4) + '">' + hi.toFixed(1) + '</text>' +
    '<text x="0" y="' + (H - PB) + '">' + lo.toFixed(1) + '</text>' +
    '<path class="avg" d="' + line + '"/>' + dots +
    '<text x="' + PL + '" y="' + (H - 6) + '">' + fmtShort(from) + '</text>' +
    '<text x="' + (W - PR) + '" y="' + (H - 6) + '" text-anchor="end">' + fmtShort(to) + '</text>' +
    '</svg>';
}

function intakeChart(days) {
  var end = todayISO(), rows = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = addDays(end, -i);
    rows.push({ d: d, c: consumedOn(d), b: budgetOn(d) });
  }
  var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.c, r.b || 0); })) * 1.12 || 2000;
  var bw = (W - PL - PR) / days;
  var bars = rows.map(function (r, i) {
    if (!r.c) return '';
    var y = sy(r.c, 0, max), x = PL + i * bw + bw * 0.15;
    return '<rect class="cbar' + (r.b && r.c > r.b ? ' over' : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
      '" width="' + (bw * 0.7).toFixed(1) + '" height="' + Math.max(1, H - PB - y).toFixed(1) + '" rx="1.5"/>';
  }).join('');
  var budgetLine = rows.map(function (r, i) {
    if (r.b == null) return '';
    var y = sy(r.b, 0, max).toFixed(1);
    return 'M' + (PL + i * bw).toFixed(1) + ' ' + y + 'H' + (PL + (i + 1) * bw).toFixed(1);
  }).join(' ');
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily intake">' +
    '<line class="axis" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"/>' +
    '<text x="0" y="' + (PT + 4) + '">' + n0(max) + '</text>' +
    bars + '<path class="budget" fill="none" d="' + budgetLine + '"/>' +
    '<text x="' + PL + '" y="' + (H - 6) + '">' + fmtShort(rows[0].d) + '</text>' +
    '<text x="' + (W - PR) + '" y="' + (H - 6) + '" text-anchor="end">Today</text>' +
    '</svg>';
}

/* =========================== history =========================== */
var histRange = 30;
function renderHistory() {
  var today = todayISO();
  var first = firstTracked() || S.createdAt;
  var firstW = S.weights.length ? S.weights[0].date : today;
  var start = histRange === 0 ? (first < firstW ? first : firstW) : addDays(today, -(histRange - 1));
  if (start > today) start = today;

  // cumulative balance vs maintenance over every tracked day
  var deficit = 0, tracked = 0, intake = 0;
  for (var d = first; d <= today; d = addDays(d, 1)) {
    var c = consumedOn(d);
    if (!c) continue;
    var m = maintenanceOn(d);
    if (m == null) continue;
    tracked++; intake += c; deficit += m - c;
  }
  var projected = -deficit / KCAL_PER_KG;
  var wStart = avgWeight(first), wNow = avgWeight(today);
  var actual = (wStart != null && wNow != null) ? wNow - wStart : null;
  var measured = (tracked >= 14 && actual != null && S.weights.length >= 4)
    ? (intake - actual * KCAL_PER_KG) / tracked : null;
  var est = maintenanceOn(today);

  app.innerHTML =
    '<div class="bar"><button class="iconbtn" id="back">' + ICON.back + '</button><div class="title">HISTORY</div><div style="width:40px"></div></div>' +
    '<div class="seg" role="group">' + [30, 90, 0].map(function (r) {
      return '<button data-r="' + r + '" aria-pressed="' + (histRange === r) + '">' + (r ? r + ' days' : 'All') + '</button>';
    }).join('') + '</div>' +

    '<div class="card"><h2>Weight</h2>' +
      (wNow != null
        ? '<div class="stat"><span class="v">' + wNow.toFixed(1) + '</span><span class="u">kg · 7-day average</span></div>' +
          (actual != null ? '<div class="note" style="margin-top:2px">' +
            '<span class="' + (actual < 0 ? 'pos' : actual > 0 ? 'neg' : 'dim') + '">' + (actual > 0 ? '+' : '') + actual.toFixed(1) + ' kg</span> since ' + fmtShort(first) + '</div>' : '')
        : '<p class="note">No readings yet.</p>') +
      weightChart(start, today) +
    '</div>' +

    '<div class="card"><h2>Daily intake</h2>' +
      intakeChart(histRange === 90 ? 30 : 14) +
      '<p class="note">Bars are what you ate; the dashed line is that day’s budget. Red means over.</p>' +
    '</div>' +

    '<div class="card"><h2>Deficit</h2>' +
      '<div class="stat"><span class="v ' + (deficit > 0 ? 'pos' : deficit < 0 ? 'neg' : '') + '">' + signed(deficit) + '</span><span class="u">kcal over ' + tracked + ' tracked day' + (tracked === 1 ? '' : 's') + '</span></div>' +
      '<div class="mt">' +
        '<div class="kv"><span>Projected weight change</span><span>' + (projected > 0 ? '+' : '') + projected.toFixed(2) + ' kg</span></div>' +
        '<div class="kv"><span>Measured weight change</span><span>' + (actual != null ? (actual > 0 ? '+' : '') + actual.toFixed(2) + ' kg' : '—') + '</span></div>' +
        (tracked ? '<div class="kv"><span>Average deficit / day</span><span>' + signed(deficit / tracked) + ' kcal</span></div>' : '') +
      '</div>' +
      (measured != null
        ? '<p class="note">Your <b>measured</b> maintenance is about <b>' + n0(measured) + ' kcal/day</b>; the formula estimates ' + n0(est) + '. ' +
          (Math.abs(measured - est) > 150
            ? 'They differ by ' + n0(Math.abs(measured - est)) + ' — consider moving your activity level ' + (measured > est ? 'up' : 'down') + ' a step.'
            : 'Close enough — your settings look right.') + '</p>'
        : '<p class="note">After about two weeks of consistent logging, this card will compare your projection against the scale and tell you whether your activity setting is right.</p>') +
    '</div>' +

    '<div class="card"><h2>Weeks</h2>' + weekTable() + '</div>';

  app.querySelector('#back').onclick = function () { location.hash = '#/'; };
  Array.prototype.forEach.call(app.querySelectorAll('[data-r]'), function (b) {
    b.onclick = function () { histRange = +b.getAttribute('data-r'); renderHistory(); };
  });
}

function weekTable() {
  var first = firstTracked() || S.createdAt;
  var ws = weekStart(todayISO()), out = [], guard = 0;
  while (ws >= weekStart(first) && guard++ < 60) {
    var end = addDays(ws, 6), days = 0, intake = 0, budget = 0, bal = 0;
    for (var i = 0; i < 7; i++) {
      var d = addDays(ws, i);
      if (d > todayISO()) break;
      var c = consumedOn(d);
      if (!c) continue;
      var m = maintenanceOn(d), b = budgetOn(d);
      days++; intake += c; budget += (b || 0); bal += (m == null ? 0 : m - c);
    }
    if (days) {
      out.push('<div class="kv"><span>' + fmtShort(ws) + ' – ' + fmtShort(end > todayISO() ? todayISO() : end) +
        ' <span class="dim">· ' + days + 'd · ø ' + n0(intake / days) + '</span></span>' +
        '<span class="' + (bal > 0 ? 'pos' : 'neg') + '">' + signed(bal) + '</span></div>');
    }
    ws = addDays(ws, -7);
  }
  return out.length ? out.join('') : '<p class="note">Nothing logged yet.</p>';
}

/* =========================== profile form =========================== */
function profileFields(p) {
  var thisYear = new Date().getFullYear();
  return '' +
    '<label class="f"><span>Sex (for the BMR formula)</span><select name="sex">' +
      ['male', 'female'].map(function (s) { return '<option value="' + s + '"' + (p.sex === s ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="f"><span>Year of birth</span><input name="birthYear" type="number" inputmode="numeric" min="' + (thisYear - 100) + '" max="' + (thisYear - 12) + '" required value="' + (p.birthYear || '') + '" placeholder="1990"></label>' +
    '<label class="f"><span>Height (cm)</span><input name="heightCm" type="number" inputmode="numeric" min="120" max="230" required value="' + (p.heightCm || '') + '" placeholder="180"></label>' +
    '<label class="f"><span>Activity level</span><select name="activity">' +
      Object.keys(ACTIVITY).map(function (k) { return '<option value="' + k + '"' + (p.activity === k ? ' selected' : '') + '>' + ACTIVITY[k].label + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="f"><span>Goal</span><select name="goal">' +
      GOALS.map(function (g) { return '<option value="' + g.v + '"' + (p.goalKgPerWeek === g.v ? ' selected' : '') + '>' + g.label + '</option>'; }).join('') +
    '</select></label>';
}
function readProfile(form) {
  return {
    sex: form.sex.value,
    birthYear: +form.birthYear.value,
    heightCm: +form.heightCm.value,
    activity: form.activity.value,
    goalKgPerWeek: +form.goal.value
  };
}

/* =========================== onboarding =========================== */
function renderOnboarding() {
  app.innerHTML =
    '<div class="bar"><div class="title">SET UP</div></div>' +
    '<p class="note" style="margin:0 0 20px">Your daily budget comes from the Mifflin–St Jeor equation, so it needs a few numbers once. Everything stays on this device.</p>' +
    '<form id="p">' + profileFields({ sex: 'male', activity: 'light', goalKgPerWeek: -0.5 }) +
      '<label class="f"><span>Current weight (kg)</span><input name="kg" type="number" inputmode="decimal" step="0.1" min="25" max="400" required placeholder="75.0"></label>' +
      '<button class="btn" type="submit">Start tracking</button>' +
    '</form>';
  app.querySelector('#p').onsubmit = function (e) {
    e.preventDefault();
    var f = e.target;
    S.profile = readProfile(f);
    S.createdAt = todayISO();
    S.weights = [{ date: todayISO(), kg: Math.round(+f.kg.value * 10) / 10 }];
    save();
    location.hash = '#/';
    render();
  };
}

/* =========================== settings =========================== */
function renderSettings() {
  var today = todayISO();
  var m = maintenanceOn(today), b = budgetOn(today), w = weightOn(today);
  app.innerHTML =
    '<div class="bar"><button class="iconbtn" id="back">' + ICON.back + '</button><div class="title">SETTINGS</div><div style="width:40px"></div></div>' +
    '<div class="card"><h2>Today’s numbers</h2>' +
      '<div class="kv"><span>Maintenance (TDEE)</span><span>' + (m ? n0(m) + ' kcal' : '—') + '</span></div>' +
      '<div class="kv"><span>Daily budget</span><span>' + (b ? n0(b) + ' kcal' : '—') + '</span></div>' +
      '<div class="kv"><span>Carried over</span><span>' + (b ? signed(bankFor(today)) + ' kcal' : '—') + '</span></div>' +
      '<div class="kv"><span>Weekly budget</span><span>' + (b ? n0(weekStats(today).budget) + ' kcal' : '—') + '</span></div>' +
    '</div>' +
    '<div class="card"><h2>Profile</h2><form id="p">' + profileFields(S.profile || {}) +
      '<button class="btn" type="submit">Save profile</button></form></div>' +
    '<div class="card"><h2>Rollover</h2>' +
      '<div class="toggle"><label for="cap">Cap carried-over surplus at one day’s budget</label>' +
      '<input type="checkbox" id="cap"' + (S.settings.capRollover ? ' checked' : '') + '></div>' +
      '<p class="note">Unspent calories roll into the rest of the week each night; the week resets Sunday at midnight. The cap stops a skipped day from handing you a huge allowance.</p>' +
    '</div>' +
    '<div class="card"><h2>Weight</h2>' +
      '<button class="btn secondary" id="wt">' + (w ? 'Edit today’s weight (' + w.kg.toFixed(1) + ' kg)' : 'Log today’s weight') + '</button>' +
      '<button class="btn ghost mt" id="wy">Log a missed day</button>' +
    '</div>' +
    '<div class="card"><h2>Data</h2>' +
      '<p class="note" style="margin-top:0">' + S.entries.length + ' entries · ' + S.weights.length + ' weight readings, stored only in this browser.</p>' +
      '<button class="btn danger mt" id="erase">Erase everything</button>' +
    '</div>';

  app.querySelector('#back').onclick = function () { location.hash = '#/'; };
  app.querySelector('#p').onsubmit = function (e) {
    e.preventDefault();
    S.profile = readProfile(e.target);
    save(); renderSettings(); toast('Profile saved');
  };
  app.querySelector('#cap').onchange = function (e) { S.settings.capRollover = e.target.checked; save(); };
  app.querySelector('#wt').onclick = function () { weightSheet(today); };
  app.querySelector('#wy').onclick = function () { backfillSheet(); };
  app.querySelector('#erase').onclick = function () {
    if (!confirm('Delete all weights and entries from this browser? This cannot be undone.')) return;
    if (!confirm('Really erase everything?')) return;
    localStorage.removeItem(KEY);
    S = blank();
    location.hash = '#/';
    render();
  };
}

/* =========================== backfill =========================== */
function backfillSheet() {
  var today = todayISO();
  var days = [];
  for (var i = 1; i <= 7; i++) days.push(addDays(today, -i));
  openSheet(
    '<h2>Log a missed day</h2>' +
    '<div class="rows">' + days.map(function (d) {
      var w = weightOn(d), c = consumedOn(d);
      return '<button class="row" data-d="' + d + '"><span class="lbl">' + fmtDay(d) + '</span>' +
        '<span class="kcal">' + (w ? w.kg.toFixed(1) + ' kg' : 'no weight') + ' · ' + (c ? n0(c) + ' kcal' : 'no food') + '</span></button>';
    }).join('') + '</div>' +
    '<p class="note">Pick a day, then choose what to add.</p>',
    function (root) {
      Array.prototype.forEach.call(root.querySelectorAll('[data-d]'), function (b) {
        b.onclick = function () {
          var d = b.getAttribute('data-d');
          openSheet('<h2>' + fmtDay(d) + '</h2>' +
            '<button class="btn" id="bf">Add food</button>' +
            '<button class="btn secondary mt" id="bw">' + (weightOn(d) ? 'Edit weight' : 'Add weight') + '</button>',
            function (r2) {
              r2.querySelector('#bf').onclick = function () { foodSheet(d); };
              r2.querySelector('#bw').onclick = function () { weightSheet(d); };
            });
        };
      });
    }
  );
}

/* =========================== Open Food Facts ===========================
   Public API, no key, CORS open. Text search is rate limited to a handful of
   requests a minute per IP, so it runs on submit only — never per keystroke.
   Product lookups are far more generous and are cached in S.foods so a repeat
   scan of the same item works offline. Data is ODbL; see the README.
------------------------------------------------------------------------- */
var OFF_BASE = 'https://de.openfoodfacts.org';
// Browsers forbid setting User-Agent, so the app identifies itself in the query.
var OFF_ID = 'app_name=budget-tracker&app_version=1.0';
var OFF_FIELDS = 'code,product_name,product_name_de,brands,quantity,serving_size,nutriments';
var offResults = {};  // query -> products, for this session only

function parseServing(s) {
  if (!s) return null;
  var m = String(s).match(/(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i);
  if (!m) return null;
  var v = Math.round(parseFloat(m[1].replace(',', '.')));
  return v > 0 && v < 2000 ? v : null;
}
function offNorm(p) {
  var n = p.nutriments || {};
  var per100 = n['energy-kcal_100g'];
  return {
    code: String(p.code || ''),
    name: String(p.product_name_de || p.product_name || '').trim().slice(0, 60),
    brand: String(p.brands || '').split(',')[0].trim().slice(0, 28),
    per100: per100 == null ? null : Math.round(per100),
    servingG: parseServing(p.serving_size),
    qty: String(p.quantity || '').trim()
  };
}
function offGet(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
function offSearch(q) {
  if (offResults[q]) return Promise.resolve(offResults[q]);
  var url = OFF_BASE + '/cgi/search.pl?search_simple=1&action=process&json=1&page_size=12' +
    '&fields=' + OFF_FIELDS + '&' + OFF_ID + '&search_terms=' + encodeURIComponent(q);
  return offGet(url).then(function (j) {
    var out = (j.products || []).map(offNorm).filter(function (p) { return p.name && p.per100 != null; });
    offResults[q] = out;
    return out;
  });
}
function offProduct(code) {
  if (S.foods[code]) return Promise.resolve(S.foods[code]);
  var url = OFF_BASE + '/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + OFF_FIELDS + '&' + OFF_ID;
  return offGet(url).then(function (j) {
    if (!j.product) return null;
    var p = offNorm(j.product);
    if (!p.name || p.per100 == null) return null;
    S.foods[code] = p;
    save();
    return p;
  });
}
function offError() {
  return navigator.onLine === false
    ? 'You are offline. Your own foods still work — or add it by hand.'
    : 'Open Food Facts did not answer. Your own foods still work — or add it by hand.';
}

/* =========================== search sheet =========================== */
function searchSheet(date, prefill) {
  openSheet(
    '<h2>Search food</h2>' +
    '<form id="s"><div class="searchrow">' +
      '<input name="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="e.g. Vollkornbrot" value="' + (prefill ? esc(prefill) : '') + '">' +
      '<button class="btn" type="submit">Go</button>' +
    '</div></form>' +
    '<div id="res"><p class="note">Searches the German Open Food Facts database. Pick a product, then set your portion.</p></div>' +
    '<button class="btn ghost mt" id="manual">Enter calories by hand</button>',
    function (root) {
      var form = root.querySelector('#s'), res = root.querySelector('#res');
      setTimeout(function () { form.q.focus(); }, 320);
      root.querySelector('#manual').onclick = function () { foodSheet(date); };
      form.onsubmit = function (e) {
        e.preventDefault();
        var q = form.q.value.trim();
        if (q.length < 2) { toast('Type at least two characters'); return; }
        res.innerHTML = '<p class="note">Searching…</p>';
        offSearch(q).then(function (list) {
          if (!list.length) {
            res.innerHTML = '<p class="note">Nothing found for “' + esc(q) + '”. Try a shorter or more common term.</p>';
            return;
          }
          res.innerHTML = '<div class="rows">' + list.map(function (p, i) {
            return '<button class="row" data-p="' + i + '">' +
              '<span class="lbl"><b>' + esc(p.name) + '</b>' +
              (p.brand ? '<em>' + esc(p.brand) + '</em>' : '') + '</span>' +
              '<span class="kcal">' + p.per100 + ' / 100 g</span></button>';
          }).join('') + '</div>';
          Array.prototype.forEach.call(res.querySelectorAll('[data-p]'), function (b) {
            b.onclick = function () { portionSheet(date, list[+b.getAttribute('data-p')]); };
          });
        }).catch(function () {
          res.innerHTML = '<p class="note">' + offError() + '</p>';
        });
      };
    }
  );
}

/* =========================== portion sheet =========================== */
function portionSheet(date, p) {
  var presets = [];
  if (p.servingG) presets.push({ g: p.servingG, label: '1 serving' });
  [30, 50, 100, 200].forEach(function (g) {
    if (!presets.some(function (x) { return x.g === g; })) presets.push({ g: g, label: g + ' g' });
  });
  var start = p.servingG || 100;
  openSheet(
    '<h2>' + esc(p.name) + '</h2>' +
    '<p class="note" style="margin-top:-8px">' + (p.brand ? esc(p.brand) + ' · ' : '') + p.per100 + ' kcal / 100 g' +
      (p.qty ? ' · ' + esc(p.qty) : '') + '</p>' +
    '<div class="chips">' + presets.map(function (x, i) {
      return '<button class="chip" data-g="' + x.g + '">' + esc(x.label) + (x.label === '1 serving' ? ' <b>' + x.g + ' g</b>' : '') + '</button>';
    }).join('') + '</div>' +
    '<form id="pf">' +
      '<label class="f"><span>Amount (g)</span><input name="g" type="number" inputmode="decimal" min="1" max="5000" step="1" required value="' + start + '"></label>' +
      '<div class="calcout"><span id="out">' + Math.round(p.per100 * start / 100) + '</span> kcal</div>' +
      '<button class="btn mt" type="submit">Add</button>' +
    '</form>' +
    '<button class="btn ghost mt" id="back2">Back to search</button>',
    function (root) {
      var form = root.querySelector('#pf'), out = root.querySelector('#out');
      var recalc = function () {
        var g = +form.g.value;
        out.textContent = g > 0 ? n0(p.per100 * g / 100) : '0';
      };
      form.g.oninput = recalc;
      Array.prototype.forEach.call(root.querySelectorAll('[data-g]'), function (b) {
        b.onclick = function () { form.g.value = b.getAttribute('data-g'); recalc(); };
      });
      root.querySelector('#back2').onclick = function () { searchSheet(date); };
      form.onsubmit = function (e) {
        e.preventDefault();
        var g = +form.g.value;
        if (!(g > 0)) { toast('Enter an amount'); return; }
        var kcal = Math.round(p.per100 * g / 100);
        S.entries.push({
          id: uid(), date: date, label: p.name + ' · ' + Math.round(g) + ' g',
          kcal: kcal, grams: Math.round(g), per100: p.per100, code: p.code, ts: Date.now()
        });
        save(); closeSheet(); render(); toast(p.name + ' · ' + n0(kcal) + ' kcal');
      };
    }
  );
}

/* =========================== barcode scanner ===========================
   Native BarcodeDetector where it exists (Chrome, Android); ZXing lazily
   pulled from a CDN only when the button is tapped, so the offline core stays
   dependency free. Both paths share one camera stream.
------------------------------------------------------------------------- */
var ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
var CAM = {
  possible: function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  }
};
function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = function () { rej(new Error('script')); };
    document.head.appendChild(s);
  });
}
function scanSheet(date) {
  openSheet(
    '<h2>Scan barcode</h2>' +
    '<div class="scanbox"><video id="vid" playsinline muted autoplay></video><div class="scanline"></div></div>' +
    '<p class="note" id="stat">Starting the camera…</p>' +
    '<button class="btn secondary mt" id="tosearch">Search by name instead</button>',
    function (root) {
      var video = root.querySelector('#vid'), stat = root.querySelector('#stat');
      var stream = null, reader = null, raf = 0, done = false;

      function stop() {
        done = true;
        if (raf) cancelAnimationFrame(raf);
        if (reader) { try { reader.reset(); } catch (e) {} reader = null; }
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      }
      sheetCleanup = stop;
      root.querySelector('#tosearch').onclick = function () { searchSheet(date); };

      function found(code) {
        if (done) return;
        stop();
        stat.textContent = 'Looking up ' + code + '…';
        offProduct(code).then(function (p) {
          if (p) portionSheet(date, p);
          else {
            stat.innerHTML = 'Barcode <b>' + esc(code) + '</b> is not in Open Food Facts (or has no calories listed). ' +
              'Add it by hand, or search by name.';
          }
        }).catch(function () { stat.textContent = offError(); });
      }

      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
        .then(function (s) {
          if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          video.srcObject = s;
          return video.play().catch(function () {});
        })
        .then(function () {
          if (done || !stream) return;
          if (window.BarcodeDetector) return nativeScan();
          stat.textContent = 'Loading the scanner…';
          return loadScript(ZXING_URL).then(zxingScan);
        })
        .catch(function (e) {
          stat.textContent = (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
            ? 'Camera access was denied. Search by name instead.'
            : 'No camera available here. Search by name instead.';
        });

      function nativeScan() {
        return BarcodeDetector.getSupportedFormats().then(function (all) {
          var want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(function (f) { return all.indexOf(f) >= 0; });
          var det = new BarcodeDetector(want.length ? { formats: want } : undefined);
          stat.textContent = 'Point the camera at the barcode.';
          var tick = function () {
            if (done) return;
            det.detect(video).then(function (codes) {
              if (codes && codes.length && codes[0].rawValue) found(codes[0].rawValue);
              else raf = requestAnimationFrame(tick);
            }).catch(function () { raf = requestAnimationFrame(tick); });
          };
          raf = requestAnimationFrame(tick);
        });
      }
      function zxingScan() {
        if (done || !window.ZXing) return;
        reader = new ZXing.BrowserMultiFormatReader();
        stat.textContent = 'Point the camera at the barcode.';
        reader.decodeFromStream(stream, video, function (result) {
          if (result && result.getText) found(result.getText());
        });
      }
    }
  );
}

/* =========================== router =========================== */
function render() {
  if (!S.profile) { renderOnboarding(); return; }
  var route = (location.hash || '#/').replace('#/', '');
  if (route.indexOf('history') === 0) renderHistory();
  else if (route.indexOf('settings') === 0) renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

// Roll the day over if the app is left open past midnight.
var openedOn = todayISO();
function checkDay() {
  if (todayISO() !== openedOn) { openedOn = todayISO(); render(); }
}
setInterval(checkDay, 30000);
document.addEventListener('visibilitychange', function () { if (!document.hidden) checkDay(); });

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}
