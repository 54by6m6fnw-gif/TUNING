// Reads Holley Terminator X tune files (.terx) and compares two of them.
//
// Holley does not publish this format. The layout below was worked out by
// comparing real tune files, so field meanings are best guesses unless noted.
//
//   0      u32 magic 0xDEEDBEAF
//   20     u32 header size (4464)
//   24     file name (C string); bytes after the null can hold leftovers
//          from an older, longer file name
//   284    wizard text, e.g. 'Generated using Terminator X, 3.5" Wizard ...'
//   1048+  264-byte slots holding base file (ICF) names, e.g. MPFI_ZBA.fuel
//   header+12  sections: u32 type, u32 version (3), u32 length. The next
//          section header starts at offset + length.

export const MAGIC = 0xdeedbeaf;

export const SECTION_TYPES = {
  0xa0: 'fuel', 0xa1: 'spark', 0xa2: 'idle', 0xa3: 'io', 0xa4: 'nitrous', 0xa5: 'boost',
  0xa6: 'transmission', 0xa7: 'system', 0xa8: 'transmission', 0xa9: 'sensor', 0xaa: 'dbw',
  0xab: 'traction', 0xac: 'advanced',
};

export const SECTION_LABELS = {
  fuel: 'Fuel', spark: 'Spark', idle: 'Idle', io: 'I/O', nitrous: 'Nitrous', boost: 'Boost',
  transmission: 'Transmission', system: 'System', sensor: 'Sensors', dbw: 'Drive by wire',
  traction: 'Traction', advanced: 'Advanced',
};

const EXT_KIND = { fuel: 'fuel', spark: 'spark', idle: 'idle', io: 'io', nitrous: 'nitrous', boost: 'boost', transmission: 'transmission', system: 'system', sensor: 'sensor', dbw: 'dbw', traction: 'traction', adv: 'advanced' };

// Known fields: [section, byte offset in section data, type, label, note]
export const FIELDS = [
  { key: 'mapScale', section: 'sensor', off: 72, kind: 'f32x15', label: 'MAP sensor scale (kPa)', note: '105 kPa top = 1-bar sensor, 210 = 2-bar, 315 = 3-bar' },
  { key: 'injectorId', section: 'system', off: 172, kind: 'u32', label: 'Injector selection', note: 'Name from the injector list in Holley EFI software. The flow below is what the fuel math uses' },
  { key: 'injectorFlow', section: 'system', off: 184, kind: 'f32', label: 'Injector flow (lb/hr)', note: 'Checked against Holley base tunes' },
  { key: 'injectorPsi', section: 'system', off: 188, kind: 'f32', label: 'Injector rated pressure (psi)', note: '' },
  { key: 'displacement', section: 'system', off: 8, kind: 'f32', label: 'Engine displacement (ci)', note: '' },
  { key: 'ignitionType', section: 'system', off: 2640, kind: 'u32', label: 'Ignition / crank trigger type', note: 'Matched against Holley base calibrations: LS 24X = 5, LS 58X = 4' },
  { key: 'sys2668', section: 'system', off: 2668, kind: 'u32', label: 'System setting at 2668', note: 'Meaning unknown' },
  { key: 'idleTarget', section: 'idle', off: 84, kind: 'f32x10', label: 'Idle target RPM (cold to warm)', note: '' },
];

function cstr(bytes, start, max) {
  let s = '';
  for (let i = start; i < start + max && i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function printableRuns(bytes, start, end, min = 2) {
  const runs = [];
  let cur = '';
  for (let i = start; i < end && i < bytes.length; i++) {
    const c = bytes[i];
    if (c >= 32 && c < 127) cur += String.fromCharCode(c);
    else {
      if (cur.length >= min) runs.push(cur);
      cur = '';
    }
  }
  if (cur.length >= min) runs.push(cur);
  return runs;
}

export function parseTerx(input, fileName = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const problems = [];
  if (bytes.length < 4500) throw new Error(`${fileName || 'File'} is too small to be a Terminator X tune.`);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error(`${fileName || 'File'} is not a Terminator X .terx tune file.`);
  const headerSize = dv.getUint32(20, true);
  if (headerSize < 1312 || headerSize > bytes.length) throw new Error('The file header is damaged.');

  const name = cstr(bytes, 24, 256);
  const nameEnd = 24 + name.length;
  const leftovers = printableRuns(bytes, nameEnd + 1, 280).filter((s) => !/^\s+$/.test(s));
  const wizard = cstr(bytes, 284, 256).trim();

  const bases = [];
  for (let off = 1048; off + 264 <= headerSize; off += 264) {
    const n = cstr(bytes, off, 256);
    if (n) {
      const ext = (n.split('.').pop() || '').toLowerCase();
      bases.push({ slot: off, name: n, kind: EXT_KIND[ext] || ext, cleared: false });
    } else if (bytes[off] === 0 && bytes[off + 1] >= 32 && bytes[off + 1] < 127) {
      // first character zeroed out: an entry that was removed but not wiped
      const rest = cstr(bytes, off + 1, 255);
      if (/\.\w+$/.test(rest)) {
        const ext = rest.split('.').pop().toLowerCase();
        bases.push({ slot: off, name: rest, kind: EXT_KIND[ext] || ext, cleared: true });
      }
    }
  }

  const sections = [];
  let o = headerSize + 12;
  let chainOk = true;
  const footerStart = bytes.length - 16;
  while (o + 12 <= footerStart) {
    const type = dv.getUint32(o, true);
    const ver = dv.getUint32(o + 4, true);
    const len = dv.getUint32(o + 8, true);
    if (!SECTION_TYPES[type] || ver !== 3 || len < 12 || o + len > footerStart) {
      chainOk = false;
      problems.push(`Unexpected data at byte ${o}. The section list stops here, so the file may be damaged or cut short.`);
      break;
    }
    const kind = SECTION_TYPES[type];
    sections.push({ kind, type, offset: o, length: len, data: bytes.subarray(o + 12, o + len) });
    o += len;
  }
  if (chainOk && o !== footerStart) problems.push(`The last section ends at byte ${o}, but the file footer starts at ${footerStart}. The file may be cut short or have extra data.`);
  const stored = dv.getUint32(bytes.length - 4, false);
  const actual = crc32(bytes.subarray(0, bytes.length - 4));
  const checksumOk = stored === actual;
  if (!checksumOk) problems.push('The checksum does not match the contents. The file was damaged or edited outside Holley EFI software, and Holley may refuse to load it.');
  if (!sections.length) problems.push('No tune sections found.');

  const byKind = {};
  for (const s of sections) byKind[s.kind] = s;

  const fields = {};
  for (const f of FIELDS) {
    const s = byKind[f.section];
    if (!s) continue;
    const sv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    const count = f.kind === 'u32' || f.kind === 'f32' ? 1 : Number(f.kind.replace('f32x', ''));
    if (f.off + count * 4 > s.data.length) continue;
    if (f.kind === 'u32') fields[f.key] = sv.getUint32(f.off, true);
    else if (f.kind === 'f32') fields[f.key] = Number(sv.getFloat32(f.off, true).toFixed(2));
    else fields[f.key] = Array.from({ length: count }, (_, i) => Number(sv.getFloat32(f.off + i * 4, true).toFixed(3)));
  }

  return { fileName, size: bytes.length, name, leftovers, wizard, bases, sections, byKind, fields, problems, checksumOk, bytes };
}

// Share of 4-byte words that differ between two section payloads.
export function sectionDiff(a, b) {
  if (!a || !b) return null;
  const n = Math.min(a.length, b.length) >> 2;
  let diff = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diff++;
  }
  diff += Math.abs(a.length - b.length) >> 2;
  const total = Math.max(a.length, b.length) >> 2;
  return { diff, total, pct: total ? (diff / total) * 100 : 0 };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Ignition type codes seen in Holley's own base calibrations.
export const IGNITION_TYPES = {
  0: 'HEI distributor',
  1: 'Distributor (Stealth 4150 TBI base)',
  3: 'Ford TFI distributor',
  4: 'LS 58X',
  5: 'LS 24X',
  10: 'HEMI 36-2+2 waste spark',
  11: 'HEMI 36-2+2 coil on plug',
  12: 'HEMI 60-2',
  15: 'Coyote without Ti-VCT',
  16: 'Coyote Ti-VCT',
  21: 'Holley Dual Sync distributor',
  24: 'Gen V LT',
  27: 'HEMI VVT',
};

export function ignitionText(code) {
  if (code == null) return 'n/a';
  return IGNITION_TYPES[code] ? `${IGNITION_TYPES[code]} (${code})` : `Unknown type (${code})`;
}

// Port injector IDs, decoded from the list inside Holley's Terminator X V3
// software (ID minus 30 indexes its injector table). Checked against
// Holley's base tunes: NA LS = 32, HEMI = 112 to 114, Coyote = 110.
export const PORT_INJECTORS = {
  30: '19LB Holley 522-198',
  31: '24LB Holley 522-248',
  32: '30LB Holley 522-308',
  33: '36LB Holley 522-368',
  34: '42LB Holley 522-428',
  35: '48LB Holley 522-488',
  50: '60LB Siemens Deka IV',
  71: 'GM 12576341 (stock LS3/LS7)',
  72: 'GM 12580426 (5.3 flex fuel)',
  80: 'FIC 525H',
  81: 'FIC 650H',
  82: 'FIC 775H',
  83: 'FIC 850H',
  84: 'FIC 1000H',
  85: 'FIC 1200H',
  86: 'FIC 1650H',
  87: 'FIC 2150H',
  88: 'Term-X 42 lb/hr (522-428X)',
  89: 'Term-X 76 lb/hr (522-768X)',
  90: 'Term-X 100 lb/hr (522-108X)',
  91: 'Term-X 120 lb/hr (522-128X)',
  92: 'GM 12580681',
  93: 'GM 17113698',
  94: 'GM 25317628',
  95: 'GM 17113553',
  96: 'GM 25323974',
  97: 'GM 25320288',
  98: 'GM 89017586',
  99: 'GM 12594512',
  100: 'GM 12609749',
  101: 'GM 12613411',
  102: 'GM 12587269',
  103: 'GM 12613412',
  104: 'SEP 850cc',
  105: 'SEP 1000cc',
  106: 'SEP 1500cc',
  107: 'Ford Large Body Yellow 19 lb/hr',
  108: 'Ford Large Body Blue 24 lb/hr',
  109: 'Ford Large Body Red 30 lb/hr',
  110: 'Ford BR3Z9F593A (Coyote)',
  111: 'Mopar RL032713AB',
  112: 'Mopar 4591851AB',
  113: 'Mopar 5037479AA',
  114: 'Mopar 5038337AB',
  115: 'Mopar 68170238AB',
  116: 'Mopar 5038838AA',
  117: 'Accel 150830 30 lb/hr',
  118: 'Accel 150832 32 lb/hr',
  119: 'Accel 150844 44 lb/hr',
  120: 'Accel 151845 45 lb/hr',
  121: 'Accel 151848 48 lb/hr',
  122: 'Accel 151853 53 lb/hr',
  123: 'Accel 151861 61 lb/hr',
  124: 'Accel 74620L 62 lb/hr',
  125: 'Accel 151880 80 lb/hr',
  126: 'FRPP M-9593-LU47',
  127: 'FRPP M-9593-G302',
  128: 'FRPP M-9593-MU52',
  129: 'FRPP M-9593-LU60',
  130: 'FRPP M-9593-LU80',
  131: '80LB Siemens Deka IV',
  132: 'Bosch 210 lb/hr',
  133: 'Term-X 220 lb/hr (522-228X)',
  134: 'Ford 7.3 Godzilla (60 psi)',
  255: 'Custom (entered by hand)',
};

// Gen V LT direct injection uses its own short list.
export const DI_INJECTORS = { 0: 'GM L83 12698484', 1: 'GM L86/LT1 12692521', 2: 'GM LT4 12703612', 3: 'GM L82/L84/L87', 4: 'GM LT2/L8T', 5: 'GM LT5' };

export function injectorText(id, ignitionType) {
  if (id == null) return 'n/a';
  const list = ignitionType === 24 ? DI_INJECTORS : PORT_INJECTORS;
  return list[id] ? `${list[id]} (${id})` : `Unknown injector (${id})`;
}

// CRC-32 (IEEE). Holley stores the CRC of everything before the last 4 bytes
// in those last 4 bytes, most significant byte first.
let CRC_TABLE;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function mapBar(scale) {
  if (!scale) return null;
  const top = scale[scale.length - 1];
  return top > 0 ? Math.round(top / 105) : null;
}

export function fieldText(key, v, fields = {}) {
  if (v == null) return 'n/a';
  if (key === 'injectorId') return injectorText(v, fields.ignitionType);
  if (key === 'mapScale') return `${v[0]} to ${v[v.length - 1]}` + (mapBar(v) ? ` (${mapBar(v)}-bar)` : '');
  if (key === 'ignitionType') return ignitionText(v);
  if (Array.isArray(v)) return `${Math.round(v[0])} to ${Math.round(v[v.length - 1])}`;
  return String(v);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Checks one tune by itself. Warnings: { level: 'bad'|'warn'|'info', title, detail }
export function checkTune(t) {
  const w = [];
  for (const p of t.problems) w.push({ level: 'bad', title: 'File structure problem', detail: p });
  const stray = t.leftovers.filter((x) => x.length >= 2 && !/^(terx|PM|AM)$/i.test(x));
  if (stray.length) {
    w.push({
      level: 'info',
      title: 'Leftover text from an older file name',
      detail: `After the name "${t.name}" the header still holds "${t.leftovers.join(' ')}". Holley leaves this behind when a tune is saved under a shorter name. It is normal, but it can hint at which file this tune started from.`,
    });
  }
  for (const b of t.bases.filter((x) => x.cleared)) {
    w.push({ level: 'info', title: `Removed ${SECTION_LABELS[b.kind] || b.kind} entry`, detail: `The header still has a cleared entry for "${b.name}". This is usually harmless.` });
  }
  return w;
}

// Compares a tune against a known good one.
export function compareTunes(good, check) {
  const warnings = checkTune(check);
  if (bytesEqual(good.bytes, check.bytes)) {
    warnings.unshift({ level: 'info', title: 'Files are identical', detail: 'Both files have exactly the same contents.' });
  }

  const rows = FIELDS.map((f) => {
    const a = good.fields[f.key];
    const b = check.fields[f.key];
    return { key: f.key, label: f.label, note: f.note, good: fieldText(f.key, a, good.fields), check: fieldText(f.key, b, check.fields), same: sameValue(a, b) };
  });

  const gi = good.fields.ignitionType;
  const ci = check.fields.ignitionType;
  if (gi != null && ci != null && gi !== ci) {
    warnings.push({ level: 'bad', title: `Ignition type changed: ${ignitionText(gi)} to ${ignitionText(ci)}`, detail: 'If the crank trigger type does not match the engine, the ECU never syncs to the crank and the engine gets no spark. Set the ignition type in Holley EFI software to match the car before loading this tune.' });
  }

  const ga = good.fields.mapScale;
  const ca = check.fields.mapScale;
  if (ga && ca && !sameValue(ga, ca)) {
    warnings.push({
      level: 'bad',
      title: `MAP sensor set to ${mapBar(ca) || '?'}-bar, known good tune uses ${mapBar(ga) || '?'}-bar`,
      detail: 'If the sensor on the car does not match this setting, the ECU reads the wrong manifold pressure and fuels for the wrong load. A 2-bar setting on a 1-bar sensor floods the engine and can stop it from starting.',
    });
  }

  const gf = good.fields.injectorFlow;
  const cf = check.fields.injectorFlow;
  if (gf > 0 && cf > 0 && Math.abs(cf / gf - 1) > 0.02) {
    const pct = (gf / cf - 1) * 100;
    warnings.push({
      level: 'bad',
      title: `Injector flow changed: ${gf} to ${cf} lb/hr`,
      detail: `The ECU sizes every injector pulse from this number. With the same injectors in the car, this tune would deliver about ${Math.abs(pct).toFixed(0)}% ${pct < 0 ? 'less' : 'more'} fuel everywhere (${pct < 0 ? 'lean' : 'rich'}) until closed loop corrects what it can. Confirm which injectors are installed.`,
    });
  } else if (good.fields.injectorId != null && check.fields.injectorId != null && good.fields.injectorId !== check.fields.injectorId) {
    warnings.push({ level: 'warn', title: `Injector selection changed: ${injectorText(good.fields.injectorId, gi)} to ${injectorText(check.fields.injectorId, ci)}`, detail: 'The flow rate is about the same, so fueling barely changes, but the injector dead times may differ. Confirm which injectors are installed.' });
  }

  const kinds = [...new Set([...good.sections.map((s) => s.kind), ...check.sections.map((s) => s.kind)])];
  const sections = kinds.map((k) => {
    const d = sectionDiff(good.byKind[k] && good.byKind[k].data, check.byKind[k] && check.byKind[k].data);
    return { kind: k, label: SECTION_LABELS[k] || k, inGood: !!good.byKind[k], inCheck: !!check.byKind[k], pct: d ? d.pct : null, diff: d ? d.diff : null, total: d ? d.total : null };
  });
  for (const s of sections) {
    if (s.inGood && !s.inCheck) {
      warnings.push({ level: 'warn', title: `${s.label} section missing`, detail: `The known good tune has a ${s.label} section and this one does not. Any settings in it fall back to defaults.` });
    }
    if (!s.inGood && s.inCheck) warnings.push({ level: 'info', title: `${s.label} section added`, detail: `This tune has a ${s.label} section that the known good tune does not.` });
  }
  const fuel = sections.find((s) => s.kind === 'fuel');
  const spark = sections.find((s) => s.kind === 'spark');
  if (fuel && fuel.pct != null && fuel.pct > 50 && (!spark || spark.pct > 50)) {
    const hint = check.leftovers.length ? ` The header also holds leftover text ("${check.leftovers.join(' ')}") from the file it was saved over, which may name the car it came from.` : '';
    warnings.push({ level: 'warn', title: 'Mostly different fuel and spark tables', detail: `${Math.round(fuel.pct)}% of fuel values and ${spark ? Math.round(spark.pct) : '?'}% of spark values differ. That is more than normal tuning changes, so this may be a different car's tune.${hint}` });
  }

  const baseDiffs = [];
  const gb = Object.fromEntries(good.bases.filter((b) => !b.cleared).map((b) => [b.kind, b.name]));
  const cb = Object.fromEntries(check.bases.filter((b) => !b.cleared).map((b) => [b.kind, b.name]));
  for (const k of new Set([...Object.keys(gb), ...Object.keys(cb)])) {
    if (gb[k] !== cb[k]) baseDiffs.push({ kind: k, label: SECTION_LABELS[k] || k, good: gb[k] || 'none', check: cb[k] || 'none' });
  }
  if (baseDiffs.length) {
    warnings.push({ level: 'warn', title: 'Built from different base files', detail: baseDiffs.map((b) => `${b.label}: ${b.good} vs ${b.check}`).join('; ') + '. The two tunes did not start from the same wizard setup.' });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => order[a.level] - order[b.level]);
  return { warnings, rows, sections, baseDiffs };
}

// Finds which of several tunes a file's fuel section matches exactly.
export function matchingFuel(t, others) {
  const f = t.byKind.fuel;
  if (!f) return [];
  return others.filter((o) => o !== t && o.byKind.fuel && bytesEqual(o.byKind.fuel.data, f.data)).map((o) => o.fileName || o.name);
}
