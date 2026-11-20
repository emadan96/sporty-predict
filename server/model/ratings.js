// Time-decayed attack/defence ratings per league (multiplicative Poisson model, shrunk to the mean).
import { MODEL } from '../config.js';

const DAY = 86_400_000;
const WINDOW_DAYS = 800;

/**
 * @param {Array} matches played matches of one league, sorted by ts, all before asOfTs
 * @returns ratings object with lambda(home, away) and HT shares
 */
export function fitRatings(matches, asOfTs) {
  const { decayPerDay, priorWeight, xgWeight } = MODEL;
  const rows = [];
  for (const m of matches) {
    const age = (asOfTs - m.ts) / DAY;
    if (age < 0 || age > WINDOW_DAYS) continue;
    const w = Math.exp(-decayPerDay * age);
    const gh = m.xg ? (1 - xgWeight) * m.ft[0] + xgWeight * m.xg[0] : m.ft[0];
    const ga = m.xg ? (1 - xgWeight) * m.ft[1] + xgWeight * m.xg[1] : m.ft[1];
    rows.push({ h: m.home, a: m.away, gh, ga, w, age, ht: m.ht, ft: m.ft });
  }
  if (rows.length < 30) return null;

  let sw = 0, sh = 0, sa = 0;
  let htW = 0, htH = 0, htA = 0, ftHforHt = 0, ftAforHt = 0;
  const teams = new Map();
  const team = (t) => {
    if (!teams.has(t)) teams.set(t, { att: 1, def: 1, n: 0, oldN: 0, wsum: 0 });
    return teams.get(t);
  };
  for (const r of rows) {
    sw += r.w; sh += r.w * r.gh; sa += r.w * r.ga;
    for (const t of [team(r.h), team(r.a)]) { t.n++; t.wsum += r.w; if (r.age > 300) t.oldN++; }
    if (r.ht) {
      htW += r.w; htH += r.w * r.ht[0]; htA += r.w * r.ht[1]; ftHforHt += r.w * r.ft[0]; ftAforHt += r.w * r.ft[1];
    }
  }
  const muH = sh / sw, muA = sa / sw;
  const gbar = (muH + muA) / 2;

  // Teams with no history older than ~10 months in this league are most likely promoted: weaker prior.
  for (const t of teams.values()) {
    const isNew = t.oldN === 0 && rows.some((r) => r.age > 300);
    t.priorAtt = isNew ? 0.85 : 1;
    t.priorDef = isNew ? 1.15 : 1;
    t.att = t.priorAtt; t.def = t.priorDef;
  }

  for (let iter = 0; iter < 40; iter++) {
    const numA = new Map(), denA = new Map(), numD = new Map(), denD = new Map();
    const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
    for (const r of rows) {
      const H = teams.get(r.h), A = teams.get(r.a);
      add(numA, r.h, r.w * r.gh); add(denA, r.h, r.w * muH * A.def);
      add(numA, r.a, r.w * r.ga); add(denA, r.a, r.w * muA * H.def);
      add(numD, r.a, r.w * r.gh); add(denD, r.a, r.w * muH * H.att);
      add(numD, r.h, r.w * r.ga); add(denD, r.h, r.w * muA * A.att);
    }
    const P = priorWeight * gbar;
    for (const [name, t] of teams) {
      t.att = (numA.get(name) + P * t.priorAtt) / (denA.get(name) + P);
      t.def = (numD.get(name) + P * t.priorDef) / (denD.get(name) + P);
    }
    // Normalise to geometric mean 1 so muH/muA keep their meaning.
    let la = 0, ld = 0;
    for (const t of teams.values()) { la += Math.log(t.att); ld += Math.log(t.def); }
    const ga = Math.exp(la / teams.size), gd = Math.exp(ld / teams.size);
    for (const t of teams.values()) { t.att /= ga; t.def /= gd; }
  }

  const htShareH = htW > 0 && ftHforHt > 0 ? htH / ftHforHt : MODEL.defaultHtShare;
  const htShareA = htW > 0 && ftAforHt > 0 ? htA / ftAforHt : MODEL.defaultHtShare;

  return {
    muH, muA, htShareH, htShareA, sample: rows.length, hasHt: htW > 0,
    teams: Object.fromEntries([...teams].map(([k, t]) => [k, { att: t.att, def: t.def, n: t.n }])),
    lambda(home, away) {
      const H = teams.get(home), A = teams.get(away);
      const hAtt = H ? H.att : 0.85, hDef = H ? H.def : 1.15;
      const aAtt = A ? A.att : 0.85, aDef = A ? A.def : 1.15;
      return { lh: muH * hAtt * aDef, la: muA * aAtt * hDef, known: Boolean(H && A), nHome: H?.n || 0, nAway: A?.n || 0 };
    },
  };
}
