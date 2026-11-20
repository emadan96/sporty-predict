// Score-distribution maths: Poisson / Dixon-Coles matrices and every market derived from them.

const FACT = [1];
for (let i = 1; i <= 30; i++) FACT[i] = FACT[i - 1] * i;

export function poissonPmf(k, lambda) {
  return Math.exp(-lambda) * lambda ** k / FACT[k];
}

/** Dixon-Coles corrected score matrix M[h][a], normalized to 1. */
export function scoreMatrix(lh, la, rho = 0, max = 10) {
  const ph = Array.from({ length: max + 1 }, (_, k) => poissonPmf(k, lh));
  const pa = Array.from({ length: max + 1 }, (_, k) => poissonPmf(k, la));
  const M = [];
  let total = 0;
  for (let h = 0; h <= max; h++) {
    M.push(new Array(max + 1));
    for (let a = 0; a <= max; a++) {
      let tau = 1;
      if (h === 0 && a === 0) tau = 1 - lh * la * rho;
      else if (h === 0 && a === 1) tau = 1 + lh * rho;
      else if (h === 1 && a === 0) tau = 1 + la * rho;
      else if (h === 1 && a === 1) tau = 1 - rho;
      const v = Math.max(0, ph[h] * pa[a] * tau);
      M[h][a] = v;
      total += v;
    }
  }
  for (const row of M) for (let a = 0; a < row.length; a++) row[a] /= total;
  return M;
}

export function blendMatrices(A, B, wB) {
  return A.map((row, h) => row.map((v, a) => (1 - wB) * v + wB * (B[h]?.[a] ?? 0)));
}

export function sumWhere(M, pred) {
  let s = 0;
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) if (pred(h, a)) s += M[h][a];
  return s;
}

export function outcome3(M) {
  return {
    home: sumWhere(M, (h, a) => h > a),
    draw: sumWhere(M, (h, a) => h === a),
    away: sumWhere(M, (h, a) => h < a),
  };
}

export function expectedGoals(M) {
  let eh = 0, ea = 0;
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) { eh += h * M[h][a]; ea += a * M[h][a]; }
  return [eh, ea];
}

/**
 * Asian handicap from the home side's perspective (line = home handicap, e.g. -0.75).
 * Returns { win, push, lose, halfWin, halfLose, fairHome, fairAway, pHome } where pHome is the
 * break-even implied probability of the home side (comparable with de-vigged market odds).
 */
export function asianHandicap(M, line) {
  const quarter = Math.abs((line * 4) % 2) === 1;
  const parts = quarter ? [line - 0.25, line + 0.25] : [line];
  let W = 0, L = 0;
  const detail = { win: 0, push: 0, lose: 0 };
  for (const part of parts) {
    const share = 1 / parts.length;
    for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) {
      const d = h - a + part;
      const p = M[h][a] * share;
      if (d > 1e-9) { W += p; detail.win += p; } else if (d < -1e-9) { L += p; detail.lose += p; } else detail.push += p;
    }
  }
  return { ...detail, fairHome: W > 0 ? 1 + L / W : Infinity, fairAway: L > 0 ? 1 + W / L : Infinity, pHome: W / (W + L) };
}

const MULTIGOL_FT = [[1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [2, 3], [2, 4], [2, 5], [2, 6], [3, 4], [3, 5], [3, 6], [4, 5], [4, 6], [5, 6], [0, 1], [0, 2], [7, 99]];
const MULTIGOL_HT = [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [2, 4], [3, 99]];
const MULTIGOL_TEAM = [[0, 1], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 99]];
const label = ([a, b]) => (b >= 99 ? `${a}+` : `${a}-${b}`);

function totalsDistribution(M, upto = 7) {
  const d = new Array(upto + 1).fill(0);
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) d[Math.min(h + a, upto)] += M[h][a];
  return d;
}

function teamDist(M, side, upto = 5) {
  const d = new Array(upto + 1).fill(0);
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) d[Math.min(side === 'home' ? h : a, upto)] += M[h][a];
  return d;
}

function rangeProb(dist, [lo, hi]) {
  let s = 0;
  for (let k = lo; k < dist.length && k <= hi; k++) s += dist[k];
  return s;
}

function topScores(M, n) {
  const list = [];
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) list.push({ score: `${h}-${a}`, p: M[h][a] });
  return list.sort((x, y) => y.p - x.p).slice(0, n);
}

/** Every market of a full-time-like score matrix. */
export function marketsFrom(M, { multigol = MULTIGOL_FT, lines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5] } = {}) {
  const o3 = outcome3(M);
  const tot = totalsDistribution(M, 12);
  const over = {};
  for (const l of lines) over[l] = sumWhere(M, (h, a) => h + a > l);
  const btts = sumWhere(M, (h, a) => h > 0 && a > 0);
  const homeD = teamDist(M, 'home', 10), awayD = teamDist(M, 'away', 10);
  const teamOver = (d) => ({ 0.5: 1 - d[0], 1.5: 1 - d[0] - d[1], 2.5: 1 - d[0] - d[1] - d[2] });
  const [eh, ea] = expectedGoals(M);
  const top = topScores(M, 10);
  return {
    x12: o3,
    dc: { '1X': o3.home + o3.draw, X2: o3.draw + o3.away, 12: o3.home + o3.away },
    dnb: { home: o3.home / (o3.home + o3.away), away: o3.away / (o3.home + o3.away) },
    over,
    btts: { yes: btts, no: 1 - btts },
    bttsOver25: sumWhere(M, (h, a) => h > 0 && a > 0 && h + a > 2.5),
    oddEven: { odd: sumWhere(M, (h, a) => (h + a) % 2 === 1), even: sumWhere(M, (h, a) => (h + a) % 2 === 0) },
    multigol: multigol.map((r) => ({ range: label(r), p: rangeProb(tot, r) })),
    multigolHome: MULTIGOL_TEAM.map((r) => ({ range: label(r), p: rangeProb(homeD, r) })),
    multigolAway: MULTIGOL_TEAM.map((r) => ({ range: label(r), p: rangeProb(awayD, r) })),
    teamOver: { home: teamOver(homeD), away: teamOver(awayD) },
    totals: tot.slice(0, 8).map((p, k) => ({ goals: k === 7 ? '7+' : String(k), p: k === 7 ? tot.slice(7).reduce((s, x) => s + x, 0) : p })),
    cleanSheet: { home: awayD[0], away: homeD[0] },
    xg: [eh, ea],
    exact: top,
    matrix: M.slice(0, 6).map((row) => row.slice(0, 6)),
  };
}

export function marketsHT(M) {
  const m = marketsFrom(M, { multigol: MULTIGOL_HT, lines: [0.5, 1.5, 2.5] });
  return { ...m, matrix: M.slice(0, 4).map((row) => row.slice(0, 4)), exact: m.exact.slice(0, 8) };
}

/** HT/FT 3x3 joint assuming independent halves. keys like "1/1", "X/2". */
export function htftJoint(HT, H2) {
  const key = (h, a) => (h > a ? '1' : h === a ? 'X' : '2');
  const out = { '1/1': 0, '1/X': 0, '1/2': 0, 'X/1': 0, 'X/X': 0, 'X/2': 0, '2/1': 0, '2/X': 0, '2/2': 0 };
  for (let h1 = 0; h1 < HT.length; h1++) for (let a1 = 0; a1 < HT[h1].length; a1++) {
    const p1 = HT[h1][a1];
    if (p1 < 1e-7) continue;
    for (let h2 = 0; h2 < H2.length; h2++) for (let a2 = 0; a2 < H2[h2].length; a2++) {
      out[`${key(h1, a1)}/${key(h1 + h2, a1 + a2)}`] += p1 * H2[h2][a2];
    }
  }
  return out;
}

/** Probability distribution "goals in which half" (1st > 2nd, equal, 2nd > 1st). */
export function halfComparison(HT, H2) {
  let first = 0, eq = 0, second = 0;
  const t1 = totalsDistribution(HT, 10), t2 = totalsDistribution(H2, 10);
  for (let i = 0; i < t1.length; i++) for (let j = 0; j < t2.length; j++) {
    const p = t1[i] * t2[j];
    if (i > j) first += p; else if (i === j) eq += p; else second += p;
  }
  return { first, equal: eq, second };
}

// ---------- odds helpers ----------

/** Power-method de-vig: finds k with sum((1/o)^k) = 1. Handles favourite-longshot bias better than normalising. */
export function devig(odds) {
  if (!odds || odds.some((o) => !o || o <= 1)) return null;
  const inv = odds.map((o) => 1 / o);
  const book = inv.reduce((s, x) => s + x, 0);
  if (book <= 1) return inv.map((x) => x / book);
  let lo = 1, hi = 3;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const s = inv.reduce((acc, x) => acc + x ** k, 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const p = inv.map((x) => x ** k);
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / s);
}

export const overround = (odds) => (odds ? odds.reduce((s, o) => s + 1 / o, 0) - 1 : null);

/** Over/Under on any line incl. Asian quarter lines: break-even probability of the Over side. */
export function asianTotal(M, line) {
  const quarter = Math.abs((line * 4) % 2) === 1;
  const parts = quarter ? [line - 0.25, line + 0.25] : [line];
  let W = 0, L = 0, push = 0;
  for (const part of parts) {
    const share = 1 / parts.length;
    for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) {
      const d = h + a - part;
      const p = M[h][a] * share;
      if (d > 1e-9) W += p; else if (d < -1e-9) L += p; else push += p;
    }
  }
  return { win: W, lose: L, push, pOver: W / (W + L), fairOver: W > 0 ? 1 + L / W : Infinity, fairUnder: L > 0 ? 1 + W / L : Infinity };
}
