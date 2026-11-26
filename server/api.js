// Shared read-only views over the store, used by the HTTP server and by the static build.
import { LEAGUES } from './config.js';
import { pickBook, bookLabel } from './model/market.js';

export function createApi(store, predictor) {
  const FD_ORDER = Object.keys(LEAGUES);
  const CAT_ORDER = ['Coppe internazionali', 'Nazionali', 'Campionati', 'Coppe nazionali'];
  function leagueRank(meta) {
    if (!meta) return [9, 9999, ''];
    if (meta.featured < 999) return [0, meta.featured, ''];
    if (meta.tier === 'fd') return [1, FD_ORDER.indexOf(meta.code), ''];
    if (meta.countryEn === 'Italy') return [1, 50, meta.name];
    return [2 + CAT_ORDER.indexOf(meta.category), 0, `${meta.country} ${meta.name}`];
  }
  const cmpRank = (a, b) => {
    const x = leagueRank(a), y = leagueRank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  };
  const leagueMeta = (code) => store.leagues.get(code) || { code, name: code, country: '' };

  function matchView(m) {
    return {
      id: m.id, league: m.league, date: m.date, time: m.time,
      home: m.homeName || m.home, away: m.awayName || m.away, homeLogo: m.homeLogo || null, awayLogo: m.awayLogo || null,
      status: m.status, statusText: m.statusText || null, ft: m.ft, ht: m.ht, xg: m.xg, afterExtra: m.afterExtra || null, round: m.round || null,
      afId: m.afId || null, live: m.live || null, rc: m.rc || null,
    };
  }

  /** Opening vs current prices of the reference book (Asian books first). */
  function movement(m) {
    const o = m.odds || {};
    const strip = (g) => (g ? Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'line')) : null);
    let open, cur;
    if (m.oddsOpen) {
      open = m.oddsOpen;
      const x = pickBook(o.x12), a = pickBook(strip(o.ah)), u = pickBook(strip(o.ouMain));
      cur = { x12: x && { book: x.book, odds: x.odds }, ah: a && { line: o.ah.line, book: a.book, odds: a.odds }, ou: u && { line: o.ouMain.line, book: u.book, odds: u.odds } };
    } else if (o.x12c || o.ahc) { // football-data: pre-match vs closing
      const x0 = pickBook(o.x12), x1 = pickBook(o.x12c), a0 = pickBook(strip(o.ah)), a1 = pickBook(strip(o.ahc));
      const u0 = pickBook(o.ou25), u1 = pickBook(o.ou25c);
      open = { x12: x0, ah: a0 && { line: o.ah.line, ...a0 }, ou: u0 && { line: 2.5, ...u0 } };
      cur = { x12: x1, ah: a1 && { line: o.ahc.line, ...a1 }, ou: u1 && { line: 2.5, ...u1 } };
    } else {
      const x = pickBook(o.x12), a = pickBook(strip(o.ah)), u = o.ouMain ? pickBook(strip(o.ouMain)) : pickBook(o.ou25);
      cur = { x12: x, ah: a && { line: o.ah.line, ...a }, ou: u && { line: o.ouMain?.line ?? 2.5, ...u } };
      open = null;
    }
    const lbl = (s) => s && { ...s, book: bookLabel(s.book) };
    return {
      open: open && { x12: lbl(open.x12), ah: lbl(open.ah), ou: lbl(open.ou) },
      cur: cur && { x12: lbl(cur.x12), ah: lbl(cur.ah), ou: lbl(cur.ou) },
      updated: m.oddsUpdated || null,
    };
  }

  function oddsView(m) {
    const o = m.odds || {};
    return {
      x12: o.x12 || o.x12c || null, ou25: o.ou25 || o.ou25c || null, ah: o.ah || o.ahc || null,
      ou: o.ou || null, ouMain: o.ouMain || null, ahLines: o.ahLines || null, ht1x2: o.ht1x2 || null, htou: o.htou || null, btts: o.btts || null,
      closing: { x12: o.x12c || null, ou25: o.ou25c || null, ah: o.ahc || null },
      labels: Object.fromEntries(['ps', 'sbo', 'b188', 'dafa', 'bfe', 'bf', 'b365', 'x1', 'mara', 'wh', 'bwin', 'unibet', 'b10', 'betway', 'iw', 'avg', 'max'].map((k) => [k, bookLabel(k)])),
    };
  }

  return {
    leagues: () => [...store.leagues.values()].sort(cmpRank)
      .map(({ code, name, country, flag, flagUrl, logo, category }) => ({ code, name, country, flag, flagUrl, logo, category })),

    dates: () => {
      const counts = {};
      for (const m of store.matches) counts[m.date] = (counts[m.date] || 0) + 1;
      return { ...store.dateRange(), counts, loadedAt: store.loadedAt };
    },

    matches: (date, leagueFilter = null) => {
      const groups = new Map();
      for (const m of store.byDate(date)) {
        if (leagueFilter && m.league !== leagueFilter) continue;
        if (!groups.has(m.league)) groups.set(m.league, []);
        let pred = null;
        try { pred = predictor.summary(m); } catch (e) { console.error('predict', m.id, e); }
        groups.get(m.league).push({ ...matchView(m), move: movement(m), pred });
      }
      return {
        date,
        leagues: [...groups.entries()]
          .map(([code, matches]) => ({ ...leagueMeta(code), matches: matches.sort((a, b) => a.time.localeCompare(b.time) || a.home.localeCompare(b.home)) }))
          .sort(cmpRank),
      };
    },

    match: (id) => {
      const m = store.byId.get(id);
      if (!m) return null;
      const pred = predictor.predict(m);
      const formRow = (team) => store.teamForm(null, team, m.ts, 8).map((x) => ({
        ...matchView(x), leagueName: leagueMeta(x.league).name,
        result: x.ft[0] === x.ft[1] ? 'N' : (x.ft[0] > x.ft[1]) === (x.home === team) ? 'V' : 'P',
      }));
      const meta = leagueMeta(m.league);
      return {
        match: { ...matchView(m), homeKey: m.home, awayKey: m.away, referee: m.referee, stats: m.stats, events: m.events || null, season: m.season, venue: m.venue || null },
        league: meta,
        odds: oddsView(m),
        move: movement(m),
        prediction: pred,
        form: { home: formRow(m.home), away: formRow(m.away) },
        h2h: store.h2h(m.home, m.away, m.ts, 8).map((x) => ({ ...matchView(x), leagueName: leagueMeta(x.league).name })),
        standings: meta.type === 'Cup' || meta.national ? [] : store.standings(m.league),
      };
    },

    /** Compact row used by search results. */
    searchRow: (m) => ({ ...matchView(m), leagueName: leagueMeta(m.league).name }),

    search: (term) => {
      term = (term || '').toLowerCase().trim();
      if (term.length < 2) return [];
      const now = Date.now();
      const hit = (m) => [m.home, m.away, m.homeName, m.awayName].some((n) => n && n.toLowerCase().includes(term));
      return store.matches.filter(hit)
        .sort((a, b) => Math.abs(a.ts - now) - Math.abs(b.ts - now))
        .slice(0, 20).map((m) => ({ ...matchView(m), leagueName: leagueMeta(m.league).name }));
    },
  };
}
