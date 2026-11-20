// "Archivio quote simili": find historical matches whose de-vigged odds profile (1, 2, Over 2.5)
// is closest to the target, and measure what actually happened in them.
import { devig } from './poisson.js';
import { MODEL } from '../config.js';

const PROFILE_BOOKS = ['avg', 'b365', 'ps', 'bfe', 'max'];
const first = (g) => (g ? PROFILE_BOOKS.map((b) => g[b]).find(Boolean) : null);

export function oddsProfile(m) {
  if (m._prof !== undefined) return m._prof;
  const o = m.odds || {};
  const x = first(o.x12) || first(o.x12c);
  const ou = first(o.ou25) || first(o.ou25c);
  const px = x && devig(x);
  const po = ou && devig(ou);
  m._prof = px ? { h: px[0], d: px[1], a: px[2], o: po ? po[0] : null } : null;
  return m._prof;
}

const res = (h, a) => (h > a ? '1' : h === a ? 'X' : '2');

/**
 * @returns null or { n, avgDistance, ft: count matrix, ht: count matrix, htft counts, nHt, examples }
 */
export function similarMatches(store, target, { k = MODEL.similarK } = {}) {
  const tp = oddsProfile(target);
  if (!tp) return null;
  const cands = [];
  for (const m of store.playedAll) {
    if (m.ts >= target.ts) break; // playedAll is sorted by time: never look into the future
    const p = oddsProfile(m);
    if (!p) continue;
    let d2 = (p.h - tp.h) ** 2 + (p.a - tp.a) ** 2;
    if (tp.o !== null && p.o !== null) d2 += (p.o - tp.o) ** 2;
    else if (tp.o !== null) d2 += 0.0025; // penalise matches without an O/U price
    let d = Math.sqrt(d2);
    if (m.league === target.league) d *= 0.8; // same league is more relevant
    if (d < 0.06) cands.push({ m, d });
  }
  if (cands.length < 30) return null;
  cands.sort((x, y) => x.d - y.d);
  const sel = cands.slice(0, k);

  const ft = Array.from({ length: 11 }, () => new Array(11).fill(0));
  const ht = Array.from({ length: 11 }, () => new Array(11).fill(0));
  const htft = {};
  let nHt = 0, sumD = 0, sameLeague = 0;
  for (const { m, d } of sel) {
    sumD += d;
    if (m.league === target.league) sameLeague++;
    ft[Math.min(m.ft[0], 10)][Math.min(m.ft[1], 10)]++;
    if (m.ht) {
      nHt++;
      ht[Math.min(m.ht[0], 10)][Math.min(m.ht[1], 10)]++;
      const key = `${res(m.ht[0], m.ht[1])}/${res(m.ft[0], m.ft[1])}`;
      htft[key] = (htft[key] || 0) + 1;
    }
  }
  return {
    n: sel.length, nHt, sameLeague,
    avgDistance: sumD / sel.length,
    maxDistance: sel.at(-1).d,
    ft, ht, htft,
    examples: sel.slice(0, 12).map(({ m, d }) => ({
      id: m.id, league: m.league, date: m.date, home: m.home, away: m.away, ft: m.ft, ht: m.ht,
      profile: oddsProfile(m), distance: d,
    })),
  };
}

export function countsToMatrix(C, n) {
  return C.map((row) => row.map((v) => v / n));
}
