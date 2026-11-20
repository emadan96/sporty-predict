import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { loadApiFootball } from './providers/apifootball/load.js';
import {
  LEAGUES, DATA_DIR, MAIN_LEAGUES, EXTRA_LEAGUES, EXTRA_COUNTRY_TO_CODE, EXTRA_YEARS_BACK, UK_TO_ROME_HOURS,
} from './config.js';

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
function currentSeasonCode(now = new Date()) {
  const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
}
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Parse UK date + time and convert to Europe/Rome local date/time strings. */
function parseKickoff(dateStr, timeStr) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dateStr || '');
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const [hh, mm] = (timeStr && /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr : '15:00').split(':').map(Number);
  // Treat the wall-clock as UTC then shift: gives Rome wall-clock as a pseudo-UTC timestamp.
  const ts = Date.UTC(year, Number(m[2]) - 1, Number(m[1]), hh + UK_TO_ROME_HOURS, mm);
  const d = new Date(ts);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return { ts, date, time };
}

const triple = (r, a, b, c) => {
  const v = [num(r[a]), num(r[b]), num(r[c])];
  return v.every((x) => x && x > 1) ? v : null;
};
const pair = (r, a, b) => {
  const v = [num(r[a]), num(r[b])];
  return v.every((x) => x && x > 1) ? v : null;
};
const compact = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v) out[k] = v;
  return Object.keys(out).length ? out : null;
};

function mainOdds(r) {
  const x12 = compact({
    ps: triple(r, 'PSH', 'PSD', 'PSA'),
    bfe: triple(r, 'BFEH', 'BFED', 'BFEA'),
    b365: triple(r, 'B365H', 'B365D', 'B365A'),
    avg: triple(r, 'AvgH', 'AvgD', 'AvgA') || triple(r, 'BbAvH', 'BbAvD', 'BbAvA'),
    max: triple(r, 'MaxH', 'MaxD', 'MaxA') || triple(r, 'BbMxH', 'BbMxD', 'BbMxA'),
  });
  const x12c = compact({
    ps: triple(r, 'PSCH', 'PSCD', 'PSCA'),
    bfe: triple(r, 'BFECH', 'BFECD', 'BFECA'),
    b365: triple(r, 'B365CH', 'B365CD', 'B365CA'),
    avg: triple(r, 'AvgCH', 'AvgCD', 'AvgCA'),
    max: triple(r, 'MaxCH', 'MaxCD', 'MaxCA'),
  });
  const ou25 = compact({
    ps: pair(r, 'P>2.5', 'P<2.5'),
    bfe: pair(r, 'BFE>2.5', 'BFE<2.5'),
    b365: pair(r, 'B365>2.5', 'B365<2.5'),
    avg: pair(r, 'Avg>2.5', 'Avg<2.5') || pair(r, 'BbAv>2.5', 'BbAv<2.5'),
    max: pair(r, 'Max>2.5', 'Max<2.5'),
  });
  const ou25c = compact({
    ps: pair(r, 'PC>2.5', 'PC<2.5'),
    bfe: pair(r, 'BFEC>2.5', 'BFEC<2.5'),
    b365: pair(r, 'B365C>2.5', 'B365C<2.5'),
    avg: pair(r, 'AvgC>2.5', 'AvgC<2.5'),
  });
  const ahLine = num(r.AHh ?? r.BbAHh);
  const ah = ahLine === null ? null : compact({
    ps: pair(r, 'PAHH', 'PAHA'),
    bfe: pair(r, 'BFEAHH', 'BFEAHA'),
    b365: pair(r, 'B365AHH', 'B365AHA'),
    avg: pair(r, 'AvgAHH', 'AvgAHA') || pair(r, 'BbAvAHH', 'BbAvAHA'),
    max: pair(r, 'MaxAHH', 'MaxAHA'),
  });
  if (ah) ah.line = ahLine;
  const ahcLine = num(r.AHCh);
  const ahc = ahcLine === null ? null : compact({
    ps: pair(r, 'PCAHH', 'PCAHA'),
    b365: pair(r, 'B365CAHH', 'B365CAHA'),
    avg: pair(r, 'AvgCAHH', 'AvgCAHA'),
  });
  if (ahc) ahc.line = ahcLine;
  return compact({ x12, x12c, ou25, ou25c, ah, ahc });
}

function extraOdds(r) {
  const x12 = compact({
    ps: triple(r, 'PSH', 'PSD', 'PSA'),
    bfe: triple(r, 'BFEH', 'BFED', 'BFEA'),
    b365: triple(r, 'B365H', 'B365D', 'B365A'),
    avg: triple(r, 'AvgH', 'AvgD', 'AvgA'),
    max: triple(r, 'MaxH', 'MaxD', 'MaxA'),
  });
  const x12c = compact({
    ps: triple(r, 'PSCH', 'PSCD', 'PSCA'),
    bfe: triple(r, 'BFECH', 'BFECD', 'BFECA'),
    b365: triple(r, 'B365CH', 'B365CD', 'B365CA'),
    avg: triple(r, 'AvgCH', 'AvgCD', 'AvgCA'),
    max: triple(r, 'MaxCH', 'MaxCD', 'MaxCA'),
  });
  return compact({ x12, x12c });
}

function makeMatch(league, ko, home, away, extra) {
  return {
    id: `${league}-${ko.date.replace(/-/g, '')}-${slug(home)}-${slug(away)}`,
    league, date: ko.date, time: ko.time, ts: ko.ts, home, away, ...extra,
  };
}

function normalizeMain(r, leagueOverride, season = null) {
  const league = leagueOverride || r.Div;
  if (!MAIN_LEAGUES[league] || !r.HomeTeam || !r.AwayTeam) return null;
  const ko = parseKickoff(r.Date, r.Time);
  if (!ko) return null;
  const ftH = int(r.FTHG), ftA = int(r.FTAG);
  const htH = int(r.HTHG), htA = int(r.HTAG);
  const xgH = num(r.HxG), xgA = num(r.AxG);
  const played = ftH !== null && ftA !== null;
  return makeMatch(league, ko, r.HomeTeam, r.AwayTeam, {
    season: season || currentSeasonCode(),
    status: played ? 'FT' : 'NS',
    ft: played ? [ftH, ftA] : null,
    ht: htH !== null && htA !== null ? [htH, htA] : null,
    xg: xgH !== null && xgA !== null ? [xgH, xgA] : null,
    stats: played ? compact({
      shots: num(r.HS) !== null ? [num(r.HS), num(r.AS)] : null,
      sot: num(r.HST) !== null ? [num(r.HST), num(r.AST)] : null,
      corners: num(r.HC) !== null ? [num(r.HC), num(r.AC)] : null,
      yellow: num(r.HY) !== null ? [num(r.HY), num(r.AY)] : null,
      red: num(r.HR) !== null ? [num(r.HR), num(r.AR)] : null,
    }) : null,
    referee: r.Referee || null,
    odds: mainOdds(r),
  });
}

function normalizeExtra(r) {
  const league = EXTRA_COUNTRY_TO_CODE[r.Country];
  if (!league) return null;
  const home = r.Home, away = r.Away;
  if (!home || !away) return null;
  const ko = parseKickoff(r.Date, r.Time);
  if (!ko) return null;
  const ftH = int(r.HG), ftA = int(r.AG);
  const played = ftH !== null && ftA !== null;
  return makeMatch(league, ko, home, away, {
    season: r.Season || null,
    status: played ? 'FT' : 'NS', ft: played ? [ftH, ftA] : null, ht: null, xg: null, stats: null,
    referee: null, odds: extraOdds(r),
  });
}

/** Merge an API-Football record into the football-data record of the same match. */
function mergeAf(fd, af) {
  const out = {
    ...fd,
    afId: af.afId, homeName: af.homeName, awayName: af.awayName, homeLogo: af.homeLogo, awayLogo: af.awayLogo,
    homeTeamId: af.homeTeamId, awayTeamId: af.awayTeamId, round: af.round, venue: af.venue, referee: fd.referee || af.referee,
    oddsOpen: af.oddsOpen || fd.oddsOpen, oddsUpdated: af.oddsUpdated, source: 'fd+af',
  };
  if (fd.status !== 'FT') {
    Object.assign(out, { status: af.status, statusText: af.statusText, ft: af.ft, ht: af.ht, time: af.time, ts: af.ts });
  }
  if (af.odds) {
    const o = { ...(fd.odds || {}), ...af.odds };
    for (const g of ['x12', 'ou25']) if (fd.odds?.[g] && af.odds[g]) o[g] = { ...fd.odds[g], ...af.odds[g] };
    if (fd.odds?.ah && af.odds.ah && fd.odds.ah.line === af.odds.ah.line) o.ah = { ...fd.odds.ah, ...af.odds.ah };
    out.odds = o;
  }
  return out;
}

async function readCsv(file) {
  try {
    return parseCsv(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

export class Store {
  constructor() {
    this.matches = [];
    this.byId = new Map();
    this.byLeague = new Map();
    this.playedAll = [];
    this.leagues = new Map();
    this.teamLeague = new Map();
    this.afStatus = null;
    this.loadedAt = null;
  }

  async load() {
    const all = new Map();
    const put = (m) => {
      if (!m) return;
      const prev = all.get(m.id);
      // A played record always wins over a fixture; otherwise the later source wins.
      if (prev && prev.status === 'FT' && m.status !== 'FT') return;
      all.set(m.id, m);
    };

    const mainDir = path.join(DATA_DIR, 'main');
    let files = [];
    try { files = (await fs.readdir(mainDir)).filter((f) => f.endsWith('.csv')); } catch { /* none yet */ }
    files.sort(); // older seasons first
    for (const f of files) {
      const [season, code] = f.replace('.csv', '').split('_');
      for (const r of await readCsv(path.join(mainDir, f))) put(normalizeMain(r, code, season));
    }

    const minTs = Date.now() - EXTRA_YEARS_BACK * 365 * 86_400_000;
    for (const code of Object.keys(EXTRA_LEAGUES)) {
      for (const r of await readCsv(path.join(DATA_DIR, 'extra', `${code}.csv`))) {
        const m = normalizeExtra(r);
        if (m && m.ts >= minTs) put(m);
      }
    }

    // Upcoming fixtures (never overwrite a played match).
    for (const r of await readCsv(path.join(DATA_DIR, 'fixtures.csv'))) put(normalizeMain(r));
    for (const r of await readCsv(path.join(DATA_DIR, 'new_league_fixtures.csv'))) put(normalizeExtra(r));

    // League metadata: football-data leagues first, then whatever API-Football brings.
    this.leagues = new Map(Object.entries(LEAGUES).map(([code, l]) => [code, {
      code, ...l, tier: 'fd', type: 'League', category: 'Campionati', national: false, featured: 999,
    }]));

    // API-Football: every competition worldwide (merged into football-data records when they overlap).
    const fdTeams = new Map();
    const recent = Date.now() - 500 * 86_400_000;
    for (const m of all.values()) {
      if (m.ts < recent) continue;
      if (!fdTeams.has(m.league)) fdTeams.set(m.league, new Set());
      fdTeams.get(m.league).add(m.home).add(m.away);
    }
    const af = await loadApiFootball(new Map([...fdTeams].map(([k, v]) => [k, [...v]])));
    this.afStatus = af.status;
    for (const [code, meta] of af.leagues) {
      const prev = this.leagues.get(code);
      this.leagues.set(code, prev ? { ...prev, apiId: meta.apiId, logo: meta.logo, flagUrl: meta.flagUrl } : meta);
    }
    for (const m of af.matches) {
      const prev = all.get(m.id);
      all.set(m.id, prev ? mergeAf(prev, m) : m);
    }

    this.matches = [...all.values()].sort((a, b) => a.ts - b.ts);
    this.byId = new Map(this.matches.map((m) => [m.id, m]));
    this.playedAll = this.matches.filter((m) => m.status === 'FT');
    this.byLeague = new Map();
    for (const m of this.matches) {
      if (!this.byLeague.has(m.league)) this.byLeague.set(m.league, []);
      this.byLeague.get(m.league).push(m);
    }
    // Extra-league fixtures carry no season: inherit the league's latest one.
    for (const list of this.byLeague.values()) {
      let last = null;
      for (const m of list) { if (m.season) last = m.season; else m.season = last; }
    }
    // Domestic league of each team (for cup matches).
    this.teamLeague = new Map();
    for (const m of this.matches) {
      const meta = this.leagues.get(m.league);
      if (m.status !== 'FT' || !meta || meta.type === 'Cup' || meta.national) continue;
      this.teamLeague.set(m.home, m.league); this.teamLeague.set(m.away, m.league);
    }
    this.loadedAt = new Date();
    return this;
  }

  /** Played matches of a league strictly before a timestamp. */
  played(league, beforeTs = Infinity) {
    return (this.byLeague.get(league) || []).filter((m) => m.status === 'FT' && m.ts < beforeTs);
  }

  /** All played matches (all leagues) before a timestamp. */
  allPlayed(beforeTs = Infinity) {
    return this.matches.filter((m) => m.status === 'FT' && m.ts < beforeTs);
  }

  byDate(date) {
    return this.matches.filter((m) => m.date === date);
  }

  dateRange() {
    return { min: this.matches[0]?.date, max: this.matches.at(-1)?.date };
  }

  /** League table of the latest season (from played matches). */
  standings(league) {
    const list = this.byLeague.get(league) || [];
    const season = list.at(-1)?.season;
    const rows = new Map();
    const row = (t) => {
      if (!rows.has(t)) rows.set(t, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [] });
      return rows.get(t);
    };
    for (const m of list) {
      if (m.season !== season) continue;
      const H = row(m.home), A = row(m.away);
      if (m.status !== 'FT') continue;
      const [h, a] = m.ft;
      H.p++; A.p++; H.gf += h; H.ga += a; A.gf += a; A.ga += h;
      if (h > a) { H.w++; A.l++; H.pts += 3; H.form.push('V'); A.form.push('P'); }
      else if (h < a) { A.w++; H.l++; A.pts += 3; A.form.push('V'); H.form.push('P'); }
      else { H.d++; A.d++; H.pts++; A.pts++; H.form.push('N'); A.form.push('N'); }
    }
    return [...rows.values()]
      .map((r) => ({ ...r, gd: r.gf - r.ga, form: r.form.slice(-5) }))
      .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team));
  }

  teamForm(league, team, beforeTs, n = 6) {
    const pool = league ? this.played(league, beforeTs) : this.playedAll.filter((m) => m.ts < beforeTs);
    return pool.filter((m) => m.home === team || m.away === team).slice(-n).reverse();
  }

  h2h(home, away, beforeTs, n = 6) {
    return this.matches
      .filter((m) => m.status === 'FT' && m.ts < beforeTs && ((m.home === home && m.away === away) || (m.home === away && m.away === home)))
      .slice(-n).reverse();
  }
}
