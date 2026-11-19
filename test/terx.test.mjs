import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTerx, compareTunes, checkTune, crc32 } from '../js/terx.js';

// Builds a small fake .terx file with the same layout as real ones.
function makeTerx({ name = 'GOOD.terx', leftover = '', mapTop = 105, injector = 71, ignition = 5, fuelSeed = 1, withAdv = true, withIo = true, corrupt = false } = {}) {
  const H = 4464;
  const parts = [];
  const header = new Uint8Array(H);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0xdeedbeaf, true);
  hv.setUint32(4, 4, true);
  hv.setUint32(20, H, true);
  const put = (off, str) => [...str].forEach((c, i) => (header[off + i] = c.charCodeAt(0)));
  put(24, name);
  if (leftover) put(24 + name.length + 1, leftover);
  put(284, 'Generated using Terminator X, 3.5" Wizard Version 2.0.50');
  put(1312, 'MPFI_ZBA.fuel');
  put(1840, 'MPFI.system');
  parts.push(header, new Uint8Array(12));
  const section = (type, dataLen, fill) => {
    const len = dataLen + 12;
    const b = new Uint8Array(len);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, 3, true);
    v.setUint32(8, len, true);
    fill && fill(new DataView(b.buffer, 12));
    parts.push(b);
  };
  section(0xa0, 400, (v) => { for (let i = 0; i < 100; i++) v.setFloat32(i * 4, 40 + ((i * fuelSeed) % 50), true); });
  section(0xa1, 200, (v) => { for (let i = 0; i < 50; i++) v.setFloat32(i * 4, 20 + ((i * fuelSeed) % 15), true); });
  section(0xa2, 160, (v) => { for (let i = 0; i < 10; i++) v.setFloat32(84 + i * 4, 1065 - i * 30, true); });
  section(0xa7, 2800, (v) => { v.setUint32(172, injector, true); v.setUint32(2640, ignition, true); });
  section(0xa9, 200, (v) => { for (let i = 0; i < 15; i++) v.setFloat32(72 + i * 4, ((i + 1) * mapTop) / 15, true); });
  if (withIo) section(0xa3, 100);
  section(0xaa, 80);
  if (withAdv) section(0xac, 120);
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + 16);
  let o = 0;
  for (const p of parts) { body.set(p, o); o += p.length; }
  const fv = new DataView(body.buffer);
  fv.setUint32(o, 0xff000000, true);
  fv.setUint32(o + 4, 1, true);
  fv.setUint32(o + 8, 16, true);
  fv.setUint32(o + 12, crc32(body.subarray(0, body.length - 4)), false);
  if (corrupt) body[5000] ^= 0xff;
  return body;
}

test('crc32 matches known value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('parses a well formed tune with no problems', () => {
  const t = parseTerx(makeTerx(), 'good.terx');
  assert.deepEqual(t.problems, []);
  assert.ok(t.checksumOk);
  assert.deepEqual(t.sections.map((s) => s.kind), ['fuel', 'spark', 'idle', 'system', 'sensor', 'io', 'dbw', 'advanced']);
  assert.equal(t.fields.injectorId, 71);
  assert.equal(t.fields.ignitionType, 5);
  assert.equal(t.fields.mapScale.at(-1), 105);
  assert.deepEqual(checkTune(t), []);
});

test('flags a damaged file by checksum', () => {
  const t = parseTerx(makeTerx({ corrupt: true }));
  assert.equal(t.checksumOk, false);
  assert.ok(checkTune(t).some((w) => w.level === 'bad' && /checksum/i.test(w.detail)));
});

test('rejects files that are not tunes', () => {
  assert.throws(() => parseTerx(new Uint8Array(6000)), /not a Terminator X/);
});

test('compare catches the no-start pattern from the wagon', () => {
  const good = parseTerx(makeTerx(), 'good.terx');
  const bad = parseTerx(makeTerx({ name: 'WAGON.2.terx', leftover: '.25', mapTop: 210, injector: 255, ignition: 9, fuelSeed: 7, withIo: false }), 'bad.terx');
  const r = compareTunes(good, bad);
  const titles = r.warnings.map((w) => `${w.level}: ${w.title}`).join('\n');
  assert.match(titles, /bad: MAP sensor set to 2-bar, known good tune uses 1-bar/);
  assert.match(titles, /bad: Injector changed: GM 12576341 \(stock LS3\/LS7\) \(71\) to Custom/);
  assert.match(titles, /bad: Ignition type changed: LS 24X \(5\) to Unknown type \(9\)/);
  assert.match(titles, /info: Leftover text from an older file name/);
  assert.match(r.warnings.find((w) => /Mostly different/.test(w.title)).detail, /.25/);
  assert.match(titles, /warn: I\/O section missing/);
  assert.equal(r.warnings[0].level, 'bad');
});

test('injector IDs decode to names', async () => {
  const { injectorText } = await import('../js/terx.js');
  assert.equal(injectorText(32), '30LB Holley 522-308 (32)');
  assert.equal(injectorText(110), 'Ford BR3Z9F593A (Coyote) (110)');
  assert.equal(injectorText(2, 24), 'GM LT4 12703612 (2)');
  assert.equal(injectorText(9999), 'Unknown injector (9999)');
});

test('identical tunes compare clean', () => {
  const a = parseTerx(makeTerx());
  const b = parseTerx(makeTerx());
  const r = compareTunes(a, b);
  assert.ok(r.warnings.every((w) => w.level === 'info'));
  assert.ok(r.rows.every((x) => x.same));
});
