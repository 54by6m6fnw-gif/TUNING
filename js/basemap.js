// Starting-point tables for an LS engine from a few build details.
// These are rough first-start maps, not a finished tune.

import { makeTable, round, clamp, FUELS } from './core.js';

export const DEFAULT_RPM_AXIS = [500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000];
export const DEFAULT_MAP_AXIS = [20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 105];

export const BUILD_DEFAULTS = {
  displacement: 5.3,
  camDuration: 212, // intake duration at .050
  lsa: 112,
  heads: 'cathedral',
  compression: 9.9,
  fuel: 'e10',
  boostPsi: 0,
  idleRpm: 800,
  redline: 6200,
};

const HEAD_VE = { cathedral: 88, rectangle: 92, ported: 97 };

export function buildBaseMap(spec, rpmAxis = DEFAULT_RPM_AXIS, mapAxis = DEFAULT_MAP_AXIS, layout) {
  const s = { ...BUILD_DEFAULTS, ...spec };
  const fuel = FUELS[s.fuel] || FUELS.gas;
  const dur = clamp(s.camDuration, 190, 270);
  const peakVe = (HEAD_VE[s.heads] || 90) + (dur - 210) * 0.15 + (s.displacement - 5.7) * 0.6;
  const torquePeak = clamp(3800 + (dur - 205) * 55 - (s.displacement - 5.7) * 150, 3000, 6000);
  // More overlap (longer duration, tighter LSA) means lower VE at low load.
  const overlap = clamp((dur - 200) / 60 + (114 - s.lsa) / 12, 0, 1.6);
  const boostKpa = Math.max(0, s.boostPsi) * 6.895;

  const ve = makeTable(rpmAxis, mapAxis, (rpm, kpa) => {
    const x = (rpm - torquePeak) / torquePeak;
    const rpmShape = x < 0 ? 1 - 0.55 * x * x : 1 - 0.9 * x * x;
    const wot = peakVe * clamp(rpmShape, 0.55, 1);
    const load = clamp(kpa / 100, 0.1, 1);
    const lowLoadLoss = 0.4 + 0.12 * overlap;
    let v = wot * (1 - lowLoadLoss * Math.pow(1 - load, 1.3));
    if (kpa > 100) v *= 1 + 0.04 * ((kpa - 100) / 100);
    if (rpm < s.idleRpm + 300) v *= 1 - 0.05 * overlap;
    return round(clamp(v, 15, 130), 0.1);
  }, layout);

  // Ignition timing in degrees BTDC.
  const e85 = s.fuel === 'e85' || s.fuel === 'meth';
  const crAdj = -Math.max(0, s.compression - 10.5) * 1.5 + (e85 ? 3 : 0) + (s.fuel === 'race' ? 2 : 0);
  const wotPeak = (s.heads === 'cathedral' ? 27 : 26) + crAdj;
  const timing = makeTable(rpmAxis, mapAxis, (rpm, kpa) => {
    const idle = 18 + overlap * 3;
    const cruise = rpm <= s.idleRpm + 200 ? idle : clamp(idle + (rpm - s.idleRpm - 200) * 0.009, idle, 38 + overlap * 2);
    const wot = rpm <= 1000 ? 12 + crAdj * 0.5 : clamp(12 + crAdj * 0.5 + (rpm - 1000) * 0.0065, 12, wotPeak);
    const loadFrac = clamp((100 - kpa) / 65, 0, 1);
    let adv = wot + (cruise - wot) * loadFrac;
    if (kpa > 100) adv = wot - ((kpa - 100) / 6.895) * 1.0;
    return round(clamp(adv, 5, 45), 0.5);
  }, layout);

  // Target AFR (shown in AFR for the chosen fuel).
  const wotLam = boostKpa > 0 ? 0.8 : 0.87;
  const afr = makeTable(rpmAxis, mapAxis, (rpm, kpa) => {
    let lam;
    if (kpa <= 60) lam = rpm < s.idleRpm + 300 ? 0.97 - overlap * 0.03 : 1.0;
    else if (kpa <= 100) lam = 1.0 + (wotLam + 0.02 - 1.0) * ((kpa - 60) / 40);
    else lam = wotLam - 0.04 * clamp((kpa - 100) / 100, 0, 1);
    return round(lam * fuel.stoich, 0.1);
  }, layout);

  return { ve, timing, afr, notes: { peakVe, torquePeak, overlap } };
}
