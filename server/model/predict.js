import { MODEL, LEAGUES } from '../config.js';
import { fitRatings } from './ratings.js';
import { marketInputs, solveLambdas, solveHtShare, bookLabel } from './market.js';
import { similarMatches, countsToMatrix } from './similar.js';
import {
  scoreMatrix, blendMatrices, marketsFrom, marketsHT, htftJoint, halfComparison, asianHandicap, asianTotal, overround,
} from './poisson.js';

const DAY = 86_400_000;

export class Predictor {
  constructor(store) {
    this.store = store;
    this.ratingsCache = new Map();
    this.predCache = new Map();
  }

  reset() {
    this.ratingsCache.clear();
    this.predCache.clear();
  }

  #cached(key, fn) {
    if (!this.ratingsCache.has(key)) this.ratingsCache.set(key, fn());
    return this.ratingsCache.get(key);
  }

  /** Ratings for a league as of the start of the match day. */
  ratings(league, ts) {
    const asOf = Math.floor(ts / DAY) * DAY;
    return this.#cached(`${league}|${asOf}`, () => fitRatings(this.store.played(league, asOf), asOf));
  }

  /**
   * Team-strength model for a match, choosing the right pool:
   * league -> its own ratings; national-team competitions -> all national-team matches;
   * club cups -> the teams' domestic league when both play in the same one.
   */
  modelFor(match) {
    const meta = this.store.leagues.get(match.league) || {};
    const asOf = Math.floor(match.ts / DAY) * DAY;
    if (meta.national) {
      const R = this.#cached(`NAT|${asOf}`, () => {
        const codes = new Set([...this.store.leagues.values()].filter((l) => l.national).map((l) => l.code));
        return fitRatings(this.store.playedAll.filter((m) => codes.has(m.league) && m.ts < asOf), asOf);
      });
      return R ? { R, pool: 'Nazionali (tutte le competizioni)', ...R.lambda(match.home, match.away) } : null;
    }
    if (meta.type === 'Cup') {
      const lh = this.store.teamLeague.get(match.home), la = this.store.teamLeague.get(match.away);
      if (lh && lh === la) {
        const R = this.ratings(lh, match.ts);
        const name = this.store.leagues.get(lh)?.name || lh;
        return R ? { R, pool: `Campionato ${name}`, ...R.lambda(match.home, match.away) } : null;
      }
      return null; // teams from different leagues: strengths are not comparable -> market only
    }
    const R = this.ratings(match.league, match.ts);
    return R ? { R, pool: 'Campionato', ...R.lambda(match.home, match.away) } : null;
  }

  predict(match) {
    if (this.predCache.has(match.id)) return this.predCache.get(match.id);
    const p = this.#compute(match);
    this.predCache.set(match.id, p);
    return p;
  }

  #compute(match) {
    const model = this.modelFor(match);
    const R = model?.R;
    const inputs = marketInputs(match);
    const market = solveLambdas(inputs, model);

    // ---- blend model and market expected goals ----
    let lh, la, wMarket;
    if (market && model) {
      wMarket = model.known ? MODEL.marketWeight : 0.9;
      lh = wMarket * market.lh + (1 - wMarket) * model.lh;
      la = wMarket * market.la + (1 - wMarket) * model.la;
    } else if (market) { wMarket = 1; ({ lh, la } = market); }
    else if (model) { wMarket = 0; ({ lh, la } = model); }
    else { wMarket = 0; lh = 1.45; la = 1.15; }

    // ---- first-half share: league history, refined by first-half odds when available ----
    const leagueShare = [R?.htShareH ?? MODEL.defaultHtShare, R?.htShareA ?? MODEL.defaultHtShare];
    const oddsShare = solveHtShare(inputs, lh, la, leagueShare);
    const [sh, sa] = oddsShare || leagueShare;

    const rho = MODEL.rho;
    const max = MODEL.maxGoals;
    const FTm = scoreMatrix(lh, la, rho, max);
    const HTm = scoreMatrix(lh * sh, la * sa, rho, max);
    const H2m = scoreMatrix(lh * (1 - sh), la * (1 - sa), 0, max);
    let htft = htftJoint(HTm, H2m);

    // ---- historical archive of similar odds ----
    const sim = similarMatches(this.store, match);
    let wArch = 0, wArchHt = 0, FT = FTm, HT = HTm, archive = null, archFt = null, archHt = null;
    if (sim) {
      wArch = 0.35 * sim.n / (sim.n + 150);
      FT = blendMatrices(FTm, countsToMatrix(sim.ft, sim.n), wArch);
      if (sim.nHt >= 40) {
        wArchHt = 0.35 * sim.nHt / (sim.nHt + 150);
        HT = blendMatrices(HTm, countsToMatrix(sim.ht, sim.nHt), wArchHt);
        htft = Object.fromEntries(Object.entries(htft).map(([k, v]) => [k, (1 - wArchHt) * v + wArchHt * (sim.htft[k] || 0) / sim.nHt]));
      }
      archFt = marketsFrom(countsToMatrix(sim.ft, sim.n));
      archHt = sim.nHt ? marketsHT(countsToMatrix(sim.ht, sim.nHt)) : null;
      archive = {
        n: sim.n, nHt: sim.nHt, sameLeague: sim.sameLeague, avgDistance: sim.avgDistance,
        ft: { x12: archFt.x12, over: archFt.over, btts: archFt.btts, multigol: archFt.multigol, exact: archFt.exact.slice(0, 6), xg: archFt.xg },
        ht: archHt && { x12: archHt.x12, over: archHt.over, btts: archHt.btts, exact: archHt.exact.slice(0, 5) },
        htft: sim.nHt ? Object.fromEntries(Object.entries(sim.htft).map(([k, v]) => [k, v / sim.nHt])) : null,
        examples: sim.examples,
      };
    }

    const ft = marketsFrom(FT);
    const ht = marketsHT(HT);
    const h2 = marketsFrom(H2m, { lines: [0.5, 1.5, 2.5] });
    const ahLine = inputs.ah?.line ?? null;
    const ah = ahLine !== null ? { line: ahLine, ...asianHandicap(FT, ahLine) } : null;
    const ouLine = inputs.ou?.line ?? null;
    const totalLine = ouLine !== null ? { line: ouLine, ...asianTotal(FT, ouLine) } : null;

    // Model fair prices on every Asian line the books quote (plus a default ladder).
    const o = match.odds || {};
    const ahKeys = new Set([...Object.keys(o.ahLines || {}), ...(ahLine !== null ? [String(ahLine)] : [])]);
    const centre = Math.round((FTm.length && (ft.xg[1] - ft.xg[0])) * 4) / 4;
    for (let d = -1; d <= 1; d += 0.25) ahKeys.add(String(Math.round((centre + d) * 4) / 4));
    const ahTable = [...ahKeys].map(Number).sort((a, b) => a - b).map((line) => {
      const r = asianHandicap(FT, line);
      return { line, fairHome: r.fairHome, fairAway: r.fairAway, pHome: r.pHome, books: o.ahLines?.[String(line)] || (o.ah?.line === line ? o.ah : null) };
    });
    const ouKeys = new Set([...Object.keys(o.ou || {}), '0.5', '1.5', '2.5', '3.5', '4.5', ...(ouLine !== null ? [String(ouLine)] : [])]);
    const ouTable = [...ouKeys].map(Number).sort((a, b) => a - b).map((line) => {
      const r = asianTotal(FT, line);
      return { line, pOver: r.pOver, fairOver: r.fairOver, fairUnder: r.fairUnder, books: o.ou?.[String(line)] || (line === 2.5 ? o.ou25 || o.ou25c : null) || null };
    });

    const trends = buildTrends(ft, ht, archFt, archHt, sim);
    const value = valueBets(match, ft, ah, totalLine, FT);
    const picks = buildPicks(ft, ht, htft);

    let confidence = 'bassa';
    if (market && model?.known && (market.fitError ?? 1) < 0.03) confidence = 'alta';
    else if (market || model?.known) confidence = 'media';

    const book = (x) => x && { book: bookLabel(x.book), odds: x.odds, p: x.p, ...(x.line !== undefined ? { line: x.line } : {}) };
    return {
      id: match.id,
      inputs: {
        model: model && { lh: model.lh, la: model.la, known: model.known, nHome: model.nHome, nAway: model.nAway, sample: R.sample, pool: model.pool },
        market: market && {
          lh: market.lh, la: market.la, fitError: market.fitError,
          x12: inputs.x12 && { ...book(inputs.x12), margin: overround(inputs.x12.odds) },
          ou: book(inputs.ou), ah: book(inputs.ah), ht1x2: book(inputs.ht1x2), htou: book(inputs.htou),
        },
        final: { lh, la },
        htShare: [sh, sa], htShareSource: oddsShare ? 'quote primo tempo' : 'storico campionato',
        weights: { market: wMarket, archive: wArch, archiveHt: wArchHt },
      },
      ft, ht,
      secondHalf: { x12: h2.x12, over: h2.over, xg: h2.xg },
      htft,
      halves: halfComparison(HTm, H2m),
      ah, totalLine, ahTable, ouTable,
      archive, trends,
      expected: { ft: ft.exact[0], ht: ht.exact[0], xg: ft.xg, xgHt: ht.xg },
      value, picks, confidence,
    };
  }

  /** Compact view for list rows. */
  summary(match) {
    const p = this.predict(match);
    return {
      x12: p.ft.x12, over25: p.ft.over[2.5], btts: p.ft.btts.yes, htOver05: p.ht.over[0.5], htOver15: p.ht.over[1.5],
      htX12: p.ht.x12, mg: p.ft.multigol.find((m) => m.range === '2-4')?.p, mgHt: p.ht.multigol.find((m) => m.range === '0-1')?.p,
      score: p.expected.ft.score, scoreHt: p.expected.ht.score, xg: p.ft.xg, confidence: p.confidence,
      index: p.trends.index[0] || null, hasValue: p.value.length > 0, bestValue: p.value[0] || null,
    };
  }
}

// ---------------------------------------------------------------- trends ("archivio" hit-rates)

function buildTrends(ft, ht, aFt, aHt, sim) {
  const mg = (m, r) => m.multigol.find((x) => x.range === r)?.p;
  const defs = [
    ['FT', '1', (m) => m.x12.home], ['FT', 'X', (m) => m.x12.draw], ['FT', '2', (m) => m.x12.away],
    ['FT', '1X', (m) => m.dc['1X']], ['FT', 'X2', (m) => m.dc.X2], ['FT', '12', (m) => m.dc[12]],
    ['FT', 'Over 0.5', (m) => m.over[0.5]], ['FT', 'Over 1.5', (m) => m.over[1.5]], ['FT', 'Over 2.5', (m) => m.over[2.5]],
    ['FT', 'Over 3.5', (m) => m.over[3.5]], ['FT', 'Under 1.5', (m) => 1 - m.over[1.5]], ['FT', 'Under 2.5', (m) => 1 - m.over[2.5]],
    ['FT', 'Under 3.5', (m) => 1 - m.over[3.5]], ['FT', 'Under 4.5', (m) => 1 - m.over[4.5]],
    ['FT', 'Goal', (m) => m.btts.yes], ['FT', 'No Goal', (m) => m.btts.no],
    ['FT', 'MG 1-2', (m) => mg(m, '1-2')], ['FT', 'MG 1-3', (m) => mg(m, '1-3')], ['FT', 'MG 1-4', (m) => mg(m, '1-4')],
    ['FT', 'MG 1-5', (m) => mg(m, '1-5')], ['FT', 'MG 2-3', (m) => mg(m, '2-3')], ['FT', 'MG 2-4', (m) => mg(m, '2-4')],
    ['FT', 'MG 2-5', (m) => mg(m, '2-5')], ['FT', 'MG 3-5', (m) => mg(m, '3-5')],
    ['FT', 'Casa segna', (m) => m.teamOver.home[0.5]], ['FT', 'Ospite segna', (m) => m.teamOver.away[0.5]],
    ['FT', 'Casa Over 1.5', (m) => m.teamOver.home[1.5]], ['FT', 'Ospite Over 1.5', (m) => m.teamOver.away[1.5]],
  ];
  const defsHt = [
    ['PT', '1 PT', (m) => m.x12.home], ['PT', 'X PT', (m) => m.x12.draw], ['PT', '2 PT', (m) => m.x12.away],
    ['PT', 'Over 0.5 PT', (m) => m.over[0.5]], ['PT', 'Over 1.5 PT', (m) => m.over[1.5]], ['PT', 'Under 1.5 PT', (m) => 1 - m.over[1.5]],
    ['PT', 'Under 0.5 PT', (m) => 1 - m.over[0.5]], ['PT', 'Goal PT', (m) => m.btts.yes],
    ['PT', 'MG PT 0-1', (m) => mg(m, '0-1')], ['PT', 'MG PT 1-2', (m) => mg(m, '1-2')], ['PT', 'MG PT 1-3', (m) => mg(m, '1-3')],
  ];
  const rows = [
    ...defs.map(([g, label, f]) => ({ group: g, label, model: f(ft), archive: aFt ? f(aFt) : null, n: sim?.n || 0 })),
    ...defsHt.map(([g, label, f]) => ({ group: g, label, model: f(ht), archive: aHt ? f(aHt) : null, n: sim?.nHt || 0 })),
  ];
  // "Indice": the most solid playable markets = model and archive agree, fair odds >= 1.30
  const index = rows
    .filter((r) => r.model <= 0.77 && (r.archive === null || r.n >= 60))
    .map((r) => ({ ...r, score: r.archive === null ? r.model * 0.97 : Math.min(r.model, r.archive) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { rows, index };
}

// ---------------------------------------------------------------- value bets

function valueBets(match, ft, ah, totalLine, FT) {
  const out = [];
  const o = match.odds || {};
  const skip = new Set(['line', 'avg']);
  const scan = (group, idx, market, sel, p, evFn) => {
    if (!group) return;
    for (const [book, odds] of Object.entries(group)) {
      if (skip.has(book) || !Array.isArray(odds) || !odds[idx]) continue;
      const edge = evFn ? evFn(odds[idx]) : p * odds[idx] - 1;
      if (edge > 0.03 && p > 0.15) out.push({ market, selection: sel, p, fair: 1 / p, book: bookLabel(book), odds: odds[idx], edge });
    }
  };
  scan(o.x12, 0, '1X2', '1', ft.x12.home);
  scan(o.x12, 1, '1X2', 'X', ft.x12.draw);
  scan(o.x12, 2, '1X2', '2', ft.x12.away);
  scan(o.ou25, 0, 'U/O 2.5', 'Over', ft.over[2.5]);
  scan(o.ou25, 1, 'U/O 2.5', 'Under', 1 - ft.over[2.5]);
  if (totalLine && o.ouMain && totalLine.line !== 2.5) {
    const t = totalLine;
    scan(o.ouMain, 0, `Total asiatico ${t.line}`, 'Over', t.pOver, (x) => t.win * (x - 1) - t.lose);
    scan(o.ouMain, 1, `Total asiatico ${t.line}`, 'Under', 1 - t.pOver, (x) => t.lose * (x - 1) - t.win);
  }
  if (ah && o.ah) {
    const ln = (x) => (x > 0 ? `+${x}` : `${x}`);
    scan(o.ah, 0, 'Handicap asiatico', `Casa ${ln(ah.line)}`, ah.pHome, (x) => ah.win * (x - 1) - ah.lose);
    scan(o.ah, 1, 'Handicap asiatico', `Ospite ${ln(-ah.line)}`, 1 - ah.pHome, (x) => ah.lose * (x - 1) - ah.win);
  }
  if (o.btts) {
    scan(o.btts, 0, 'Goal/No Goal', 'Goal', ft.btts.yes);
    scan(o.btts, 1, 'Goal/No Goal', 'No Goal', ft.btts.no);
  }
  const best = new Map();
  for (const v of out) {
    const key = v.market + v.selection;
    if (!best.has(key) || best.get(key).edge < v.edge) best.set(key, v);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

function buildPicks(ft, ht, htft) {
  const picks = [];
  const add = (category, label, p) => picks.push({ category, label, p, fair: 1 / p });
  const argmax = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0];

  const x = ft.x12;
  const [k1, p1] = argmax({ 1: x.home, X: x.draw, 2: x.away });
  add('Esito finale', k1, p1);
  const [kdc, pdc] = argmax(ft.dc);
  add('Doppia chance', kdc, pdc);
  const o25 = ft.over[2.5];
  add('Under/Over', o25 >= 0.5 ? 'Over 2.5' : 'Under 2.5', Math.max(o25, 1 - o25));
  add('Under/Over', ft.over[1.5] >= 1 - ft.over[3.5] ? 'Over 1.5' : 'Under 3.5', Math.max(ft.over[1.5], 1 - ft.over[3.5]));
  add('Goal/NoGoal', ft.btts.yes >= 0.5 ? 'Goal' : 'No Goal', Math.max(ft.btts.yes, ft.btts.no));
  const mg = ft.multigol.filter((m) => ['1-3', '2-4', '2-3', '1-2', '3-5', '0-2'].includes(m.range)).sort((a, b) => b.p - a.p)[0];
  add('Multigol', `Multigol ${mg.range}`, mg.p);
  const [kht, pht] = argmax({ '1 PT': ht.x12.home, 'X PT': ht.x12.draw, '2 PT': ht.x12.away });
  add('Primo tempo', kht, pht);
  add('Primo tempo', ht.over[0.5] >= 0.5 ? 'Over 0.5 PT' : 'Under 0.5 PT', Math.max(ht.over[0.5], 1 - ht.over[0.5]));
  const mgHt = [...ht.multigol].filter((m) => ['0-1', '1-2', '1-3'].includes(m.range)).sort((a, b) => b.p - a.p)[0];
  add('Primo tempo', `Multigol PT ${mgHt.range}`, mgHt.p);
  const [khf, phf] = argmax(htft);
  add('Parziale/Finale', khf, phf);
  add('Risultato esatto', ft.exact[0].score, ft.exact[0].p);
  return picks;
}

export function leagueInfo(code) {
  return { code, ...LEAGUES[code] };
}
