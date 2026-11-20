// API-Football v3 client: disk cache with TTL, per-minute throttling and daily-quota guard.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../env.js';
import { ROOT } from '../../config.js';

export const AF_DIR = process.env.AF_DIR || path.join(ROOT, 'data', 'af');
const CACHE_DIR = path.join(AF_DIR, 'cache');

const DIRECT = { base: 'https://v3.football.api-sports.io', headers: () => ({ 'x-apisports-key': env.apiKey }) };
const RAPID = {
  base: 'https://api-football-v1.p.rapidapi.com/v3',
  headers: () => ({ 'x-rapidapi-key': env.apiKey, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }),
};

export class QuotaError extends Error {}
/** The subscription does not cover this date/season; `hint` is the provider's message (e.g. "try from 2022 to 2024"). */
export class PlanError extends Error {
  constructor(msg, hint) { super(msg); this.hint = hint; }
}

export class ApiFootball {
  constructor() {
    this.target = env.rapidApi ? RAPID : DIRECT;
    this.quota = { dayLimit: null, dayRemaining: null, minuteLimit: null, minuteRemaining: null, calls: 0, cacheHits: 0, errors: [] };
    this.recent = []; // timestamps of calls in the last minute
  }

  get enabled() {
    return Boolean(env.apiKey);
  }

  #cacheFile(endpoint, params) {
    const key = endpoint + '?' + Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&');
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, endpoint.replace(/\//g, '_'), `${hash}.json`);
  }

  async #throttle() {
    const perMin = env.maxPerMinute || this.quota.minuteLimit || 10;
    for (;;) {
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t < 60_000);
      if (this.recent.length < perMin - 1) break;
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.recent[0]) + 50));
    }
    this.recent.push(Date.now());
  }

  /** Remaining daily calls we allow ourselves to spend (keeps a reserve). */
  budgetLeft() {
    const { dayLimit, dayRemaining } = this.quota;
    if (dayLimit == null || dayRemaining == null) return Infinity;
    return dayRemaining - Math.ceil((dayLimit * env.reservePct) / 100);
  }

  /**
   * GET with caching. ttlHours: Infinity = cache forever, 0 = always refetch.
   * Returns the parsed JSON body ({ response, paging, errors, ... }).
   */
  async get(endpoint, params = {}, { ttlHours = 6, allowStale = true, cache = true } = {}) {
    const file = this.#cacheFile(endpoint, params);
    let cached = null;
    if (cache) try {
      const st = await fs.stat(file);
      cached = { ageH: (Date.now() - st.mtimeMs) / 3_600_000, file };
    } catch { /* not cached */ }
    if (cached && cached.ageH < ttlHours) {
      this.quota.cacheHits++;
      return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    if (!this.enabled || this.budgetLeft() <= 0) {
      if (cached && allowStale) return JSON.parse(await fs.readFile(file, 'utf8'));
      if (!this.enabled) throw new QuotaError('APIFOOTBALL_KEY mancante');
      throw new QuotaError('Quota giornaliera API-Football esaurita (riserva raggiunta)');
    }

    await this.#throttle();
    const url = `${this.target.base}/${endpoint}?${new URLSearchParams(params)}`;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        // Never wait forever: a hung connection would block every later sync.
        res = await fetch(url, { headers: this.target.headers(), signal: AbortSignal.timeout(30_000) });
        break;
      } catch (e) {
        if (attempt < 2) { await this.#throttle(); continue; }
        if (cached && allowStale) return JSON.parse(await fs.readFile(file, 'utf8'));
        throw new Error(`${endpoint}: rete/timeout (${e.name === 'TimeoutError' ? 'nessuna risposta in 30s' : e.message})`);
      }
    }
    this.quota.calls++;
    const h = (n) => (res.headers.get(n) != null ? Number(res.headers.get(n)) : null);
    this.quota.dayLimit = h('x-ratelimit-requests-limit') ?? this.quota.dayLimit;
    this.quota.dayRemaining = h('x-ratelimit-requests-remaining') ?? this.quota.dayRemaining;
    this.quota.minuteLimit = h('x-ratelimit-limit') ?? this.quota.minuteLimit;
    this.quota.minuteRemaining = h('x-ratelimit-remaining') ?? this.quota.minuteRemaining;

    const body = await Promise.race([res.json(), new Promise((r) => setTimeout(() => r(null), 30_000))]).catch(() => null);
    const errors = body?.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
    if (!res.ok || !body || errors?.length) {
      const msg = `${endpoint} ${JSON.stringify(params)}: ${res.status} ${errors?.length ? JSON.stringify(body.errors) : ''}`;
      this.quota.errors = [...this.quota.errors.slice(-9), { at: new Date().toISOString(), msg }];
      if (cached && allowStale) return JSON.parse(await fs.readFile(file, 'utf8'));
      if (body?.errors?.plan) throw new PlanError(msg, String(body.errors.plan));
      if (body?.errors?.requests || res.status === 429) throw new QuotaError(msg);
      throw new Error(msg);
    }
    if (cache) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(body));
    }
    return body;
  }

  /** Fetch every page of a paginated endpoint. If the quota runs out midway, returns what it got (out.partial = true). */
  async getAll(endpoint, params, opts, { maxPage = Infinity } = {}) {
    const first = await this.get(endpoint, { ...params, page: 1 }, opts);
    const out = [...(first.response || [])];
    const total = first.paging?.total || 1;
    out.pages = total;
    for (let p = 2; p <= total; p++) {
      if (p > maxPage) { out.partial = true; out.reason = 'page'; break; }
      try {
        const body = await this.get(endpoint, { ...params, page: p }, opts);
        out.push(...(body.response || []));
      } catch (e) {
        if (!(e instanceof QuotaError || e instanceof PlanError)) throw e;
        out.partial = true; out.reason = e instanceof PlanError ? 'page' : 'quota'; out.error = e;
        break;
      }
    }
    return out;
  }

  /** Account status. The /status endpoint does not count against the daily quota. */
  async status() {
    if (!this.enabled) return null;
    const res = await fetch(`${this.target.base}/status`, { headers: this.target.headers(), signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    const r = body?.response;
    if (!r || Array.isArray(r)) return null;
    this.quota.dayLimit = r.requests?.limit_day ?? this.quota.dayLimit;
    if (r.requests) this.quota.dayRemaining = r.requests.limit_day - r.requests.current;
    return { plan: r.subscription?.plan || null, active: r.subscription?.active, end: r.subscription?.end, used: r.requests?.current, limit: r.requests?.limit_day };
  }
}
