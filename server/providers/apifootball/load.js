// Turns the files written by sync.js into normalized matches + league metadata for the Store.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AF_DIR } from './client.js';
import { AF_TO_FD, FEATURED, category, countryIt, isNationalCompetition } from './leagues.js';
import { snapshot } from './odds.js';
import { matchTeams } from './teams.js';

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const STATUS_IT = { PST: 'Rinviata', CANC: 'Cancellata', ABD: 'Sospesa', AWD: 'A tavolino', WO: 'Walkover', TBD: 'Da definire' };

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function list(dir) {
  try { return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
}
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Wall-clock "2026-11-22T15:00:00+01:00" -> same pseudo-UTC convention used for football-data rows. */
function kickoff(iso) {
  const date = iso.slice(0, 10), time = iso.slice(11, 16);
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return { date, time, ts: Date.UTC(y, m - 1, d, hh, mm) };
}

/**
 * @param fdTeamsByCode Map(code -> string[]) team names known in football-data leagues
 * @returns { fixtures: raw[], odds: Map(fixtureId -> {first,last}), catalogue: Map(id -> league) , status }
 */
export async function loadApiFootball(fdTeamsByCode) {
  const catalogueRaw = await readJson(path.join(AF_DIR, 'leagues.json'), []);
  const catalogue = new Map(catalogueRaw.map((x) => [x.league.id, { ...x.league, country: x.country?.name || '', flag: x.country?.flag || null }]));
  const status = await readJson(path.join(AF_DIR, 'status.json'), null);

  const raw = new Map(); // fixture id -> raw fixture (latest wins)
  for (const f of await list(path.join(AF_DIR, 'history'))) for (const x of await readJson(path.join(AF_DIR, 'history', f), [])) raw.set(x.fixture.id, x);
  for (const f of await list(path.join(AF_DIR, 'fixtures'))) for (const x of await readJson(path.join(AF_DIR, 'fixtures', f), [])) raw.set(x.fixture.id, x);

  const odds = new Map();
  for (const f of await list(path.join(AF_DIR, 'odds'))) {
    for (const [id, v] of Object.entries(await readJson(path.join(AF_DIR, 'odds', f), {}))) odds.set(Number(id), v);
  }
  if (!raw.size) return { matches: [], leagues: new Map(), status };

  // --- map API leagues onto football-data codes (validated by country) and team names
  const fdCode = (L) => {
    const m = AF_TO_FD[L.id];
    return m && m[1] === L.country ? m[0] : null;
  };
  const apiTeamsByCode = new Map();
  for (const x of raw.values()) {
    const code = fdCode(x.league);
    if (!code) continue;
    if (!apiTeamsByCode.has(code)) apiTeamsByCode.set(code, new Set());
    apiTeamsByCode.get(code).add(x.teams.home.name).add(x.teams.away.name);
  }
  const nameMap = new Map(); // `${code}|${apiName}` -> fd name
  const canonical = new Map(); // api team id -> name used by the model
  for (const [code, set] of apiTeamsByCode) {
    const m = matchTeams([...set], fdTeamsByCode.get(code) || []);
    for (const [a, f] of m) nameMap.set(`${code}|${a}`, f);
  }
  for (const x of raw.values()) {
    const code = fdCode(x.league);
    if (!code) continue;
    for (const t of [x.teams.home, x.teams.away]) {
      const n = nameMap.get(`${code}|${t.name}`);
      if (n) canonical.set(t.id, n);
    }
  }

  // --- league metadata
  const leagues = new Map();
  const featuredRank = (id) => { const i = FEATURED.indexOf(id); return i < 0 ? 999 : i; };
  const metaFor = (L) => {
    const fd = fdCode(L);
    const code = fd || `AF${L.id}`;
    if (!leagues.has(code)) {
      const cat = catalogue.get(L.id);
      const type = cat?.type || 'League';
      leagues.set(code, {
        code, apiId: L.id, name: L.name, country: countryIt(L.country), countryEn: L.country,
        logo: L.logo, flagUrl: L.flag || cat?.flag || null, type,
        category: category(L, type), national: isNationalCompetition(L), featured: featuredRank(L.id), tier: fd ? 'fd' : 'af',
      });
    }
    return leagues.get(code);
  };

  // --- matches
  const matches = [];
  for (const x of raw.values()) {
    const L = x.league;
    const meta = metaFor(L);
    const ko = kickoff(x.fixture.date);
    const short = x.fixture.status?.short || 'NS';
    const nameOf = (t) => (meta.tier === 'fd' ? nameMap.get(`${meta.code}|${t.name}`) : canonical.get(t.id)) || t.name;
    const home = nameOf(x.teams.home), away = nameOf(x.teams.away);
    const ftScore = x.score?.fulltime, htScore = x.score?.halftime;
    const finished = FINISHED.has(short) && ftScore?.home != null;
    const o = odds.get(x.fixture.id);
    matches.push({
      id: meta.tier === 'fd' ? `${meta.code}-${ko.date.replace(/-/g, '')}-${slug(home)}-${slug(away)}` : `af${x.fixture.id}`,
      afId: x.fixture.id, league: meta.code, date: ko.date, time: ko.time, ts: ko.ts,
      home, away, homeName: x.teams.home.name, awayName: x.teams.away.name,
      homeLogo: x.teams.home.logo, awayLogo: x.teams.away.logo, homeTeamId: x.teams.home.id, awayTeamId: x.teams.away.id,
      season: meta.tier === 'fd' ? null : String(L.season), round: L.round || null, venue: x.fixture.venue?.name || null, referee: x.fixture.referee || null,
      status: finished ? 'FT' : LIVE.has(short) ? 'LIVE' : STATUS_IT[short] ? 'OFF' : 'NS',
      statusText: finished ? (short === 'FT' ? null : short) : STATUS_IT[short] || null,
      ft: finished ? [ftScore.home, ftScore.away] : null,
      ht: finished && htScore?.home != null ? [htScore.home, htScore.away] : null,
      afterExtra: finished && short !== 'FT' ? [x.goals.home, x.goals.away] : null,
      xg: null, stats: null,
      odds: o?.last?.o || null,
      oddsOpen: o?.first ? { t: o.first.t, ...snapshot(o.first.o) } : null,
      oddsUpdated: o?.last?.t || null,
      source: 'af',
    });
  }
  return { matches, leagues, status };
}
