import './env.js';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PORT, PUBLIC_DIR } from './config.js';
import { env } from './env.js';
import { Store } from './store.js';
import { Predictor } from './model/predict.js';
import { createApi } from './api.js';
import { ingest } from './ingest.js';
import { syncApiFootball } from './providers/apifootball/sync.js';

const store = new Store();
const predictor = new Predictor(store);
let refreshing = null;
let afSyncing = false;

async function reload() {
  await store.load();
  predictor.reset();
  warmUp();
  console.log(`[store] ${store.matches.length} partite, ${store.leagues.size} competizioni (${store.dateRange().min} → ${store.dateRange().max})`);
}

/** Pre-compute predictions for the days people open most (yesterday..+2), without blocking requests. */
let warmToken = 0;
function warmUp() {
  const token = ++warmToken;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
  const day = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const queue = [0, 1, -1, 2].flatMap((n) => store.byDate(day(n)));
  const t0 = Date.now();
  const step = () => {
    if (token !== warmToken) return; // a newer reload started
    const until = Date.now() + 25; // small slices keep the server responsive
    while (queue.length && Date.now() < until) {
      try { predictor.summary(queue.shift()); } catch { /* ignore, computed again on demand */ }
    }
    if (queue.length) setImmediate(step);
    else console.log(`[warm-up] pronostici pronti in ${Date.now() - t0} ms`);
  };
  setImmediate(step);
}

async function syncAf(force = false) {
  if (!env.apiKey || afSyncing) return null;
  afSyncing = true;
  try {
    const s = await syncApiFootball({ force });
    await reload();
    return s;
  } finally { afSyncing = false; }
}

async function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const summary = await ingest({ force });
    await reload();
    return summary;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const api = createApi(store, predictor);
const routes = {
  'GET /api/leagues': () => api.leagues(),

  'GET /api/status': () => ({
    loadedAt: store.loadedAt, matches: store.matches.length, leagues: store.leagues.size,
    apiFootball: { enabled: Boolean(env.apiKey), syncing: afSyncing, last: store.afStatus },
  }),

  'GET /api/dates': () => api.dates(),

  'GET /api/matches': (q) => api.matches(q.get('date') || new Date().toISOString().slice(0, 10), q.get('league')),

  'GET /api/match': (q) => api.match(q.get('id')) || { status: 404, body: { error: 'Partita non trovata' } },

  'GET /api/search': (q) => api.search(q.get('q')),

  'POST /api/refresh': async () => {
    const fd = await refresh();
    syncAf().catch((e) => console.error('[api-football]', e)); // runs in background (rate limits)
    return { footballData: fd, apiFootball: env.apiKey ? 'sincronizzazione avviata' : 'APIFOOTBALL_KEY non configurata' };
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

/** Send a body, gzipped when the client accepts it and it is worth it. */
function send(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' }).end(gz);
  } else {
    res.writeHead(status, { ...headers, 'Content-Length': buf.length }).end(buf);
  }
}

const staticCache = new Map(); // file -> { mtimeMs, etag, data }
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  let st;
  try { st = await fs.stat(file); if (!st.isFile()) throw new Error(); } catch {
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    st = await fs.stat(file);
  }
  let c = staticCache.get(file);
  const isIndex = file.endsWith('index.html');
  // index.html embeds asset versions, so it must be rebuilt when app.js / styles.css change too.
  const assetVersions = isIndex ? await Promise.all(['app.js', 'styles.css'].map((f) => fs.stat(path.join(PUBLIC_DIR, f)).then((s) => Math.floor(s.mtimeMs).toString(36)))) : [];
  const stamp = `${st.mtimeMs}|${assetVersions.join(',')}`;
  if (!c || c.stamp !== stamp) {
    let data = await fs.readFile(file);
    if (isIndex) {
      // Cache-busting: browsers keep ES modules in memory, a versioned URL forces the new code after an update.
      data = Buffer.from(data.toString('utf8')
        .replace('src="/app.js"', `src="/app.js?v=${assetVersions[0]}"`)
        .replace('href="/styles.css"', `href="/styles.css?v=${assetVersions[1]}"`));
    }
    c = { stamp, etag: `"${data.length.toString(36)}-${Buffer.from(stamp).toString('base64url').slice(-12)}"`, data };
    staticCache.set(file, c);
  }
  // Revalidate every time (files change during development) but answer 304 when unchanged.
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ETag: c.etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers).end(); return; }
  send(req, res, 200, headers, c.data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'); return; }
    await serveStatic(req, res, url.pathname);
    return;
  }
  try {
    const out = await handler(url.searchParams);
    const status = out && out.status && out.body ? out.status : 200;
    const body = out && out.status && out.body ? out.body : out;
    send(req, res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(body));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nLa porta ${PORT} è già occupata: probabilmente Sporty Predict è già avviato in un'altra finestra.`);
    console.error(`Apri http://localhost:${PORT}, oppure chiudi l'altro processo, oppure avvia su un'altra porta (es. PORT=3001 nel file .env).\n`);
    process.exit(1);
  }
  throw e;
});

await refresh();
server.listen(PORT, () => console.log(`Sporty Predict → http://localhost:${PORT}`));
if (env.apiKey) {
  console.log('[api-football] chiave trovata: sincronizzazione in background…');
  syncAf().catch((e) => console.error('[api-football]', e));
} else {
  console.log('[api-football] APIFOOTBALL_KEY non impostata: uso solo football-data.co.uk (vedi .env.example)');
}
setInterval(() => {
  refresh().catch(console.error);
  syncAf().catch(console.error);
}, 60 * 60 * 1000); // hourly: each source only re-downloads what is stale
