// Core math for the TUNING app. Pure functions only (no DOM), so it runs in
// the browser and in Node tests.

export const FUELS = {
  gas: { name: 'Gasoline (E0)', stoich: 14.7 },
  e10: { name: 'Pump gas (E10)', stoich: 14.1 },
  e85: { name: 'E85', stoich: 9.8 },
  race: { name: 'Race gas', stoich: 14.8 },
  meth: { name: 'Methanol', stoich: 6.4 },
};

// ---------------------------------------------------------------- helpers

export function median(values) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round(v, step = 0.1) {
  const r = Math.round(v / step) * step;
  // trim float noise like 12.299999999
  return Number(r.toFixed(6));
}

const TIME_RE = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(\.\d+)?$/;

export function toNum(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s === '') return NaN;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(',', '.'));
  const t = TIME_RE.exec(s);
  if (t) {
    const frac = t[4] ? Number(t[4]) : 0;
    if (t[3] !== undefined) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) + frac;
    return Number(t[1]) * 60 + Number(t[2]) + frac;
  }
  const withUnit = /^(-?\d+(?:\.\d+)?)\s*[a-z%°]+$/i.exec(s);
  if (withUnit) return Number(withUnit[1]);
  return NaN;
}

export function detectDelimiter(lines) {
  const cands = ['\t', ',', ';'];
  let best = ',';
  let bestScore = -1;
  for (const d of cands) {
    const counts = lines.slice(0, 30).map((l) => splitLine(l, d).length);
    const score = median(counts);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function numericFrac(row) {
  const cells = row.filter((c) => String(c).trim() !== '');
  if (!cells.length) return 0;
  return cells.filter((c) => Number.isFinite(toNum(c))).length / cells.length;
}

// ---------------------------------------------------------------- datalog

// Parses a datalog exported as CSV/TSV. Finds the header row on its own,
// skips a units row if there is one, and returns one numeric array per column.
export function parseLog(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 3) throw new Error('That file has fewer than 3 lines, so it does not look like a datalog.');
  const delim = detectDelimiter(lines);
  const rows = lines.map((l) => splitLine(l, delim));

  let h = -1;
  for (let i = 0; i < Math.min(rows.length - 1, 200) && h < 0; i++) {
    const r = rows[i];
    if (r.length < 2) continue;
    if (numericFrac(r) > 0.4) continue;
    // data must follow right away, or after a single units row
    for (let j = i + 1; j <= i + 2 && j < rows.length; j++) {
      if (j === i + 2 && rows[i + 1].length !== r.length) break;
      const len = rows[j].length;
      if (numericFrac(rows[j]) >= 0.6 && len >= r.length * 0.8 && r.length >= len * 0.8) {
        h = i;
        break;
      }
    }
  }
  if (h < 0) throw new Error('Could not find a row of channel names followed by numbers. Export the log from Holley EFI software as CSV and try again.');

  const seen = {};
  const headers = rows[h].map((c, k) => {
    let name = c.trim().replace(/^"|"$/g, '') || `Column ${k + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`;
    else seen[name] = 1;
    return name;
  });

  let start = h + 1;
  let units = headers.map(() => '');
  if (numericFrac(rows[start]) < 0.5) {
    units = headers.map((_, k) => (rows[start][k] || '').trim());
    start++;
  }

  const columns = headers.map(() => []);
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (numericFrac(r) < 0.5) continue;
    for (let k = 0; k < headers.length; k++) columns[k].push(toNum(r[k]));
  }
  if (columns[0].length < 2) throw new Error('The log has a header row but almost no data rows.');
  return { headers, units, columns, length: columns[0].length };
}

// Channel roles the app understands, with header patterns in priority order.
export const ROLES = [
  { key: 'time', label: 'Time', pats: [/^rtc$/i, /^time\b/i, /elapsed/i, /timestamp/i, /\btime\b/i, /^sec/i] },
  { key: 'rpm', label: 'RPM', pats: [/^rpm$/i, /^engine ?rpm$/i, /engine speed/i, /\brpm\b/i], not: /target|idle|limit|max|min|rev/i },
  { key: 'map', label: 'MAP (kPa)', pats: [/^map$/i, /^map\b/i, /manifold.*(abs|pres)/i, /\bmap\b/i], not: /target|baro|sensor (high|low)|volt|tps/i },
  { key: 'afr', label: 'Measured AFR / lambda', pats: [/afr.*(avg|average)/i, /(avg|average).*afr/i, /^afr$/i, /afr.*(left|1|bank ?1)/i, /^(lambda|wideband|o2)/i, /\bafr\b/i, /lambda/i], not: /target|learn|comp|corr|err|cmd|command|right|bank ?2|\b2\b/i },
  { key: 'target', label: 'Target AFR / lambda', pats: [/target.*(afr|lambda)/i, /(afr|lambda).*target/i, /(cmd|command).*(afr|lambda)/i] },
  { key: 'tps', label: 'TPS (%)', pats: [/^tps$/i, /^tps\b/i, /throttle pos/i, /\btps\b/i, /throttle/i], not: /target|volt|rate/i },
  { key: 'cts', label: 'Coolant temp', pats: [/^cts$/i, /coolant/i, /\bect\b/i, /\bcts\b/i, /water/i] },
  { key: 'iat', label: 'Intake air temp', pats: [/^mat$/i, /^iat$/i, /manifold air/i, /intake air/i, /\bmat\b/i, /\biat\b/i, /air temp/i] },
  { key: 'clcomp', label: 'Closed loop comp (%)', pats: [/closed.?loop.*(comp|corr)/i, /\bcl ?comp/i, /(o2|fuel) corr/i, /short.?term/i, /\bstft\b/i] },
  { key: 'learn', label: 'Learn (%)', pats: [/^learn/i, /fuel.*learn/i, /learn/i, /long.?term/i, /\bltft\b/i], not: /timing|spark|idle|ign/i },
  { key: 'timing', label: 'Ignition timing', pats: [/ign(ition)?.*tim/i, /spark.*adv/i, /^timing$/i, /^advance$/i, /timing/i], not: /knock|target|retard|cam/i },
  { key: 'knock', label: 'Knock retard', pats: [/knock.*retard/i, /retard.*knock/i, /^knock$/i, /knock/i], not: /count|volt|sensor|level|thresh/i },
  { key: 'duty', label: 'Injector duty (%)', pats: [/duty/i, /\bidc\b/i] },
];

export function detectRoles(headers) {
  const used = new Set();
  const roles = {};
  for (const role of ROLES) {
    roles[role.key] = -1;
    outer: for (const pat of role.pats) {
      for (let k = 0; k < headers.length; k++) {
        if (used.has(k)) continue;
        const h = headers[k];
        if (role.not && role.not.test(h)) continue;
        if (pat.test(h)) {
          roles[role.key] = k;
          used.add(k);
          break outer;
        }
      }
    }
  }
  return roles;
}

export function channel(log, roles, key) {
  const k = roles[key];
  return k != null && k >= 0 ? log.columns[k] : null;
}

// Seconds per sample. Converts millisecond time columns to seconds.
export function timeInfo(log, roles) {
  const t = channel(log, roles, 'time');
  if (!t) return { t: log.columns[0].map((_, i) => i * 0.05), dt: 0.05, guessed: true };
  const diffs = [];
  for (let i = 1; i < Math.min(t.length, 2000); i++) diffs.push(t[i] - t[i - 1]);
  let dt = median(diffs);
  let scale = 1;
  if (dt > 5) scale = 0.001; // milliseconds
  dt *= scale;
  if (!(dt > 0)) return { t: log.columns[0].map((_, i) => i * 0.05), dt: 0.05, guessed: true };
  const t0 = t.find((v) => Number.isFinite(v)) || 0;
  return { t: t.map((v) => (v - t0) * scale), dt, guessed: false };
}

// Converts an AFR or lambda channel to lambda.
export function toLambda(values, stoich) {
  const med = median(values);
  const isLambda = med < 2;
  return { lam: values.map((v) => (isLambda ? v : v / stoich)), isLambda };
}

// ---------------------------------------------------------------- tables

// Parses a pasted table. Returns the value grid plus any axes found on the
// first row / first column. Accepts tabs, commas or spaces.
export function parseTableText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('The table is empty.');
  let delim = detectDelimiter(lines);
  let rows = lines.map((l) => splitLine(l, delim));
  if (median(rows.map((r) => r.length)) < 2) {
    rows = lines.map((l) => l.trim().split(/\s+/));
    delim = ' ';
  }
  // drop trailing empty cells
  rows = rows.map((r) => {
    const c = r.slice();
    while (c.length && String(c[c.length - 1]).trim() === '') c.pop();
    return c;
  });
  const num = rows.map((r) => r.map(toNum));
  const width = Math.max(...num.map((r) => r.length));
  const grid = num.map((r) => {
    const c = r.slice();
    while (c.length < width) c.push(NaN);
    return c;
  });

  const corner = grid[0][0];
  const firstRow = grid[0].slice(1);
  const firstCol = grid.slice(1).map((r) => r[0]);
  const rowIsAxis = isAxis(firstRow);
  const colIsAxis = isAxis(firstCol);
  const cornerBlank = !Number.isFinite(corner);

  let colAxis = null;
  let rowAxis = null;
  let values = grid;
  if (cornerBlank && rowIsAxis && colIsAxis) {
    colAxis = firstRow;
    rowAxis = firstCol;
    values = grid.slice(1).map((r) => r.slice(1));
  } else if (cornerBlank && rowIsAxis) {
    colAxis = firstRow;
    values = grid.slice(1).map((r) => r.slice(1));
  } else if (cornerBlank && colIsAxis) {
    rowAxis = firstCol;
    values = grid.slice(1).map((r) => r.slice(1));
  } else if (!cornerBlank && looksLikeRpm(grid[0]) && isAxis(grid[0])) {
    // header row of RPM without a corner cell
    colAxis = grid[0];
    values = grid.slice(1);
    const fc = values.map((r) => r[0]);
    if (values[0].length === colAxis.length + 1 && isAxis(fc)) {
      rowAxis = fc;
      values = values.map((r) => r.slice(1));
    }
  } else if (cornerBlank) {
    values = grid.slice(1).map((r) => r.slice(1));
  }
  if (!values.length || !values[0].length) throw new Error('Could not find any table values.');
  const bad = values.flat().filter((v) => !Number.isFinite(v)).length;
  if (bad) throw new Error(`The table has ${bad} blank or non-number cell${bad > 1 ? 's' : ''}. Copy the whole table and paste again.`);
  return { values, rowAxis, colAxis };
}

function isAxis(a) {
  if (a.length < 2 || a.some((v) => !Number.isFinite(v))) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < a.length; i++) {
    if (!(a[i] > a[i - 1])) up = false;
    if (!(a[i] < a[i - 1])) down = false;
  }
  return up || down;
}

function looksLikeRpm(a) {
  const f = a.filter(Number.isFinite);
  return f.length > 1 && Math.max(...f) >= 1500;
}

export function parseAxisText(text) {
  const a = String(text)
    .split(/[\s,;\t]+/)
    .filter(Boolean)
    .map(toNum);
  if (a.some((v) => !Number.isFinite(v))) throw new Error('Axis values must be numbers separated by commas or spaces.');
  if (!isAxis(a)) throw new Error('Axis values must go steadily up or steadily down.');
  return a;
}

// Builds the internal table: rpm and map axes ascending, v[mapIdx][rpmIdx].
// `layout` remembers how the user's table was oriented so output pastes back
// the same way.
export function buildTable(values, rowAxis, colAxis, rowsAre) {
  if (values.length !== rowAxis.length) throw new Error(`The table has ${values.length} rows but the ${rowsAre === 'map' ? 'MAP' : 'RPM'} axis has ${rowAxis.length} values.`);
  if (values[0].length !== colAxis.length) throw new Error(`The table has ${values[0].length} columns but the ${rowsAre === 'map' ? 'RPM' : 'MAP'} axis has ${colAxis.length} values.`);
  const rowDesc = rowAxis[rowAxis.length - 1] < rowAxis[0];
  const colDesc = colAxis[colAxis.length - 1] < colAxis[0];
  const rA = rowDesc ? rowAxis.slice().reverse() : rowAxis.slice();
  const cA = colDesc ? colAxis.slice().reverse() : colAxis.slice();
  const ri = (i) => (rowDesc ? rowAxis.length - 1 - i : i);
  const ci = (j) => (colDesc ? colAxis.length - 1 - j : j);
  let v;
  if (rowsAre === 'map') {
    v = rA.map((_, i) => cA.map((_, j) => values[ri(i)][ci(j)]));
    return { rpm: cA, map: rA, v, layout: { rowsAre, rowDesc, colDesc } };
  }
  // rows are rpm: transpose so v is [map][rpm]
  v = cA.map((_, j) => rA.map((_, i) => values[ri(i)][ci(j)]));
  return { rpm: rA, map: cA, v, layout: { rowsAre, rowDesc, colDesc } };
}

// Turns an internal table back into display order.
export function toDisplay(table, layout = table.layout) {
  const rowsAre = layout.rowsAre;
  let rowAxis = rowsAre === 'map' ? table.map.slice() : table.rpm.slice();
  let colAxis = rowsAre === 'map' ? table.rpm.slice() : table.map.slice();
  let grid = rowsAre === 'map' ? table.v.map((r) => r.slice()) : table.rpm.map((_, j) => table.map.map((_, i) => table.v[i][j]));
  if (layout.rowDesc) {
    rowAxis.reverse();
    grid.reverse();
  }
  if (layout.colDesc) {
    colAxis.reverse();
    grid = grid.map((r) => r.reverse());
  }
  return { rowAxis, colAxis, grid, rowsAre };
}

// Display-order index mapping, used to show per-cell stats in the same grid.
export function displayIndex(table, layout = table.layout) {
  const nMap = table.map.length;
  const nRpm = table.rpm.length;
  const rowsAre = layout.rowsAre;
  const nRows = rowsAre === 'map' ? nMap : nRpm;
  const nCols = rowsAre === 'map' ? nRpm : nMap;
  return (r, c) => {
    const rr = layout.rowDesc ? nRows - 1 - r : r;
    const cc = layout.colDesc ? nCols - 1 - c : c;
    return rowsAre === 'map' ? [rr, cc] : [cc, rr];
  };
}

export function formatNum(v, decimals) {
  return Number(v).toFixed(decimals);
}

export function tableToText(table, { axes = false, decimals = 1, delim = '\t', layout } = {}) {
  const d = toDisplay(table, layout || table.layout);
  const lines = [];
  if (axes) lines.push(['', ...d.colAxis.map((v) => String(v))].join(delim));
  d.grid.forEach((row, i) => {
    const cells = row.map((v) => formatNum(v, decimals));
    lines.push((axes ? [String(d.rowAxis[i]), ...cells] : cells).join(delim));
  });
  return lines.join('\n');
}

export function axisPos(axis, x) {
  const n = axis.length;
  if (n === 1 || x <= axis[0]) return { i: 0, f: 0 };
  if (x >= axis[n - 1]) return { i: Math.max(0, n - 2), f: n === 1 ? 0 : 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= x) lo = mid;
    else hi = mid;
  }
  return { i: lo, f: (x - axis[lo]) / (axis[lo + 1] - axis[lo]) };
}

// The (up to) four cells around a point, with bilinear weights.
export function cellWeights(table, rpm, map) {
  const a = axisPos(table.rpm, rpm);
  const b = axisPos(table.map, map);
  const out = [];
  const push = (mi, ri, w) => {
    if (w > 1e-9 && mi < table.map.length && ri < table.rpm.length) out.push([mi, ri, w]);
  };
  push(b.i, a.i, (1 - b.f) * (1 - a.f));
  push(b.i, a.i + 1, (1 - b.f) * a.f);
  push(b.i + 1, a.i, b.f * (1 - a.f));
  push(b.i + 1, a.i + 1, b.f * a.f);
  return out;
}

export function lookup(table, rpm, map) {
  let s = 0;
  for (const [mi, ri, w] of cellWeights(table, rpm, map)) s += table.v[mi][ri] * w;
  return s;
}

export function makeTable(rpm, map, fn, layout) {
  return {
    rpm: rpm.slice(),
    map: map.slice(),
    v: map.map((m) => rpm.map((r) => fn(r, m))),
    layout: layout || { rowsAre: 'map', rowDesc: false, colDesc: false },
  };
}

export function cloneTable(t) {
  return { rpm: t.rpm.slice(), map: t.map.slice(), v: t.v.map((r) => r.slice()), layout: { ...t.layout } };
}

// ---------------------------------------------------------------- VE correction

export const VE_DEFAULTS = {
  minCts: 160, // same units as the log (Holley logs in F by default)
  minRpm: 500,
  lamMin: 0.65,
  lamMax: 1.35,
  maxTpsRate: 25, // % per second
  maxMapRate: 40, // kPa per second
  delayMs: 150, // wideband transport delay
  minWeight: 8, // weighted samples needed before a cell changes
  maxChangePct: 15,
  strength: 100,
  useCL: true,
  useLearn: true,
  skipDecel: true,
};

// Works out how far off each VE cell is from the datalog and builds a
// corrected table. Returns the new table plus per-cell stats.
export function correctVE(log, roles, ve, opts = {}) {
  const o = { ...VE_DEFAULTS, ...opts };
  const stoich = o.stoich || 14.7;
  const rpm = channel(log, roles, 'rpm');
  const map = channel(log, roles, 'map');
  const afrRaw = channel(log, roles, 'afr');
  if (!rpm || !map || !afrRaw) throw new Error('VE correction needs RPM, MAP and measured AFR channels. Set them under Channels.');
  const targetRaw = channel(log, roles, 'target');
  if (!targetRaw && !o.targetTable) throw new Error('No target AFR channel in this log. Paste your target AFR table or set a fixed target.');

  const { lam } = toLambda(afrRaw, stoich);
  const tgt = targetRaw ? toLambda(targetRaw, stoich).lam : null;
  const tgtTableLam = o.targetTable ? toLambdaTable(o.targetTable, stoich) : null;
  const tps = channel(log, roles, 'tps');
  const cts = channel(log, roles, 'cts');
  const cl = o.useCL ? channel(log, roles, 'clcomp') : null;
  const learn = o.useLearn ? channel(log, roles, 'learn') : null;
  const { t, dt } = timeInfo(log, roles);
  const shift = Math.max(0, Math.round(o.delayMs / 1000 / dt));

  const nM = ve.map.length;
  const nR = ve.rpm.length;
  const wSum = ve.map.map(() => new Array(nR).fill(0));
  const fSum = ve.map.map(() => new Array(nR).fill(0));
  const eSum = ve.map.map(() => new Array(nR).fill(0));
  const reasons = { used: 0, cold: 0, transient: 0, decel: 0, afrRange: 0, missing: 0, lowRpm: 0 };

  const n = log.length;
  for (let k = 1; k < n - shift; k++) {
    const r = rpm[k];
    const m = map[k];
    const l = lam[k + shift];
    let tl = tgt ? tgt[k] : lookup(tgtTableLam, r, m);
    if (![r, m, l, tl].every(Number.isFinite) || tl <= 0) {
      reasons.missing++;
      continue;
    }
    if (r < o.minRpm) {
      reasons.lowRpm++;
      continue;
    }
    if (cts && Number.isFinite(cts[k]) && cts[k] < o.minCts) {
      reasons.cold++;
      continue;
    }
    const dtk = t[k] - t[k - 1] > 0 ? t[k] - t[k - 1] : dt;
    if (tps && Math.abs(tps[k] - tps[k - 1]) / dtk > o.maxTpsRate) {
      reasons.transient++;
      continue;
    }
    if (Math.abs(m - map[k - 1]) / dtk > o.maxMapRate) {
      reasons.transient++;
      continue;
    }
    if (o.skipDecel && tps && tps[k] < 1.5 && r > 1400 && m < 45) {
      reasons.decel++;
      continue;
    }
    if (l < o.lamMin || l > o.lamMax) {
      reasons.afrRange++;
      continue;
    }
    let factor = l / tl;
    if (cl && Number.isFinite(cl[k])) factor *= 1 + cl[k] / 100;
    if (learn && Number.isFinite(learn[k])) factor *= 1 + learn[k] / 100;
    reasons.used++;
    for (const [mi, ri, w] of cellWeights(ve, r, m)) {
      wSum[mi][ri] += w;
      fSum[mi][ri] += factor * w;
      eSum[mi][ri] += (l / tl - 1) * 100 * w;
    }
  }

  const out = cloneTable(ve);
  const cells = ve.map.map(() => new Array(nR));
  const maxF = o.maxChangePct / 100;
  const strength = clamp(o.strength, 0, 100) / 100;
  let changed = 0;
  for (let i = 0; i < nM; i++) {
    for (let j = 0; j < nR; j++) {
      const w = wSum[i][j];
      const old = ve.v[i][j];
      const cell = { weight: w, old, factor: 1, afrErrPct: 0, status: 'none', newV: old, changePct: 0 };
      if (w > 0) {
        cell.factor = fSum[i][j] / w;
        cell.afrErrPct = eSum[i][j] / w;
        cell.status = 'low';
      }
      if (w >= o.minWeight) {
        let f = 1 + (cell.factor - 1) * strength;
        f = clamp(f, 1 - maxF, 1 + maxF);
        cell.newV = round(old * f, 0.1);
        cell.changePct = (cell.newV / old - 1) * 100;
        cell.status = Math.abs(cell.changePct) < 0.05 ? 'ok' : 'changed';
        if (cell.status === 'changed') changed++;
        out.v[i][j] = cell.newV;
      }
      cells[i][j] = cell;
    }
  }
  return { table: out, cells, reasons, changed, shiftSamples: shift, dt };
}

function toLambdaTable(table, stoich) {
  const med = median(table.v.flat());
  const isLam = med < 2;
  return { ...table, v: table.v.map((r) => r.map((x) => (isLam ? x : x / stoich))) };
}

// ---------------------------------------------------------------- knock

export function knockReview(log, roles, axes, opts = {}) {
  const threshold = opts.threshold ?? 0.1;
  const rpm = channel(log, roles, 'rpm');
  const map = channel(log, roles, 'map');
  const knock = channel(log, roles, 'knock');
  if (!knock) throw new Error('No knock retard channel found. Pick it under Channels if it has a different name.');
  if (!rpm || !map) throw new Error('Knock review needs RPM and MAP channels.');
  const timing = channel(log, roles, 'timing');
  const { t } = timeInfo(log, roles);
  const grid = { rpm: axes.rpm, map: axes.map, layout: axes.layout };
  const cells = axes.map.map(() => axes.rpm.map(() => ({ count: 0, maxRetard: 0, weight: 0 })));
  const events = [];
  let ev = null;
  let samples = 0;
  for (let k = 0; k < log.length; k++) {
    const kr = Math.abs(knock[k]);
    if (Number.isFinite(kr) && kr > threshold && Number.isFinite(rpm[k]) && Number.isFinite(map[k])) {
      samples++;
      for (const [mi, ri, w] of cellWeights(grid, rpm[k], map[k])) {
        const c = cells[mi][ri];
        c.weight += w;
        if (w >= 0.25) {
          c.count++;
          c.maxRetard = Math.max(c.maxRetard, kr);
        }
      }
      if (!ev) ev = { start: t[k], end: t[k], startIdx: k, maxRetard: kr, rpm: rpm[k], map: map[k], timing: timing ? timing[k] : NaN };
      ev.end = t[k];
      ev.endIdx = k;
      if (kr > ev.maxRetard) {
        ev.maxRetard = kr;
        ev.rpm = rpm[k];
        ev.map = map[k];
        ev.timing = timing ? timing[k] : NaN;
      }
    } else if (ev) {
      events.push(ev);
      ev = null;
    }
  }
  if (ev) events.push(ev);
  return { cells, events, samples };
}

// Pulls timing from cells that saw knock: the worst retard seen plus `extra`.
export function suggestTiming(timingTable, review, { extra = 1 } = {}) {
  const out = cloneTable(timingTable);
  const changes = timingTable.map.map(() => timingTable.rpm.map(() => 0));
  for (let i = 0; i < timingTable.map.length; i++) {
    for (let j = 0; j < timingTable.rpm.length; j++) {
      const c = review.cells[i][j];
      if (c.maxRetard > 0) {
        const pull = Math.ceil((c.maxRetard + extra) * 2) / 2;
        out.v[i][j] = round(timingTable.v[i][j] - pull, 0.5);
        changes[i][j] = -pull;
      }
    }
  }
  return { table: out, changes };
}
