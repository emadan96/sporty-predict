// Compact match events and statistics from API-Football fixture details (`fixtures?ids=` / `fixtures?live=all`).
// Pure functions with no Node imports: shared by the hourly sync/build and by the live Worker (worker/index.js).

export const FINISHED = new Set(['FT', 'AET', 'PEN']);
export const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);

/** Event kind: goal, og (own goal), pen (penalty scored), mpen (penalty missed), yc, y2 (second yellow), rc, sub, var. */
function kind(e) {
  const t = (e.type || '').toLowerCase(), d = (e.detail || '').toLowerCase();
  if (t === 'goal') return d.includes('own') ? 'og' : d.includes('missed') ? 'mpen' : d.includes('penalty') ? 'pen' : 'goal';
  if (t === 'card') return d.includes('second') ? 'y2' : d.includes('red') ? 'rc' : 'yc';
  if (t === 'subst') return 'sub';
  if (t === 'var') return 'var';
  return null;
}

/**
 * [{ m: minute, x: added time, s: 'h'|'a', k: kind, p: player (going off for 'sub'), a: assist (coming on for 'sub'), d: VAR detail }]
 * Penalty shoot-out kicks (comments "Penalty Shootout") are left out: they are not match events.
 */
export function compactEvents(raw, homeId) {
  const out = [];
  for (const e of raw || []) {
    const k = kind(e);
    if (!k || /shootout/i.test(e.comments || '')) continue;
    const ev = { m: e.time?.elapsed ?? null, s: e.team?.id === homeId ? 'h' : 'a', k };
    if (e.time?.extra) ev.x = e.time.extra;
    if (e.player?.name) ev.p = e.player.name;
    if (e.assist?.name) ev.a = e.assist.name;
    if (k === 'var' && e.detail) ev.d = e.detail;
    out.push(ev);
  }
  return out;
}

/** Red cards per side, counted from compact events. */
export function redCards(events) {
  const rc = [0, 0];
  for (const e of events || []) if (e.k === 'rc' || e.k === 'y2') rc[e.s === 'h' ? 0 : 1]++;
  return rc[0] || rc[1] ? rc : null;
}

const STAT = { shots: 'Total Shots', sot: 'Shots on Goal', corners: 'Corner Kicks', yellow: 'Yellow Cards', red: 'Red Cards', fouls: 'Fouls', poss: 'Ball Possession' };
/** Same shape as the football-data stats ({ shots:[h,a], sot, corners, yellow, red }) plus fouls and possession. */
export function compactStats(raw, homeId) {
  if (!raw?.length) return null;
  const side = (id) => (id === homeId ? 0 : 1);
  const out = {};
  for (const t of raw) {
    const i = side(t.team?.id);
    for (const s of t.statistics || []) {
      const key = Object.keys(STAT).find((k) => STAT[k] === s.type);
      if (!key) continue;
      const v = s.value == null ? (key === 'poss' ? null : 0) : Number(String(s.value).replace('%', ''));
      if (v == null || !Number.isFinite(v)) continue;
      (out[key] ||= [0, 0])[i] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Live/final state of one fixture as used by the front end (also the body of /api/live). */
export function liveRow(x) {
  const homeId = x.teams?.home?.id;
  const events = compactEvents(x.events, homeId);
  const st = x.fixture?.status || {};
  const row = { id: x.fixture.id, st: st.short || null, min: st.elapsed ?? null, g: [x.goals?.home ?? null, x.goals?.away ?? null], ev: events };
  if (st.extra) row.x = st.extra;
  if (x.score?.halftime?.home != null) row.ht = [x.score.halftime.home, x.score.halftime.away];
  // Finished after extra time / penalties: g is the score after 120', ft the one after 90'.
  if (FINISHED.has(row.st) && x.score?.fulltime?.home != null) row.ft = [x.score.fulltime.home, x.score.fulltime.away];
  const rc = redCards(events);
  if (rc) row.rc = rc;
  return row;
}
