// Builds a made-up datalog for trying the app without a car. The "true" VE
// differs from the ECU's VE table, so the VE correction tab has something to
// find. Channel names follow Holley-style naming.

import { buildBaseMap } from './basemap.js';
import { lookup, makeTable, round, clamp } from './core.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Drive segments: [seconds, rpmStart, rpmEnd, mapStart, mapEnd, tps]
const SEGMENTS = [
  [90, 1100, 800, 40, 38, 0], // cold idle
  [40, 800, 800, 36, 36, 0],
  [20, 800, 2200, 45, 55, 15],
  [60, 2000, 2400, 40, 46, 12],
  [8, 1800, 1200, 22, 25, 0], // decel
  [25, 1500, 2800, 50, 70, 28],
  [6, 2800, 5600, 95, 99, 100], // WOT pull
  [5, 2200, 1400, 22, 24, 0],
  [80, 1600, 2600, 35, 50, 10],
  [30, 2600, 3200, 55, 75, 30],
  [7, 2600, 5900, 96, 99, 100],
  [6, 2400, 1200, 21, 23, 0],
  [60, 800, 800, 35, 37, 0],
  [40, 1200, 3600, 30, 60, 20],
  [30, 3000, 4200, 60, 85, 50],
  [8, 2400, 6000, 97, 99, 100],
  [10, 2200, 900, 22, 30, 0],
  [40, 800, 800, 36, 36, 0],
];

export function sampleData({ seed = 7, hz = 20 } = {}) {
  const rand = rng(seed);
  const noise = (a) => (rand() - 0.5) * 2 * a;
  const base = buildBaseMap({});
  const ecuVe = base.ve;
  // The real engine differs from the base map: rich down low, lean up top.
  const trueVe = makeTable(ecuVe.rpm, ecuVe.map, (r, m) => {
    const ve = lookup(ecuVe, r, m);
    const err = 1 + 0.08 * Math.sin(r / 900) + 0.06 * ((m - 60) / 40) - 0.04 * Math.cos(r / 1500 + m / 30);
    return ve * err;
  });

  const headers = ['RTC', 'RPM', 'MAP', 'TPS', 'CTS', 'MAT', 'AFR Left', 'AFR Right', 'AFR Average', 'Target AFR', 'Closed Loop Comp', 'Learn', 'Ignition Timing', 'Knock Retard', 'Injector Duty Cycle'];
  const rows = [];
  let t = 0;
  let cts = 115;
  let cl = 0;
  const stoich = 14.1;
  const lamHist = [];
  for (const [secs, r0, r1, m0, m1, tps0] of SEGMENTS) {
    const n = Math.round(secs * hz);
    for (let i = 0; i < n; i++) {
      const f = i / Math.max(1, n - 1);
      const rpm = Math.max(500, r0 + (r1 - r0) * f + noise(r0 < 1000 ? 25 : 40));
      const map = clamp(m0 + (m1 - m0) * f + noise(1.2), 15, 105);
      const tps = tps0 === 0 ? Math.max(0, noise(0.3)) : clamp(tps0 + noise(1.5), 0, 100);
      cts = Math.min(192, cts + (cts < 185 ? 0.035 : 0.005));
      const target = lookup(base.afr, rpm, map) / stoich;
      const tv = lookup(trueVe, rpm, map);
      const ev = lookup(ecuVe, rpm, map);
      const decel = tps < 1 && rpm > 1400 && map < 30;
      const closedLoop = map < 80 && cts > 160 && !decel;
      let lam = decel ? 1.6 + noise(0.2) : (target * tv) / (ev * (1 + cl / 100));
      if (closedLoop) {
        const want = -(lam / target - 1) * 100;
        cl += (want * 0.6 - cl) * 0.02;
        cl = clamp(cl, -15, 15);
      } else cl *= 0.97;
      lamHist.push(lam + noise(0.006));
      // wideband lag of ~150 ms
      const lagged = lamHist[Math.max(0, lamHist.length - 1 - Math.round(0.15 * hz))];
      const afrL = lagged * stoich + noise(0.05);
      const afrR = lagged * stoich + noise(0.05);
      let timing = lookup(base.timing, rpm, map);
      let knock = 0;
      if (map > 94 && rpm > 3300 && rpm < 4600 && rand() < 0.25) knock = round(2 + rand() * 2.5, 0.5);
      timing -= knock;
      const duty = clamp((rpm / 6500) * (map / 100) * 85 + noise(1), 1, 95);
      rows.push([
        t.toFixed(3),
        rpm.toFixed(0),
        map.toFixed(1),
        tps.toFixed(1),
        cts.toFixed(1),
        (95 + noise(2)).toFixed(1),
        afrL.toFixed(2),
        afrR.toFixed(2),
        ((afrL + afrR) / 2).toFixed(2),
        (target * stoich).toFixed(2),
        cl.toFixed(1),
        '0.0',
        timing.toFixed(1),
        knock.toFixed(1),
        duty.toFixed(1),
      ]);
      t += 1 / hz;
    }
  }
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  return { csv, ecuVe, trueVe, timing: base.timing, afr: base.afr };
}
