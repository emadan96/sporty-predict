// Static build: pre-computes every page the app needs into dist/ so it can be hosted for free
// (Cloudflare Pages, GitHub Pages…). Usage: node server/build-static.js [--sync]
//   --sync  first refresh football-data.co.uk and API-Football (uses the key from env / .env)
import './env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PUBLIC_DIR } from './config.js';
import { env } from './env.js';
import { Store } from './store.js';
import { Predictor } from './model/predict.js';
import { createApi } from './api.js';
import { ingest } from './ingest.js';
import { syncApiFootball } from './providers/apifootball/sync.js';

const OUT = path.resolve(process.env.STATIC_OUT || path.join(ROOT, 'dist'));
const DAYS_BACK = Number(process.env.STATIC_DAYS_BACK || 7);
const DAYS_AHEAD = Number(process.env.STATIC_DAYS_AHEAD || 10);

/** Same rule as the client: match ids become safe file names. */
export const fileId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

const t0 = Date.now();
if (process.argv.includes('--sync')) {
  await ingest();
  if (env.apiKey) {
    const s = await syncApiFootball();
    console.log('[api-football]', JSON.stringify(s?.calls ?? s ?? {}).slice(0, 300));
  } else console.log('[api-football] APIFOOTBALL_KEY non impostata: solo football-data.co.uk');
}

const store = new Store();
await store.load();
const api = createApi(store, new Predictor(store));

await fs.rm(OUT, { recursive: true, force: true });
for (const d of ['api/matches', 'api/match']) await fs.mkdir(path.join(OUT, d), { recursive: true });
let files = 0, bytes = 0;
const write = async (rel, data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  await fs.writeFile(path.join(OUT, rel), buf);
  files++; bytes += buf.length;
};

// Days published: a window around today (Rome time).
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const counts = {};
const search = [];
for (let n = -DAYS_BACK; n <= DAYS_AHEAD; n++) {
  const date = addDays(today, n);
  const ms = store.byDate(date);
  if (!ms.length) continue;
  counts[date] = ms.length;
  await write(`api/matches/${date}.json`, api.matches(date));
  for (const m of ms) {
    try { await write(`api/match/${fileId(m.id)}.json`, api.match(m.id)); } catch (e) { console.error('match', m.id, e.message); continue; }
    const r = api.searchRow(m); // only what the search box shows
    search.push({ id: r.id, date: r.date, time: r.time, home: r.home, away: r.away, ft: r.ft || null, leagueName: r.leagueName });
  }
}
const days = Object.keys(counts).sort();
const builtAt = new Date().toISOString();

await write('api/dates.json', { min: days[0] || today, max: days.at(-1) || today, counts, loadedAt: store.loadedAt });
await write('api/leagues.json', api.leagues());
await write('api/search.json', search);
await write('api/status.json', {
  static: true, builtAt, loadedAt: store.loadedAt, matches: store.matches.length, leagues: store.leagues.size,
  apiFootball: { enabled: Boolean(env.apiKey), syncing: false, last: store.afStatus },
});

// Front-end: versioned asset URLs (content hash) and the static flag for app.js.
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
const appJs = await fs.readFile(path.join(PUBLIC_DIR, 'app.js'));
const css = await fs.readFile(path.join(PUBLIC_DIR, 'styles.css'));
await write('app.js', appJs);
await write('styles.css', css);
const html = (await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
  .replace('<html lang="it">', '<html lang="it" data-static="1">')
  .replace('src="/app.js"', `src="app.js?v=${hash(appJs)}"`)
  .replace('href="/styles.css"', `href="styles.css?v=${hash(css)}"`);
await write('index.html', html);
// Cloudflare Pages: data must always be revalidated, versioned assets can be cached.
await write('_headers', [
  '/api/*', '  Cache-Control: no-cache', '',
  '/app.js', '  Cache-Control: public, max-age=31536000, immutable', '',
  '/styles.css', '  Cache-Control: public, max-age=31536000, immutable', '',
].join('\n'));
await write('.nojekyll', ''); // GitHub Pages: serve files as they are

console.log(`[build] ${days.length} giorni (${days[0]} → ${days.at(-1)}), ${search.length} partite, ${files} file, ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${path.relative(ROOT, OUT)}`);
