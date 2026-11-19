import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, detectRoles, parseTableText, buildTable, tableToText, correctVE, lookup, knockReview, suggestTiming, toNum } from '../js/core.js';
import { sampleData } from '../js/sample.js';
import { buildBaseMap } from '../js/basemap.js';

test('toNum handles times, units and comma decimals', () => {
  assert.equal(toNum('1:02.5'), 62.5);
  assert.equal(toNum('14.7 AFR'), 14.7);
  assert.equal(toNum('3,5'), 3.5);
  assert.ok(Number.isNaN(toNum('abc')));
});

test('parseLog finds header after metadata and skips units row', () => {
  const text = 'Holley EFI Datalog\nDate,2026-01-01\n\nRTC,RPM,MAP,AFR Average,Target AFR\nsec,rpm,kPa,afr,afr\n0.00,800,35,14.1,14.1\n0.05,810,36,14.2,14.1\n';
  const log = parseLog(text);
  assert.deepEqual(log.headers, ['RTC', 'RPM', 'MAP', 'AFR Average', 'Target AFR']);
  assert.equal(log.units[2], 'kPa');
  assert.equal(log.length, 2);
  const roles = detectRoles(log.headers);
  assert.equal(roles.rpm, 1);
  assert.equal(roles.map, 2);
  assert.equal(roles.afr, 3);
  assert.equal(roles.target, 4);
});

test('detectRoles does not confuse target idle rpm or target afr', () => {
  const r = detectRoles(['Time', 'Target Idle RPM', 'RPM', 'Target AFR', 'AFR Left', 'AFR Right', 'Knock Retard', 'Ignition Timing', 'Closed Loop Comp', 'Learn']);
  assert.equal(r.rpm, 2);
  assert.equal(r.afr, 4);
  assert.equal(r.target, 3);
  assert.equal(r.knock, 6);
  assert.equal(r.timing, 7);
  assert.equal(r.clcomp, 8);
  assert.equal(r.learn, 9);
});

test('table with axes round-trips in the same layout', () => {
  const text = '\t1000\t2000\t3000\n100\t80\t85\t90\n60\t60\t65\t70\n30\t40\t45\t50';
  const p = parseTableText(text);
  assert.deepEqual(p.colAxis, [1000, 2000, 3000]);
  assert.deepEqual(p.rowAxis, [100, 60, 30]);
  const t = buildTable(p.values, p.rowAxis, p.colAxis, 'map');
  assert.deepEqual(t.map, [30, 60, 100]);
  assert.equal(t.v[0][0], 40);
  assert.equal(lookup(t, 1500, 45), 52.5);
  assert.equal(tableToText(t, { axes: true, decimals: 0 }), '\t1000\t2000\t3000\n100\t80\t85\t90\n60\t60\t65\t70\n30\t40\t45\t50');
});

test('values-only table with rows as rpm transposes correctly', () => {
  const p = parseTableText('1 2\n3 4\n5 6');
  assert.equal(p.rowAxis, null);
  const t = buildTable(p.values, [1000, 2000, 3000], [40, 80], 'rpm');
  assert.deepEqual(t.v, [[1, 3, 5], [2, 4, 6]]);
  assert.equal(tableToText(t, { decimals: 0, delim: ' ' }), '1 2\n3 4\n5 6');
});

test('VE correction on sample log moves table toward the true VE', () => {
  const s = sampleData();
  const log = parseLog(s.csv);
  const roles = detectRoles(log.headers);
  const res = correctVE(log, roles, s.ecuVe, { stoich: 14.1, maxChangePct: 30 });
  assert.ok(res.reasons.used > 1000, 'used rows ' + res.reasons.used);
  assert.ok(res.changed > 10);
  let before = 0, after = 0, n = 0;
  for (let i = 0; i < s.ecuVe.map.length; i++) for (let j = 0; j < s.ecuVe.rpm.length; j++) {
    const c = res.cells[i][j];
    if (c.weight < 30) continue;
    const truth = s.trueVe.v[i][j];
    before += Math.abs(s.ecuVe.v[i][j] - truth) / truth;
    after += Math.abs(res.table.v[i][j] - truth) / truth;
    n++;
  }
  assert.ok(n > 5);
  console.log(`cells ${n}: avg error before ${(before / n * 100).toFixed(2)}%, after ${(after / n * 100).toFixed(2)}%`);
  assert.ok(after < before * 0.5);
});

test('knock review finds sample knock and suggests pulling timing', () => {
  const s = sampleData();
  const log = parseLog(s.csv);
  const roles = detectRoles(log.headers);
  const rev = knockReview(log, roles, s.timing);
  assert.ok(rev.events.length > 0);
  const sug = suggestTiming(s.timing, rev, { extra: 1 });
  let pulled = 0;
  sug.changes.flat().forEach((c) => { if (c < 0) pulled++; });
  assert.ok(pulled > 0);
  for (const r of sug.table.v.flat()) assert.ok(Number.isFinite(r));
});

test('base map is sane', () => {
  const b = buildBaseMap({ camDuration: 230, lsa: 110, heads: 'rectangle', fuel: 'e85' });
  for (const v of b.ve.v.flat()) assert.ok(v >= 15 && v <= 130);
  for (const v of b.timing.v.flat()) assert.ok(v >= 5 && v <= 45);
  const wot = lookup(b.afr, 5000, 100);
  assert.ok(wot > 8 && wot < 9.5, 'E85 WOT AFR ' + wot);
});
