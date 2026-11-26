// Sito statico (dist/) + un solo endpoint dinamico: /api/live, risultati ed eventi delle partite in corso.
// Tutte le richieste passano da UN Durable Object (LiveHub): una sola copia dei dati per tutto il mondo, quindi
// risposte sempre coerenti e al massimo una chiamata ad API-Football al minuto, qualunque sia il numero di visitatori.
// Secret richiesto: APIFOOTBALL_KEY (npx wrangler secret put APIFOOTBALL_KEY).
//
// Ogni refresh (solo se qualcuno chiede, al massimo ogni 60 s):
//   fixtures?live=all                partite in corso con eventi
//   fixtures?ids=…                   partite appena uscite dalla lista live: risultato finale con eventi (tenuto 3 h)
//   fixtures?date=oggi (ogni 5 min)  risultati finali di oggi, anche di partite finite quando nessuno guardava
// Se API-Football risponde con un errore (es. 429) si continua a servire l'ultimo dato buono e si riprova dopo 20 s.
import { DurableObject } from 'cloudflare:workers';
import { liveRow, FINISHED } from '../server/providers/apifootball/events.js';

const TTL = 60_000;
const RETRY_AFTER_ERROR = 20_000;
const FINALS_EVERY = 5 * 60_000;
const RECENT_MS = 3 * 3_600_000;
const BASE = 'https://v3.football.api-sports.io';
const romeDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());

export class LiveHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.body = null; // last good JSON answer
    this.at = 0; // when it was fetched
    this.failAt = 0;
    this.inflight = null;
    this.state = null; // { live:{id:row}, recent:{id:row+t}, finals:{id:row}, finalsAt, finalsDay }
  }

  async af(query) {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`${BASE}/${query}`, { headers: { 'x-apisports-key': this.env.APIFOOTBALL_KEY } });
      if (r.status === 429 && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
      if (!r.ok) throw new Error(`API-Football ${r.status}`);
      const body = await r.json();
      const err = body.errors && (Array.isArray(body.errors) ? body.errors[0] : Object.values(body.errors)[0]);
      if (err) throw new Error(`API-Football: ${typeof err === 'string' ? err : JSON.stringify(err)}`);
      return body.response || [];
    }
  }

  async refresh() {
    const s = this.state ||= (await this.ctx.storage.get('state')) || { live: {}, recent: {}, finals: {}, finalsAt: 0, finalsDay: null };
    const now = Date.now();
    const rows = (await this.af('fixtures?live=all&timezone=Europe/Rome')).map(liveRow);
    const live = Object.fromEntries(rows.map((r) => [r.id, r]));

    // Just left the live list: final score and events (20 per call).
    const gone = Object.keys(s.live).filter((id) => !live[id] && !s.recent[id]);
    for (let i = 0; i < gone.length; i += 20) {
      try {
        for (const x of await this.af(`fixtures?ids=${gone.slice(i, i + 20).join('-')}&timezone=Europe/Rome`)) {
          const r = liveRow(x);
          if (FINISHED.has(r.st)) s.recent[r.id] = { ...r, t: now };
          else if (!live[r.id]) live[r.id] = r; // briefly missing from the live list
        }
      } catch { /* retried at the next refresh: they are still in s.live */ for (const id of gone.slice(i)) if (!live[id]) live[id] = s.live[id]; break; }
    }
    for (const [id, r] of Object.entries(s.recent)) if (now - r.t > RECENT_MS || live[id]) delete s.recent[id];

    // Today's finished matches (also those that ended while nobody was looking), without events.
    const day = romeDay();
    if (s.finalsDay !== day) { s.finals = {}; s.finalsDay = day; s.finalsAt = 0; }
    if (now - s.finalsAt > FINALS_EVERY) {
      try {
        const fin = {};
        for (const x of await this.af(`fixtures?date=${day}&timezone=Europe/Rome`)) {
          if (!FINISHED.has(x.fixture?.status?.short)) continue;
          const { ev, ...r } = liveRow(x);
          fin[r.id] = r;
        }
        s.finals = fin; s.finalsAt = now;
      } catch { /* keep the previous list */ }
    }

    s.live = live;
    await this.ctx.storage.put('state', s);
    const extra = [...Object.values(s.recent).map(({ t, ...r }) => r), ...Object.values(s.finals).filter((r) => !live[r.id] && !s.recent[r.id])];
    this.body = JSON.stringify({ t: now, matches: [...rows, ...extra] });
    this.at = now;
    await this.ctx.storage.put('body', { at: now, body: this.body });
    return this.body;
  }

  /** RPC entry point used by the Worker. */
  async get() {
    const now = Date.now();
    if (!this.body) { const b = await this.ctx.storage.get('body'); if (b) { this.body = b.body; this.at = b.at; } }
    if (this.body && (now - this.at < TTL || now - this.failAt < RETRY_AFTER_ERROR)) return this.body;
    this.inflight ||= this.refresh().finally(() => { this.inflight = null; });
    try { return await this.inflight; } catch (e) {
      this.failAt = Date.now();
      if (this.body) return this.body; // API down or rate-limited: last good answer
      throw e;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/live') return env.ASSETS.fetch(request);
    if (!env.APIFOOTBALL_KEY) return Response.json({ error: 'APIFOOTBALL_KEY non impostata' }, { status: 503 });
    try {
      const body = await env.LIVE.get(env.LIVE.idFromName('live')).get();
      return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
