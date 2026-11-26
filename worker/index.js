// Sito statico (dist/) + un solo endpoint dinamico: /api/live, risultati ed eventi delle partite in corso.
// API-Football viene chiamata al massimo una volta ogni 60 s per data center, qualunque sia il numero di visitatori
// (cache in memoria dell'isolate + Cache API di Cloudflare). Secret richiesto: APIFOOTBALL_KEY
//   npx wrangler secret put APIFOOTBALL_KEY
// Le partite appena finite spariscono da fixtures?live=all: il Worker ricorda quelle viste in corso e le chiede
// una volta con fixtures?ids= per avere il risultato finale, che resta nella risposta per 3 ore.
import { liveRow, FINISHED } from '../server/providers/apifootball/events.js';

const TTL = 60; // secondi
const RECENT_MS = 3 * 3_600_000;
const BASE = 'https://v3.football.api-sports.io';
const CACHE_KEY = 'https://live.sporty-predict.internal/v1';
const STATE_KEY = 'https://live.sporty-predict.internal/state-v1';

let mem = null; // { at, body }
let memState = null; // { live: {id: row}, recent: {id: row & {t}} }
let inflight = null;

async function af(env, query) {
  const r = await fetch(`${BASE}/${query}`, { headers: { 'x-apisports-key': env.APIFOOTBALL_KEY } });
  if (!r.ok) throw new Error(`API-Football ${r.status}`);
  const body = await r.json();
  const err = body.errors && (Array.isArray(body.errors) ? body.errors[0] : Object.values(body.errors)[0]);
  if (err) throw new Error(`API-Football: ${err}`);
  return body.response || [];
}

async function readState(cache) {
  if (memState) return memState;
  const hit = await cache.match(STATE_KEY);
  return hit ? hit.json() : { live: {}, recent: {} };
}

async function refresh(env, ctx) {
  const cache = caches.default;
  const state = await readState(cache);
  const now = Date.now();
  const rows = (await af(env, 'fixtures?live=all&timezone=Europe/Rome')).map(liveRow);
  const live = Object.fromEntries(rows.map((r) => [r.id, r]));
  // Matches that left the live list since the last refresh: ask for their final state (20 per call).
  const gone = Object.keys(state.live).filter((id) => !live[id] && !state.recent[id]);
  for (let i = 0; i < gone.length; i += 20) {
    try {
      for (const x of await af(env, `fixtures?ids=${gone.slice(i, i + 20).join('-')}&timezone=Europe/Rome`)) {
        const r = liveRow(x);
        if (FINISHED.has(r.st)) state.recent[r.id] = { ...r, t: now };
        else if (!live[r.id]) live[r.id] = r; // e.g. briefly missing from the live list
      }
    } catch { /* keep the last known live row next time */ }
  }
  for (const [id, r] of Object.entries(state.recent)) if (now - r.t > RECENT_MS || live[id]) delete state.recent[id];
  memState = { live, recent: state.recent };
  ctx.waitUntil(cache.put(STATE_KEY, new Response(JSON.stringify(memState), { headers: { 'Cache-Control': 'max-age=21600' } })));

  const body = JSON.stringify({ t: now, matches: [...rows, ...Object.values(state.recent).map(({ t, ...r }) => r)] });
  ctx.waitUntil(cache.put(CACHE_KEY, new Response(body, { headers: { 'Cache-Control': `max-age=${TTL}`, 'X-Fetched': String(now) } })));
  mem = { at: now, body };
  return body;
}

async function liveBody(env, ctx) {
  if (mem && Date.now() - mem.at < TTL * 1000) return mem.body;
  const hit = await caches.default.match(CACHE_KEY);
  if (hit) {
    const body = await hit.text();
    mem = { at: Number(hit.headers.get('X-Fetched')) || Date.now(), body };
    return body;
  }
  inflight ||= refresh(env, ctx).finally(() => { inflight = null; });
  try { return await inflight; } catch (e) {
    if (mem) return mem.body; // API down: serve the last good answer
    throw e;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/live') return env.ASSETS.fetch(request);
    if (!env.APIFOOTBALL_KEY) return Response.json({ error: 'APIFOOTBALL_KEY non impostata' }, { status: 503 });
    try {
      const body = await liveBody(env, ctx);
      return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
