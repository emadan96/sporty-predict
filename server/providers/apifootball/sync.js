// Pulls fixtures, pre-match odds and league histories from API-Football into data/af/.
// Files written (read by the Store):
//   leagues.json                     catalogue (type League/Cup, country, seasons)
//   fixtures/<YYYY-MM-DD>.json       all fixtures of a day (every competition)
//   odds/<YYYY-MM-DD>.json           { fixtureId: { first:{t,o}, last:{t,o} } } parsed odds snapshots
//   history/<leagueId>_<season>.json all fixtures of a league season (for team ratings)
//   details/<YYYY-MM-DD>.json        { fixtureId: { t, st, ev, stats } } match events + statistics (events.js)
//   plan.json                        what the subscription allows (learned from /status and plan errors)
//   status.json                      last run summary + quota
//
// The schedule adapts to the subscription: on the Free plan (100 calls/day, dates yesterday..tomorrow,
// no current-season history) it only fetches what the plan can serve, so no call is wasted on refusals.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiFootball, AF_DIR, QuotaError, PlanError } from './client.js';
import { parseOdds } from './odds.js';
import { FINISHED, LIVE, liveRow, compactStats } from './events.js';
import { env } from '../../env.js';
import { AF_TO_FD, FEATURED, isNationalCompetition } from './leagues.js';

const BIG_COUNTRIES = new Set(['England', 'Spain', 'Germany', 'France', 'Netherlands', 'Portugal', 'Belgium', 'Turkey', 'Scotland', 'Greece',
  'Austria', 'Switzerland', 'Denmark', 'Sweden', 'Norway', 'Poland', 'Czech-Republic', 'Croatia', 'Brazil', 'Argentina', 'USA', 'Mexico', 'Japan']);
const MINOR_RE = /u1[5-9]|u2[0-3]|women|femen|youth|reserve|primavera|junior|amateur/i;

/** Lower = more important. Used to spend a small quota on the matches people care about first. */
function leaguePriority(L) {
  if (MINOR_RE.test(L.name)) return 10_000;
  const f = FEATURED.indexOf(L.id);
  if (f >= 0) return f;
  if (L.country === 'Italy') return 50;
  if (AF_TO_FD[L.id]) return 100;
  if (BIG_COUNTRIES.has(L.country)) return 200;
  if (isNationalCompetition(L)) return 300;
  return 1000;
}

const HOUR = 3_600_000;
// Free plan budget split: per-fixture odds stop while this many calls are still left, so the
// runs later in the day can refresh fixtures and results (one call each).
const FIXTURE_RESERVE = Number(process.env.APIFOOTBALL_FIXTURE_RESERVE || 20);
// Hard stop for the per-fixture odds loop (protects CI minutes if the API gets slow).
const MAX_ODDS_MINUTES = Number(process.env.APIFOOTBALL_MAX_MINUTES || 20);

async function ageHours(file) {
  try { return (Date.now() - (await fs.stat(file)).mtimeMs) / HOUR; } catch { return Infinity; }
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

const DETAILS_BATCH = 20; // provider maximum for fixtures?ids=
const DETAILS_MAX_CALLS = Number(process.env.APIFOOTBALL_DETAILS_MAX_CALLS || 150); // per run (first run catches up on past days)

/** Leagues whose current season has events coverage (unknown leagues count as covered). */
async function eventsCoverage() {
  const cat = await readJson(path.join(AF_DIR, 'leagues.json'), []);
  const no = new Set();
  for (const x of cat) {
    const cur = x.seasons?.find((s) => s.current) || x.seasons?.at(-1);
    if (cur?.coverage?.fixtures && !cur.coverage.fixtures.events) no.add(x.league.id);
  }
  return (id) => !no.has(id);
}

/**
 * details/<YYYY-MM-DD>.json  { fixtureId: { t, st, ev, stats } }
 * A finished match is fetched once (and once more if it was stored while still live); live matches every run.
 */
export async function syncDetails(api, days, summary, log) {
  const covered = await eventsCoverage();
  const want = []; // { f, d }
  const stores = new Map();
  for (const d of days) {
    const file = path.join(AF_DIR, 'details', `${d}.json`);
    const store = await readJson(file, {});
    stores.set(d, { file, store, dirty: false });
    for (const f of await readJson(path.join(AF_DIR, 'fixtures', `${d}.json`), [])) {
      const st = f.fixture.status?.short;
      if (!covered(f.league.id)) continue;
      const have = store[f.fixture.id];
      if (LIVE.has(st) || (FINISHED.has(st) && !(have && FINISHED.has(have.st)))) want.push({ f, d });
    }
  }
  // Live first, then the most important competitions.
  want.sort((a, b) => Number(FINISHED.has(a.f.fixture.status.short)) - Number(FINISHED.has(b.f.fixture.status.short))
    || leaguePriority(a.f.league) - leaguePriority(b.f.league));
  const dayOf = new Map(want.map(({ f, d }) => [f.fixture.id, d]));
  let calls = 0;
  for (let i = 0; i < want.length; i += DETAILS_BATCH) {
    if (calls >= DETAILS_MAX_CALLS) { summary.skipped.push(`eventi: ${want.length - i} partite rimandate alla prossima run`); break; }
    if (api.budgetLeft() <= 100) { summary.skipped.push(`eventi: ${want.length - i} partite (quota bassa)`); break; }
    const ids = want.slice(i, i + DETAILS_BATCH).map(({ f }) => f.fixture.id);
    let body;
    try { body = await api.get('fixtures', { ids: ids.join('-'), timezone: 'Europe/Rome' }, { cache: false }); } catch (e) {
      if (e instanceof QuotaError) { summary.skipped.push('eventi (quota)'); break; }
      summary.errors.push(`eventi: ${e.message}`); break;
    }
    calls++;
    const t = Date.now();
    for (const x of body.response || []) {
      const s = stores.get(dayOf.get(x.fixture.id));
      if (!s) continue;
      const row = liveRow(x);
      s.store[x.fixture.id] = { t, st: row.st, ev: row.ev, stats: compactStats(x.statistics, x.teams?.home?.id) };
      s.dirty = true;
      summary.details++;
    }
  }
  for (const s of stores.values()) if (s.dirty) await writeJson(s.file, s.store);
  if (want.length) log(`[api-football] eventi: ${summary.details} partite aggiornate (${want.length} da aggiornare) con ${calls} chiamate`);
}

const romeToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

/** Learn limits from messages like "try from 2026-11-18 to 2026-11-20" or "try from 2022 to 2024". */
function learnFromHint(plan, hint, today) {
  const pg = /maximum value of (\d+) for the Page/i.exec(hint);
  if (pg) { plan.maxPage = Number(pg[1]); return true; }
  const d = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(hint);
  if (d) { plan.dayFrom = dayDiff(d[1], today); plan.dayTo = dayDiff(d[2], today); return true; }
  const s = /from (\d{4}) to (\d{4})/.exec(hint);
  if (s) { plan.seasonMin = Number(s[1]); plan.seasonMax = Number(s[2]); return true; }
  return false;
}

let running = null;

export function syncApiFootball(opts = {}) {
  if (!running) running = run(opts).finally(() => { running = null; });
  return running;
}

async function run({ log = console.log, force = false } = {}) {
  const api = new ApiFootball();
  if (!api.enabled) return { enabled: false };
  const today = romeToday();
  const planFile = path.join(AF_DIR, 'plan.json');
  const plan = await readJson(planFile, {});

  // Subscription status (free call). Free plan defaults until we learn the exact limits from errors.
  const st = await api.status().catch(() => null);
  if (st) {
    // New subscription (e.g. Free -> Pro): forget the limits learned from the old plan's refusals.
    if (plan.name && plan.name !== st.plan) {
      log(`[api-football] piano cambiato: ${plan.name} → ${st.plan}, limiti precedenti azzerati`);
      for (const k of ['dayFrom', 'dayTo', 'seasonMin', 'seasonMax', 'maxPage']) delete plan[k];
    }
    Object.assign(plan, { name: st.plan, limit: st.limit, end: st.end, checkedAt: new Date().toISOString() });
  }
  const free = /free/i.test(plan.name || '') || (plan.limit && plan.limit <= 100);
  if (free) {
    plan.dayFrom ??= -1; plan.dayTo ??= 1; plan.seasonMax ??= 2024;
  }
  await writeJson(planFile, plan);

  const summary = {
    enabled: true, plan: plan.name || null, startedAt: new Date().toISOString(),
    fixturesDays: 0, details: 0, oddsDays: 0, oddsFixtures: 0, histories: 0, skipped: [], errors: [],
  };
  const due = async (file, ttlH) => force || (await ageHours(file)) >= ttlH;
  const guard = async (label, fn) => {
    try { return await fn(); } catch (e) {
      if (e instanceof QuotaError) { summary.skipped.push(label); return 'quota'; }
      if (e instanceof PlanError) {
        if (learnFromHint(plan, e.hint, today)) await writeJson(planFile, plan);
        summary.skipped.push(`${label} (non incluso nel piano)`);
        return 'plan';
      }
      summary.errors.push(`${label}: ${e.message}`); return null;
    }
  };
  const dayAllowed = (d) => {
    const off = dayDiff(d, today);
    return (plan.dayFrom == null || off >= plan.dayFrom) && (plan.dayTo == null || off <= plan.dayTo);
  };
  const seasonAllowed = (s) => (plan.seasonMin == null || s >= plan.seasonMin) && (plan.seasonMax == null || s <= plan.seasonMax);

  // 1) league catalogue (weekly)
  const leaguesFile = path.join(AF_DIR, 'leagues.json');
  if (await due(leaguesFile, 24 * 7)) {
    await guard('leagues', async () => writeJson(leaguesFile, (await api.get('leagues', {}, { cache: false })).response));
  }

  // 2) fixtures of every day in the window
  const days = [];
  for (let i = -env.daysBack; i <= env.daysAhead; i++) days.push(addDays(today, i));
  for (const d of days) {
    if (!dayAllowed(d)) continue;
    const file = path.join(AF_DIR, 'fixtures', `${d}.json`);
    const ttl = d < today ? (free ? 24 : 12) : d === today ? (free ? 1.5 : 1) : 6; // today: every run (2h) refreshes results
    if (!(await due(file, ttl))) continue;
    const r = await guard(`fixtures ${d}`, async () => {
      const body = await api.get('fixtures', { date: d, timezone: 'Europe/Rome' }, { cache: false });
      await writeJson(file, body.response);
      summary.fixturesDays++;
    });
    if (r === 'quota') break;
  }

  // 2b) events + statistics (fixtures?ids=, 20 per call): finished matches once, live ones at every run.
  if (!free) await syncDetails(api, days.filter((d) => d <= today && dayAllowed(d)), summary, log);

  // 3) odds snapshots. Today/tomorrow first (provider refreshes every 3h; on Free every 12h to fit the quota).
  const tried = new Set(); // fixtures already requested in this run (some have no odds yet: never ask twice)
  // maxPrio: only fixtures of competitions at least this important (lower = more important).
  const oddsDay = async (d, ttl, maxPrio = 10_000) => {
    if (!dayAllowed(d)) return null;
    const file = path.join(AF_DIR, 'odds', `${d}.json`);
    const marker = path.join(AF_DIR, 'odds', `.${d}.fetched`);
    if (!(await due(marker, ttl))) return null;
    return guard(`odds ${d}`, async () => {
      const store = await readJson(file, {});
      const t = Date.now();
      const save = (fixtureId, bookmakers) => {
        const o = parseOdds(bookmakers);
        if (!o) return false;
        if (!store[fixtureId]) store[fixtureId] = { first: { t, o } };
        store[fixtureId].last = { t, o };
        return true;
      };
      // Date-wide pages (capped on Free). Cached like the day itself so retries only spend calls on missing fixtures.
      const pagesMarker = path.join(AF_DIR, 'odds', `.${d}.pages`);
      let items;
      if (await due(pagesMarker, ttl)) {
        items = await api.getAll('odds', { date: d, timezone: 'Europe/Rome' }, { cache: false }, { maxPage: plan.maxPage ?? Infinity });
        for (const it of items) if (save(it.fixture.id, it.bookmakers)) summary.oddsFixtures++;
        if (items.error instanceof PlanError && learnFromHint(plan, items.error.hint, today)) await writeJson(planFile, plan);
        await writeJson(pagesMarker, { t, ids: items.map((it) => it.fixture.id), partial: Boolean(items.partial), reason: items.reason || null });
      } else {
        const pm = await readJson(pagesMarker, {});
        items = (pm.ids || []).map((id) => ({ fixture: { id } }));
        items.partial = pm.partial; items.reason = pm.reason;
      }

      let complete = !items.partial;
      if (items.partial && items.reason === 'page') {
        // Plan caps pagination: fetch the remaining important fixtures one by one, within the quota.
        const seen = new Set(items.map((it) => it.fixture.id));
        const fixtures = (await readJson(path.join(AF_DIR, 'fixtures', `${d}.json`), []))
          .filter((f) => !seen.has(f.fixture.id) && ['NS', 'TBD'].includes(f.fixture.status?.short) && leaguePriority(f.league) < maxPrio && !tried.has(f.fixture.id))
          .filter((f) => !store[f.fixture.id] || t - store[f.fixture.id].last.t > ttl * HOUR)
          .sort((a, b) => leaguePriority(a.league) - leaguePriority(b.league) || a.fixture.timestamp - b.fixture.timestamp);
        let fetched = 0;
        if (fixtures.length) log(`[api-football] quote ${d}: ${items.length} dalle pagine, ora ${fixtures.length} partite una per una (priorità: coppe europee, nazionali, Italia, grandi campionati)`);
        for (const f of fixtures) {
          if (api.budgetLeft() <= (free ? FIXTURE_RESERVE : 50)) { summary.skipped.push(`odds ${d}: ${fixtures.length - fetched} partite senza quote (quota esaurita)`); break; }
          if (Date.now() - t > MAX_ODDS_MINUTES * 60_000) { summary.skipped.push(`odds ${d}: interrotto dopo ${MAX_ODDS_MINUTES} minuti`); break; }
          tried.add(f.fixture.id);
          const body = await api.get('odds', { fixture: f.fixture.id }, { cache: false }).catch((e) => { if (e instanceof QuotaError) return null; throw e; });
          if (!body) break;
          fetched++;
          for (const it of body.response || []) if (save(it.fixture.id, it.bookmakers)) summary.oddsFixtures++;
          if (fetched % 10 === 0) { await writeJson(file, store); log(`[api-football] quote ${d}: ${fetched}/${fixtures.length} · quota rimasta ${api.quota.dayRemaining ?? '?'} · ${Math.round((Date.now() - t) / 1000)} s`); }
        }
        complete = fetched === fixtures.length && maxPrio >= 10_000; // a partial pass never closes the day
      }
      await writeJson(file, store);
      if (!complete) return items.reason === 'quota' ? 'quota' : 'partial';
      await writeJson(marker, { t });
      summary.oddsDays++;
      return 'ok';
    });
  };
  // Priority across today AND tomorrow: important competitions of both days first (European cups,
  // national teams, Italy, main leagues), then everything else.
  const oddsTtl = free ? 12 : 3;
  for (const maxPrio of [60, 300, 10_000]) {
    let stop = false;
    for (const d of [today, addDays(today, 1)]) if ((await oddsDay(d, oddsTtl, maxPrio)) === 'quota') { stop = true; break; }
    if (stop) break;
  }

  // 4) histories of every league with fixtures in the window (not covered by football-data)
  const leagueSeasons = new Map(); // leagueId -> { season, count }
  for (const d of days) {
    for (const f of await readJson(path.join(AF_DIR, 'fixtures', `${d}.json`), [])) {
      const L = f.league;
      if (AF_TO_FD[L.id]) continue;
      const cur = leagueSeasons.get(L.id) || { season: L.season, count: 0, national: isNationalCompetition(L) };
      cur.count++;
      leagueSeasons.set(L.id, cur);
    }
  }
  const ordered = [...leagueSeasons.entries()].sort((a, b) => b[1].count - a[1].count);
  let historyBlocked = 0;
  for (const [id, { season }] of ordered) {
    if (api.budgetLeft() < 20) { summary.skipped.push(`storici (quota bassa: ${ordered.length} competizioni in attesa)`); break; }
    for (const [s, ttl] of [[season, 24], [season - 1, Infinity]]) {
      if (!seasonAllowed(s)) { historyBlocked++; continue; }
      const file = path.join(AF_DIR, 'history', `${id}_${s}.json`);
      if (!(await due(file, ttl))) continue;
      const r = await guard(`history ${id}/${s}`, async () => {
        const body = await api.get('fixtures', { league: id, season: s, timezone: 'Europe/Rome' }, { cache: false });
        await writeJson(file, body.response);
        summary.histories++;
      });
      if (r === 'quota') break;
    }
  }
  if (historyBlocked) summary.skipped.push(`${historyBlocked} storici stagionali non inclusi nel piano`);

  // 5) odds for the rest of the week (less often), and recent past days to capture closing prices
  for (let i = 2; i <= env.daysAhead; i++) if ((await oddsDay(addDays(today, i), 12)) === 'quota') break;
  for (let i = 1; i <= Math.min(env.daysBack, 6); i++) if ((await oddsDay(addDays(today, -i), 48)) === 'quota') break;

  summary.finishedAt = new Date().toISOString();
  summary.quota = api.quota;
  summary.planLimits = { dayFrom: plan.dayFrom ?? null, dayTo: plan.dayTo ?? null, seasonMin: plan.seasonMin ?? null, seasonMax: plan.seasonMax ?? null };
  await writeJson(path.join(AF_DIR, 'status.json'), summary);
  log(`[api-football] piano ${plan.name || '?'} · giorni fixture ${summary.fixturesDays}, eventi ${summary.details}, giorni quote ${summary.oddsDays} (${summary.oddsFixtures} partite), storici ${summary.histories}, chiamate ${api.quota.calls}, rimanenti oggi ${api.quota.dayRemaining ?? '?'}`);
  for (const e of summary.errors.slice(0, 5)) log(`  ! ${e}`);
  if (summary.skipped.length) log(`  saltati: ${summary.skipped.slice(0, 6).join(', ')}`);
  return summary;
}
