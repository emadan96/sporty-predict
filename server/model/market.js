// Market-implied expected goals: find (lambdaHome, lambdaAway) whose score matrix reproduces the
// de-vigged 1X2, main Over/Under (Asian total line) and Asian-handicap prices of the sharpest book.
import { scoreMatrix, outcome3, asianHandicap, asianTotal, devig } from './poisson.js';
import { MODEL } from '../config.js';

// Sharp/Asian books first: Pinnacle, SBOBET, 188Bet, Dafabet, Betfair exchange, then market average, Bet365.
export const BOOK_PRIORITY = ['ps', 'sbo', 'b188', 'dafa', 'bfe', 'avg', 'b365', 'x1', 'max'];
export const BOOK_LABEL = {
  ps: 'Pinnacle', sbo: 'SBOBET', b188: '188Bet', dafa: 'Dafabet', bfe: 'Betfair Exchange', bf: 'Betfair', avg: 'Media bookmaker',
  b365: 'Bet365', x1: '1xBet', max: 'Quota max', mara: 'Marathonbet', wh: 'William Hill', bwin: 'Bwin', unibet: 'Unibet',
  b10: '10Bet', betway: 'Betway', iw: 'Interwetten',
};
export const bookLabel = (b) => BOOK_LABEL[b] || b;

export function pickBook(group) {
  if (!group) return null;
  for (const b of BOOK_PRIORITY) if (group[b]) return { book: b, odds: group[b] };
  return null;
}

const withoutLine = (g) => (g ? Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'line')) : null);

/** Balanced line of a { line: group } map according to the sharpest book. */
function balancedLine(lines) {
  let best = null;
  for (const [k, g] of Object.entries(lines || {})) {
    const pb = pickBook(g);
    if (!pb) continue;
    const d = Math.abs(1 / pb.odds[0] - 1 / pb.odds[1]);
    if (!best || d < best.d) best = { line: Number(k), pb, d };
  }
  return best;
}

/** Market inputs for a match. Uses pre-match prices, falling back to closing ones (football-data extra leagues). */
export function marketInputs(match) {
  const o = match.odds || {};
  const x12 = pickBook(o.x12) || pickBook(o.x12c);
  let ou = null;
  if (o.ouMain) { const pb = pickBook(withoutLine(o.ouMain)); if (pb) ou = { ...pb, line: o.ouMain.line }; }
  if (!ou) { const pb = pickBook(o.ou25) || pickBook(o.ou25c); if (pb) ou = { ...pb, line: 2.5 }; }
  const ahGroup = o.ah || o.ahc;
  const ah = ahGroup ? pickBook(withoutLine(ahGroup)) : null;
  const ht = pickBook(o.ht1x2);
  const htLine = balancedLine(o.htou);
  return {
    x12: x12 && { ...x12, p: devig(x12.odds) },
    ou: ou && { ...ou, p: devig(ou.odds) },
    ah: ah && { ...ah, line: ahGroup.line, p: devig(ah.odds) },
    ht1x2: ht && { ...ht, p: devig(ht.odds) },
    htou: htLine && { book: htLine.pb.book, odds: htLine.pb.odds, line: htLine.line, p: devig(htLine.pb.odds) },
  };
}

function search2d(loss, x0, y0) {
  let x = x0, y = y0, best = loss(x, y);
  for (const step of [0.3, 0.15, 0.08, 0.04, 0.02, 0.01, 0.005, 0.0025]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
        const v = loss(x + dx, y + dy);
        if (v < best - 1e-12) { best = v; x += dx; y += dy; improved = true; }
      }
    }
  }
  return { x, y, best };
}

export function solveLambdas(inputs, prior) {
  if (!inputs.x12?.p) return null;
  const [pH, , pA] = inputs.x12.p;
  const ou = inputs.ou?.p ? { line: inputs.ou.line, pOver: inputs.ou.p[0] } : null;
  const ah = inputs.ah?.p ? { line: inputs.ah.line, pHome: inputs.ah.p[0] } : null;
  const rho = MODEL.rho;
  const priorTotal = prior ? prior.lh + prior.la : 2.6;

  const loss = (x, y) => {
    const lh = Math.exp(x), la = Math.exp(y);
    const M = scoreMatrix(lh, la, rho, 9);
    const o3 = outcome3(M);
    let e = (o3.home - pH) ** 2 + (o3.away - pA) ** 2;
    if (ou) e += (asianTotal(M, ou.line).pOver - ou.pOver) ** 2;
    else e += 0.004 * (Math.log((lh + la) / priorTotal)) ** 2; // weak anchor when no totals price exists
    if (ah) e += 0.6 * (asianHandicap(M, ah.line).pHome - ah.pHome) ** 2;
    return e;
  };
  const { x, y, best } = search2d(loss, Math.log(prior?.lh || 1.4), Math.log(prior?.la || 1.1));
  return { lh: Math.exp(x), la: Math.exp(y), fitError: Math.sqrt(best) };
}

/**
 * First-half goal share implied by first-half odds (1X2 PT and/or O/U PT), given full-time lambdas.
 * Returns [shareHome, shareAway] or null.
 */
export function solveHtShare(inputs, lh, la, fallback) {
  const ht = inputs.ht1x2?.p, hou = inputs.htou;
  if (!ht && !hou) return null;
  const loss = (x, y) => {
    const sh = 1 / (1 + Math.exp(-x)), sa = 1 / (1 + Math.exp(-y));
    const M = scoreMatrix(lh * sh, la * sa, MODEL.rho, 8);
    let e = 0;
    if (ht) { const o3 = outcome3(M); e += (o3.home - ht[0]) ** 2 + (o3.draw - ht[1]) ** 2 + (o3.away - ht[2]) ** 2; }
    if (hou) e += (asianTotal(M, hou.line).pOver - hou.p[0]) ** 2;
    e += 0.01 * ((sh - fallback[0]) ** 2 + (sa - fallback[1]) ** 2); // keep close to league shares
    return e;
  };
  const logit = (p) => Math.log(p / (1 - p));
  const { x, y } = search2d(loss, logit(fallback[0]), logit(fallback[1]));
  const clamp = (v) => Math.min(0.62, Math.max(0.3, v));
  return [clamp(1 / (1 + Math.exp(-x))), clamp(1 / (1 + Math.exp(-y)))];
}
