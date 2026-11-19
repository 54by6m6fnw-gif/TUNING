import {
  FUELS, ROLES, parseLog, detectRoles, timeInfo, parseTableText, parseAxisText, buildTable,
  toDisplay, displayIndex, tableToText, correctVE, VE_DEFAULTS, knockReview, suggestTiming, makeTable,
} from './core.js';
import { buildBaseMap, BUILD_DEFAULTS, DEFAULT_RPM_AXIS, DEFAULT_MAP_AXIS } from './basemap.js';
import { sampleData } from './sample.js';
import { initTuneCheck, isTuneFile, loadTuneToCheck } from './tunecheck-ui.js';

const $ = (id) => document.getElementById(id);
const state = { log: null, logName: '', roles: {}, ve: null, veResult: null, veView: 'new', base: null, knock: null, charts: [] };

// ---------------------------------------------------------------- storage

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem('tuning.' + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('tuning.' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

function persistField(id, key = id) {
  const el = $(id);
  const saved = store.get('f.' + key, null);
  if (saved != null) {
    if (el.type === 'checkbox') el.checked = saved;
    else el.value = saved;
  }
  el.addEventListener('change', () => store.set('f.' + key, el.type === 'checkbox' ? el.checked : el.value));
  if (el.tagName === 'TEXTAREA') el.addEventListener('input', () => store.set('f.' + key, el.value));
}

// ---------------------------------------------------------------- ui helpers

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function setMsg(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + kind;
}

async function copyText(text, what = 'Table') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${what} copied`);
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stoich() {
  return (FUELS[$('fuel').value] || FUELS.gas).stoich;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '');

// Diverging color: positive = more fuel / lean (orange), negative = rich (blue).
function divColor(v, maxAbs) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '';
  const t = Math.min(1, Math.abs(v) / maxAbs);
  const [r, g, b] = v > 0 ? [255, 122, 26] : [61, 139, 253];
  const a = 0.12 + 0.68 * t;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// Sequential color for raw values (low = blue, high = red).
function seqColor(v, lo, hi) {
  if (!Number.isFinite(v) || hi <= lo) return '';
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const hue = 225 - 225 * t;
  return `hsl(${hue.toFixed(0)} 55% ${(24 + 8 * t).toFixed(0)}%)`;
}

// Renders a table in the same orientation the user pasted it.
function renderGrid(container, table, cellFn) {
  const d = toDisplay(table);
  const idx = displayIndex(table);
  const corner = d.rowsAre === 'map' ? 'kPa \\ RPM' : 'RPM \\ kPa';
  let html = `<table class="grid"><thead><tr><th class="corner">${corner}</th>`;
  html += d.colAxis.map((v) => `<th>${v}</th>`).join('') + '</tr></thead><tbody>';
  d.grid.forEach((row, r) => {
    html += `<tr><th>${d.rowAxis[r]}</th>`;
    row.forEach((_, c) => {
      const [mi, ri] = idx(r, c);
      const cell = cellFn(mi, ri);
      const style = cell.bg ? ` style="background:${cell.bg}"` : '';
      const cls = cell.dim ? ' class="dim"' : '';
      html += `<td${cls}${style} title="${esc(cell.title || '')}">${cell.text}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
  container.classList.remove('empty');
}

// ---------------------------------------------------------------- tabs

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => s.toggleAttribute('data-active', s.id === 'tab-' + name));
  store.set('tab', name);
  if (name === 'viewer') renderCharts();
}

// ---------------------------------------------------------------- log loading

function loadLog(text, name) {
  try {
    const log = parseLog(text);
    state.log = log;
    state.logName = name;
    state.roles = detectRoles(log.headers);
    const saved = store.get('roles.' + log.headers.join('|'), null);
    if (saved) Object.assign(state.roles, saved);
    renderLogBar();
    renderChannelPicks();
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    if (document.querySelector('#tab-viewer[data-active]')) renderCharts();
    toast(`Loaded ${log.length.toLocaleString()} rows`);
  } catch (e) {
    toast(e.message);
    console.error(e);
  }
}

function renderLogBar() {
  const { log, roles } = state;
  $('logBar').hidden = false;
  $('logName').textContent = state.logName;
  const ti = timeInfo(log, roles);
  const secs = ti.t[ti.t.length - 1] || 0;
  const hz = ti.dt > 0 ? Math.round(1 / ti.dt) : 0;
  $('logStats').textContent = `${log.length.toLocaleString()} rows, ${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s, about ${hz} samples/s, ${log.headers.length} channels`;

  const found = ROLES.filter((r) => roles[r.key] >= 0).length;
  $('channelsSummary').textContent = `(${found} of ${ROLES.length} matched)`;
  const opts = ['<option value="-1">(none)</option>', ...log.headers.map((h, k) => `<option value="${k}">${esc(h)}</option>`)].join('');
  $('channelGrid').innerHTML = ROLES.map(
    (r) => `<label class="field"><span>${r.label}</span><select data-role="${r.key}">${opts}</select></label>`,
  ).join('');
  $('channelGrid').querySelectorAll('select').forEach((sel) => {
    sel.value = String(roles[sel.dataset.role]);
    sel.addEventListener('change', () => {
      state.roles[sel.dataset.role] = Number(sel.value);
      store.set('roles.' + log.headers.join('|'), state.roles);
      renderLogBar();
      renderChannelPicks();
    });
  });
  $('targetBox').hidden = roles.target >= 0;
}

// ---------------------------------------------------------------- tables from inputs

function fillAxesFromPaste(textId, rpmId, mapId, rowsId) {
  const text = $(textId).value;
  if (!text.trim()) return;
  try {
    const p = parseTableText(text);
    const isRpm = (a) => a && Math.max(...a) >= 1000;
    if (p.colAxis && p.rowAxis) {
      const rowsAre = isRpm(p.rowAxis) ? 'rpm' : 'map';
      $(rowsId).value = rowsAre;
      $(rpmId).value = (rowsAre === 'rpm' ? p.rowAxis : p.colAxis).join(', ');
      $(mapId).value = (rowsAre === 'rpm' ? p.colAxis : p.rowAxis).join(', ');
    } else if (p.colAxis) {
      $(rowsId).value = isRpm(p.colAxis) ? 'map' : 'rpm';
      $(isRpm(p.colAxis) ? rpmId : mapId).value = p.colAxis.join(', ');
    } else if (p.rowAxis) {
      $(rowsId).value = isRpm(p.rowAxis) ? 'rpm' : 'map';
      $(isRpm(p.rowAxis) ? rpmId : mapId).value = p.rowAxis.join(', ');
    }
    [rpmId, mapId, rowsId].forEach((id) => $(id).dispatchEvent(new Event('change')));
  } catch {
    /* checked again on run */
  }
}

function tableFromInputs(textId, rpmId, mapId, rowsId, label) {
  const text = $(textId).value;
  if (!text.trim()) throw new Error(`Paste your ${label} first.`);
  const p = parseTableText(text);
  const rowsAre = $(rowsId).value;
  const rpm = parseAxisText($(rpmId).value);
  const map = parseAxisText($(mapId).value);
  const rowAxis = rowsAre === 'map' ? map : rpm;
  const colAxis = rowsAre === 'map' ? rpm : map;
  return buildTable(p.values, rowAxis, colAxis, rowsAre);
}

// ---------------------------------------------------------------- VE correction

const FILTER_KEYS = ['minCts', 'minRpm', 'maxTpsRate', 'maxMapRate', 'delayMs', 'minWeight', 'maxChangePct', 'strength', 'useCL', 'useLearn', 'skipDecel'];

function veOptions() {
  const o = { stoich: stoich() };
  for (const k of FILTER_KEYS) {
    const el = $('f_' + k);
    o[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return o;
}

function runVE() {
  try {
    if (!state.log) throw new Error('Load a datalog first.');
    const ve = tableFromInputs('veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre', 'VE table');
    const o = veOptions();
    if (state.roles.target < 0) {
      if ($('targetText').value.trim()) {
        const p = parseTableText($('targetText').value);
        const t = buildTable(p.values, ve.layout.rowsAre === 'map' ? displayAxis(ve, 'map') : displayAxis(ve, 'rpm'), ve.layout.rowsAre === 'map' ? displayAxis(ve, 'rpm') : displayAxis(ve, 'map'), ve.layout.rowsAre);
        o.targetTable = t;
      } else {
        const fixed = Number($('fixedTarget').value);
        if (!(fixed > 0)) throw new Error('Set a fixed target AFR or paste a target table.');
        o.targetTable = makeTable(ve.rpm, ve.map, () => fixed);
      }
    }
    const res = correctVE(state.log, state.roles, ve, o);
    state.ve = ve;
    state.veResult = res;
    renderVE();
    const msg = res.changed ? `${res.changed} cells changed. Copy the table and paste it into Holley EFI software.` : 'No cells had enough data to change. Lower "Min samples per cell" or log more steady driving.';
    setMsg('veMsg', msg, res.changed ? 'ok' : 'err');
  } catch (e) {
    setMsg('veMsg', e.message, 'err');
  }
}

function displayAxis(table, which) {
  const d = toDisplay(table);
  const rowsAreWhich = table.layout.rowsAre === which;
  return rowsAreWhich ? d.rowAxis : d.colAxis;
}

function renderVE() {
  const res = state.veResult;
  if (!res) return;
  const r = res.reasons;
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const stat = (label, v) => `<div class="stat"><b>${v}</b>${label}</div>`;
  $('veStats').innerHTML = [
    stat('rows used', `${r.used.toLocaleString()} / ${total.toLocaleString()}`),
    stat('cells changed', res.changed),
    stat('cold rows skipped', r.cold.toLocaleString()),
    stat('transient rows skipped', r.transient.toLocaleString()),
    stat('decel rows skipped', r.decel.toLocaleString()),
    stat('AFR out of range', r.afrRange.toLocaleString()),
    stat('wideband delay', `${res.shiftSamples} samples`),
  ].join('');

  const view = state.veView;
  const all = res.cells.flat();
  const maxChange = Math.max(3, ...all.map((c) => Math.abs(c.changePct)));
  const maxErr = Math.max(3, ...all.filter((c) => c.weight > 0).map((c) => Math.abs(c.afrErrPct)));
  const maxW = Math.max(1, ...all.map((c) => c.weight));
  const minW = Number($('f_minWeight').value);

  renderGrid($('veGrid'), res.table, (i, j) => {
    const c = res.cells[i][j];
    const title = `Old ${fmt(c.old)}  New ${fmt(c.newV)}  (${c.changePct >= 0 ? '+' : ''}${fmt(c.changePct)}%)\nAFR error ${fmt(c.afrErrPct)}%  Samples ${fmt(c.weight, 0)}`;
    const enough = c.weight >= minW;
    if (view === 'new') return { text: fmt(c.newV), bg: enough ? divColor(c.changePct, maxChange) : '', dim: !enough, title };
    if (view === 'change') return { text: enough ? (c.changePct >= 0 ? '+' : '') + fmt(c.changePct) : '', bg: enough ? divColor(c.changePct, maxChange) : '', dim: !enough, title };
    if (view === 'err') return { text: c.weight > 0 ? fmt(c.afrErrPct) : '', bg: c.weight > 0 ? divColor(c.afrErrPct, maxErr) : '', dim: !enough, title };
    return { text: c.weight > 0 ? fmt(c.weight, 0) : '', bg: c.weight > 0 ? seqColor(Math.log(1 + c.weight), 0, Math.log(1 + maxW)) : '', dim: !enough, title };
  });
  $('veLegend').innerHTML =
    view === 'hits'
      ? `<span>Weighted samples per cell. Cells below ${minW} keep their old value.</span>`
      : `<span><i style="background:rgba(255,122,26,.8)"></i>Lean, fuel added</span><span><i style="background:rgba(61,139,253,.8)"></i>Rich, fuel removed</span><span><i style="background:#14171a;border:1px solid #2b3035"></i>Not enough data, unchanged</span>`;
  $('veActions').hidden = false;
}

// ---------------------------------------------------------------- base map

const BASE_KEYS = ['displacement', 'camDuration', 'lsa', 'heads', 'compression', 'boostPsi', 'idleRpm', 'redline'];

function runBase() {
  try {
    const spec = { fuel: $('fuel').value };
    for (const k of BASE_KEYS) {
      const el = $('b_' + k);
      spec[k] = el.tagName === 'SELECT' ? el.value : Number(el.value);
    }
    const rpm = parseAxisText($('b_rpmAxis').value);
    const map = parseAxisText($('b_mapAxis').value);
    const rpmAsc = rpm.slice().sort((a, b) => a - b);
    const mapAsc = map.slice().sort((a, b) => a - b);
    const layout = { rowsAre: 'map', rowDesc: $('b_mapOrder').value === 'desc', colDesc: false };
    const b = buildBaseMap(spec, rpmAsc, mapAsc, layout);
    state.base = b;
    const blocks = [
      ['ve', 'VE', b.ve, 1, 'Fuel table'],
      ['timing', 'Ignition timing (deg BTDC)', b.timing, 1, 'Spark table'],
      ['afr', `Target AFR (${FUELS[spec.fuel].name})`, b.afr, 1, 'Target AFR table'],
    ];
    const host = $('baseResults');
    host.innerHTML = blocks
      .map(
        ([key, title]) => `<div class="table-block"><div class="results-head"><h2>${title}</h2><div class="actions" style="margin:0">
          <button class="btn primary" data-base-copy="${key}">Copy for Holley</button>
          <button class="btn" data-base-copy-axes="${key}">Copy with axes</button>
          ${key === 've' ? '<button class="btn" data-base-send="ve">Send to VE correction</button>' : ''}
          ${key === 'timing' ? '<button class="btn" data-base-send="timing">Send to knock tab</button>' : ''}
          ${key === 'afr' ? '<button class="btn" data-base-send="afr">Use as target AFR</button>' : ''}
        </div></div><div class="grid-wrap" id="base-${key}"></div></div>`,
      )
      .join('');
    for (const [key, , table, dec] of blocks) {
      const vals = table.v.flat();
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      renderGrid($('base-' + key), table, (i, j) => ({ text: table.v[i][j].toFixed(dec), bg: seqColor(table.v[i][j], lo, hi), title: '' }));
    }
    setMsg('baseMsg', `Estimated torque peak about ${Math.round(b.notes.torquePeak / 100) * 100} RPM. Treat these as a starting point only.`, 'ok');
  } catch (e) {
    setMsg('baseMsg', e.message, 'err');
  }
}

function baseTable(key) {
  return state.base && state.base[key];
}

function sendTableTo(table, textId, rpmId, mapId, rowsId) {
  $(textId).value = tableToText(table, { axes: true, decimals: 1 });
  const d = toDisplay(table);
  $(rowsId).value = d.rowsAre;
  $(rpmId).value = (d.rowsAre === 'map' ? d.colAxis : d.rowAxis).join(', ');
  $(mapId).value = (d.rowsAre === 'map' ? d.rowAxis : d.colAxis).join(', ');
  [textId, rpmId, mapId, rowsId].forEach((id) => $(id).dispatchEvent(new Event('change')));
  store.set('f.' + textId, $(textId).value);
}

// ---------------------------------------------------------------- knock

function runKnock() {
  try {
    if (!state.log) throw new Error('Load a datalog first.');
    let timing = null;
    let axes;
    if ($('timingText').value.trim()) {
      timing = tableFromInputs('timingText', 'tRpmAxis', 'tMapAxis', 'tRowsAre', 'timing table');
      axes = timing;
    } else {
      let rpm = DEFAULT_RPM_AXIS;
      let map = DEFAULT_MAP_AXIS;
      try {
        rpm = parseAxisText($('veRpmAxis').value).slice().sort((a, b) => a - b);
        map = parseAxisText($('veMapAxis').value).slice().sort((a, b) => a - b);
      } catch {
        /* use defaults */
      }
      axes = makeTable(rpm, map, () => 0);
    }
    const rev = knockReview(state.log, state.roles, axes, { threshold: Number($('k_threshold').value) || 0 });
    state.knock = rev;
    const worst = rev.events.reduce((m, e) => Math.max(m, e.maxRetard), 0);
    const ti = timeInfo(state.log, state.roles);
    const stat = (label, v) => `<div class="stat"><b>${v}</b>${label}</div>`;
    $('knockStats').innerHTML = [
      stat('knock events', rev.events.length),
      stat('worst retard', fmt(worst) + ' deg'),
      stat('time with retard', fmt(rev.samples * ti.dt, 1) + ' s'),
    ].join('');

    const maxR = Math.max(1, ...rev.cells.flat().map((c) => c.maxRetard));
    renderGrid($('knockGrid'), axes, (i, j) => {
      const c = rev.cells[i][j];
      return c.maxRetard > 0
        ? { text: fmt(c.maxRetard), bg: `rgba(248,81,73,${(0.2 + 0.7 * (c.maxRetard / maxR)).toFixed(2)})`, title: `Max retard ${fmt(c.maxRetard)} deg, ${c.count} samples` }
        : { text: '', title: '' };
    });

    const out = $('timingOut');
    if (timing && rev.events.length) {
      const sug = suggestTiming(timing, rev, { extra: Number($('k_extra').value) || 0 });
      state.knock.suggested = sug.table;
      out.innerHTML = `<div class="table-block"><div class="results-head"><h2>Suggested timing</h2><div class="actions" style="margin:0">
        <button class="btn primary" id="tCopy">Copy for Holley</button><button class="btn" id="tCopyAxes">Copy with axes</button></div></div>
        <div class="grid-wrap" id="timingGrid"></div></div>`;
      renderGrid($('timingGrid'), sug.table, (i, j) => {
        const ch = sug.changes[i][j];
        return { text: fmt(sug.table.v[i][j]), bg: ch < 0 ? 'rgba(61,139,253,.55)' : '', title: ch < 0 ? `Pulled ${-ch} deg` : '' };
      });
      $('tCopy').onclick = () => copyText(tableToText(sug.table, { decimals: 1 }), 'Timing table');
      $('tCopyAxes').onclick = () => copyText(tableToText(sug.table, { decimals: 1, axes: true }), 'Timing table');
    } else out.innerHTML = '';

    $('knockEvents').classList.toggle('muted', !rev.events.length);
    $('knockEvents').innerHTML = rev.events.length
      ? `<table><thead><tr><th>Time</th><th>RPM</th><th>MAP</th><th>Timing</th><th>Retard</th><th></th></tr></thead><tbody>${rev.events
          .slice(0, 300)
          .map(
            (e, n) =>
              `<tr><td>${fmt(e.start, 1)} s</td><td>${fmt(e.rpm, 0)}</td><td>${fmt(e.map, 0)}</td><td>${fmt(e.timing)}</td><td>${fmt(e.maxRetard)}</td><td><button data-event="${n}">View</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : 'No knock retard in this log.';
    setMsg('knockMsg', rev.events.length ? 'Check each event in the log viewer before trusting it.' : 'No knock found.', 'ok');
  } catch (e) {
    setMsg('knockMsg', e.message, 'err');
  }
}

// ---------------------------------------------------------------- log viewer

const DEFAULT_PICKS = ['rpm', 'map', 'afr', 'target', 'tps', 'timing', 'knock', 'clcomp'];
const COLORS = ['#ff7a1a', '#3d8bfd', '#3fb950', '#e3b341', '#d2a8ff', '#f85149', '#56d4dd', '#ff9bce'];

function renderChannelPicks() {
  const { log, roles } = state;
  const host = $('channelPicks');
  if (!log) return;
  const timeIdx = roles.time;
  let picks = store.get('picks.' + log.headers.join('|'), null);
  if (!picks) picks = DEFAULT_PICKS.map((k) => roles[k]).filter((k) => k >= 0);
  host.classList.remove('muted');
  host.innerHTML = log.headers
    .map((h, k) => (k === timeIdx ? '' : `<label><input type="checkbox" value="${k}" ${picks.includes(k) ? 'checked' : ''}> ${esc(h)}</label>`))
    .join('');
  host.querySelectorAll('input').forEach((cb) =>
    cb.addEventListener('change', () => {
      const sel = [...host.querySelectorAll('input:checked')].map((x) => Number(x.value));
      store.set('picks.' + log.headers.join('|'), sel);
      state.charts.forEach((c) => c.destroy());
      state.charts = [];
      renderCharts();
    }),
  );
}

function renderCharts() {
  const { log } = state;
  const host = $('charts');
  if (!log || !window.uPlot) return;
  if (state.charts.length) return;
  host.innerHTML = '';
  const picks = [...$('channelPicks').querySelectorAll('input:checked')].map((x) => Number(x.value));
  const t = timeInfo(log, state.roles).t;
  const width = Math.max(300, host.clientWidth || host.parentElement.clientWidth - 32);
  let syncing = false;
  picks.forEach((k, n) => {
    const div = document.createElement('div');
    div.className = 'chart';
    host.appendChild(div);
    const color = COLORS[n % COLORS.length];
    const u = new window.uPlot(
      {
        title: log.headers[k] + (log.units[k] ? ` (${log.units[k]})` : ''),
        width,
        height: 140,
        cursor: { sync: { key: 'log' }, drag: { x: true, y: false } },
        legend: { show: true },
        scales: { x: { time: false } },
        axes: [
          { stroke: '#8d959c', grid: { stroke: '#22272c' }, ticks: { stroke: '#2b3035' } },
          { stroke: '#8d959c', grid: { stroke: '#22272c' }, ticks: { stroke: '#2b3035' }, size: 50 },
        ],
        series: [{ label: 'Time (s)', value: (u, v) => (v == null ? '' : v.toFixed(2)) }, { label: log.headers[k], stroke: color, width: 1.25, points: { show: false } }],
        hooks: {
          setScale: [
            (u, key) => {
              if (key !== 'x' || syncing) return;
              syncing = true;
              const { min, max } = u.scales.x;
              state.charts.forEach((o) => o !== u && o.setScale('x', { min, max }));
              syncing = false;
            },
          ],
        },
      },
      [t, log.columns[k].map((v) => (Number.isFinite(v) ? v : null))],
      div,
    );
    state.charts.push(u);
  });
  if (!picks.length) host.innerHTML = '<p class="muted">Pick at least one channel.</p>';
}

function zoomTo(start, end) {
  showTab('viewer');
  const pad = Math.max(2, (end - start) * 2);
  state.charts.forEach((u) => u.setScale('x', { min: start - pad, max: end + pad }));
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $('charts').clientWidth;
    state.charts.forEach((u) => u.setSize({ width: Math.max(300, w), height: 140 }));
  }, 150);
});

// ---------------------------------------------------------------- init

function init() {
  $('fuel').innerHTML = Object.entries(FUELS)
    .map(([k, f]) => `<option value="${k}">${f.name} (${f.stoich})</option>`)
    .join('');
  $('fuel').value = 'e10';
  persistField('fuel');

  // defaults
  $('veRpmAxis').value = DEFAULT_RPM_AXIS.join(', ');
  $('veMapAxis').value = DEFAULT_MAP_AXIS.join(', ');
  $('tRpmAxis').value = DEFAULT_RPM_AXIS.join(', ');
  $('tMapAxis').value = DEFAULT_MAP_AXIS.join(', ');
  $('b_rpmAxis').value = DEFAULT_RPM_AXIS.join(', ');
  $('b_mapAxis').value = DEFAULT_MAP_AXIS.join(', ');
  for (const k of FILTER_KEYS) {
    const el = $('f_' + k);
    if (el.type === 'checkbox') el.checked = VE_DEFAULTS[k];
    else el.value = VE_DEFAULTS[k];
  }
  for (const k of BASE_KEYS) $('b_' + k).value = BUILD_DEFAULTS[k];

  ['veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre', 'targetText', 'fixedTarget', 'timingText', 'tRpmAxis', 'tMapAxis', 'tRowsAre', 'k_threshold', 'k_extra', 'b_rpmAxis', 'b_mapAxis', 'b_mapOrder']
    .concat(FILTER_KEYS.map((k) => 'f_' + k), BASE_KEYS.map((k) => 'b_' + k))
    .forEach((id) => persistField(id));

  $('veText').addEventListener('paste', () => setTimeout(() => fillAxesFromPaste('veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre'), 0));
  $('timingText').addEventListener('paste', () => setTimeout(() => fillAxesFromPaste('timingText', 'tRpmAxis', 'tMapAxis', 'tRowsAre'), 0));

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  showTab(store.get('tab', 've'));

  $('logFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    loadLog(await f.text(), f.name);
    e.target.value = '';
  });
  $('sampleBtn').addEventListener('click', () => {
    const s = sampleData();
    $('fuel').value = 'e10';
    $('fuel').dispatchEvent(new Event('change'));
    sendTableTo(s.ecuVe, 'veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre');
    sendTableTo(s.timing, 'timingText', 'tRpmAxis', 'tMapAxis', 'tRowsAre');
    loadLog(s.csv, 'Sample log (made up)');
  });

  // drag and drop a log anywhere
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (isTuneFile(f)) {
      showTab('tune');
      loadTuneToCheck(f);
    } else loadLog(await f.text(), f.name);
  });

  initTuneCheck();
  $('veRun').addEventListener('click', runVE);
  $('veView').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.veView = b.dataset.view;
      $('veView').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderVE();
    }),
  );
  document.querySelector('[data-copy="ve-values"]').addEventListener('click', () => state.veResult && copyText(tableToText(state.veResult.table, { decimals: 1 }), 'VE table'));
  document.querySelector('[data-copy="ve-axes"]').addEventListener('click', () => state.veResult && copyText(tableToText(state.veResult.table, { decimals: 1, axes: true }), 'VE table'));
  $('veDownload').addEventListener('click', () => state.veResult && download('ve-corrected.csv', tableToText(state.veResult.table, { decimals: 1, axes: true, delim: ',' })));
  $('veUseNew').addEventListener('click', () => {
    if (!state.veResult) return;
    sendTableTo(state.veResult.table, 'veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre');
    toast('Corrected table is now the current table. Load a new log and run again.');
  });

  $('baseRun').addEventListener('click', runBase);
  $('baseResults').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.baseCopy) copyText(tableToText(baseTable(b.dataset.baseCopy), { decimals: 1 }));
    if (b.dataset.baseCopyAxes) copyText(tableToText(baseTable(b.dataset.baseCopyAxes), { decimals: 1, axes: true }));
    if (b.dataset.baseSend === 've') {
      sendTableTo(baseTable('ve'), 'veText', 'veRpmAxis', 'veMapAxis', 'veRowsAre');
      showTab('ve');
      toast('VE table sent');
    }
    if (b.dataset.baseSend === 'timing') {
      sendTableTo(baseTable('timing'), 'timingText', 'tRpmAxis', 'tMapAxis', 'tRowsAre');
      showTab('knock');
      toast('Timing table sent');
    }
    if (b.dataset.baseSend === 'afr') {
      $('targetText').value = tableToText(baseTable('afr'), { decimals: 1 });
      $('targetText').dispatchEvent(new Event('input'));
      toast('Target AFR table set. It is used when a log has no target AFR channel.');
    }
  });

  $('knockRun').addEventListener('click', runKnock);
  $('knockEvents').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-event]');
    if (!b || !state.knock) return;
    const ev = state.knock.events[Number(b.dataset.event)];
    zoomTo(ev.start, ev.end);
  });
  $('viewerReset').addEventListener('click', () => {
    const t = state.log && timeInfo(state.log, state.roles).t;
    if (t) state.charts.forEach((u) => u.setScale('x', { min: t[0], max: t[t.length - 1] }));
  });
}

init();