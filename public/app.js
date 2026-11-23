// Sporty Predict — vanilla SPA. Routes: #/d/YYYY-MM-DD[?league=XX] and #/m/<matchId> (overlay).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p, d = 0) => (p == null || Number.isNaN(p) ? '–' : `${(p * 100).toFixed(d)}%`);
const odd = (p) => (p > 0 ? (1 / p).toFixed(2) : '–');
const fx = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '–' : Number(x).toFixed(d));
const sgn = (l) => (l == null ? '–' : l > 0 ? `+${l}` : `${l}`);
// Online (static) version: the same endpoints are pre-built JSON files, see server/build-static.js.
const STATIC = document.documentElement.dataset.static === '1';
const fileId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
function staticUrl(url) {
  const u = new URL(url, 'http://x');
  const q = u.searchParams;
  if (u.pathname === '/api/matches') return `api/matches/${q.get('date')}.json`;
  if (u.pathname === '/api/match') return `api/match/${fileId(q.get('id'))}.json`;
  return `api/${u.pathname.slice(5)}.json`;
}
let searchIndex = null;
async function staticSearch(term) {
  searchIndex ||= api('/api/search').catch((e) => { searchIndex = null; throw e; });
  const t = term.toLowerCase();
  const now = Date.now();
  const ts = (m) => Date.parse(`${m.date}T${m.time || '12:00'}:00`);
  return (await searchIndex).filter((m) => m.home.toLowerCase().includes(t) || m.away.toLowerCase().includes(t))
    .sort((a, b) => Math.abs(ts(a) - now) - Math.abs(ts(b) - now)).slice(0, 20);
}
const api = async (url, opts) => {
  if (STATIC && url.startsWith('/api/search?')) return staticSearch(new URL(url, 'http://x').searchParams.get('q') || '');
  const r = await fetch(STATIC ? staticUrl(url) : url, opts);
  if (!r.ok) {
    if (STATIC && r.status === 404) {
      if (url.startsWith('/api/matches')) return { date: new URL(url, 'http://x').searchParams.get('date'), leagues: [] };
      if (url.startsWith('/api/match')) throw new Error('Questa partita non è disponibile nella versione online.');
    }
    throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  }
  return r.json();
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  leagues: [], dates: null, status: null, date: null, league: null, filter: 'all', time: 'all', topFirst: store.get('topFirst', true), favs: new Set(store.get('favs', [])), data: null, detail: null, tab: 'pred',
  tf: 'FT', trendTf: 'FT', collapsed: new Set(store.get('collapsed', [])),
};
const leagueBy = (code) => state.leagues.find((l) => l.code === code) || state.data?.leagues.find((l) => l.code === code) || { code, name: code, country: '' };
const leagueIcon = (l) => (l.logo ? `<img class="flag logo" src="${esc(l.logo)}" alt="" loading="lazy">`
  : l.flag ? `<img class="flag" src="https://flagcdn.com/w40/${l.flag}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : l.flagUrl ? `<img class="flag" src="${esc(l.flagUrl)}" alt="" loading="lazy">` : '<span class="flag"></span>');
const teamLogo = (src) => (src ? `<img class="tlogo" src="${esc(src)}" alt="" loading="lazy">` : '');

const todayRome = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const WD = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const dayLabel = (d) => {
  const t = todayRome();
  if (d === t) return 'Oggi';
  if (d === addDays(t, -1)) return 'Ieri';
  if (d === addDays(t, 1)) return 'Domani';
  return WD[new Date(`${d}T12:00:00Z`).getUTCDay()];
};
const fmtDate = (d) => { const [, m, dd] = d.split('-'); return `${dd}/${m}`; };
const fmtDateLong = (d) => { const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [p, qs] = h.split('?');
  return { parts: p.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

async function route() {
  const { parts, q } = parseHash();
  if (parts[0] === 'm' && parts[1]) {
    if (!state.data) await loadList(state.date || defaultDate(), null);
    openDetail(decodeURIComponent(parts[1]));
    return;
  }
  closeDetail(false);
  const date = parts[0] === 'd' && parts[1] ? parts[1] : state.date || defaultDate();
  await loadList(date, q.get('league'));
}

function defaultDate() {
  const t = todayRome();
  const c = state.dates?.counts || {};
  if (c[t]) return t;
  for (let i = 1; i < 10; i++) { if (c[addDays(t, i)]) return addDays(t, i); if (c[addDays(t, -i)]) return addDays(t, -i); }
  return t;
}

const listHash = (date, league) => `#/d/${date}${league ? `?league=${encodeURIComponent(league)}` : ''}`;

// ---------------------------------------------------------------- list view
const dayCache = new Map(); // date -> Promise<data>
const fetchDay = (date) => {
  if (!dayCache.has(date)) {
    const pr = api(`/api/matches?date=${date}`);
    pr.catch(() => dayCache.delete(date));
    dayCache.set(date, pr);
  }
  return dayCache.get(date);
};
/** Fetch the neighbouring days while the browser is idle, so moving between dates is instant. */
function prefetchAround(date) {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(() => { for (const n of [1, -1, 2]) fetchDay(addDays(date, n)).catch(() => {}); });
}

async function loadList(date, league) {
  state.date = date; state.league = league || null;
  if (!state.data || state.data.date !== date) {
    const slow = setTimeout(() => { $('#main').innerHTML = '<div class="loading"><span class="spinner"></span>Calcolo pronostici…</div>'; }, 150);
    try { state.data = await fetchDay(date); } finally { clearTimeout(slow); }
  }
  renderSidebar();
  renderList();
  prefetchAround(date);
}

const CATS = ['Coppe internazionali', 'Nazionali', 'Campionati', 'Coppe nazionali'];

function renderSidebar() {
  const day = state.data?.leagues || [];
  const filter = ($('#league-filter')?.value || '').toLowerCase();
  const byCat = new Map(CATS.map((c) => [c, []]));
  for (const l of day) {
    if (filter && !`${l.name} ${l.country}`.toLowerCase().includes(filter)) continue;
    const cat = l.category || 'Campionati';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(l);
  }
  const item = (l) => `
    <div class="side-item">
      <a class="side-league ${state.league === l.code ? 'active' : ''}" href="${listHash(state.date, l.code)}">
        ${leagueIcon(l)}<span class="sl-txt"><span>${esc(l.name)}</span><span class="c">${esc(l.country)}</span></span>
        <span class="cnt">${l.matches.length}</span>
      </a>${pinBtn(l.code)}
    </div>`;
  const favs = day.filter((l) => state.favs.has(l.code) && (!filter || `${l.name} ${l.country}`.toLowerCase().includes(filter)));
  const nav = $('#leagues');
  nav.innerHTML = `
    <a class="side-league ${!state.league ? 'active' : ''}" href="${listHash(state.date)}">⚽ <span class="sl-txt"><span>Tutte le competizioni</span></span>
      <span class="cnt">${day.reduce((s, l) => s + l.matches.length, 0)}</span></a>
    ${favs.length ? `<div class="side-cat">Preferiti</div>${favs.map(item).join('')}` : ''}
    ${[...byCat].filter(([, ls]) => ls.length).map(([cat, ls]) => `<div class="side-cat">${esc(cat)}</div>${ls.map(item).join('')}`).join('')}
    ${!day.length ? '<div class="note" style="padding:8px 16px">Nessuna competizione in questa data.</div>' : ''}`;
  nav.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', onPin));
}

const FILTERS = [
  ['all', 'Tutte'], ['finished', 'Finite'], ['odds', 'Con quote'],
];

// Kick-off time slots (Rome time). 'next' = not started yet, within the next 3 hours (today only).
const TIME_SLOTS = [
  ['all', 'Tutti gli orari'], ['next1', 'Prossima ora'], ['next', 'Prossime 3 ore'], ['am', 'Fino alle 12:00'], ['12', '12:00 – 15:00'],
  ['15', '15:00 – 18:00'], ['18', '18:00 – 21:00'], ['21', 'Dalle 21:00'],
];
const nowRomeMin = () => {
  const [h, m] = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
  return h * 60 + m;
};
function passTime(m, slot = state.time) {
  if (slot === 'all') return true;
  const [h, mm] = String(m.time || '').split(':').map(Number);
  if (!Number.isFinite(h)) return false;
  const t = h * 60 + (mm || 0);
  switch (slot) {
    case 'next1': case 'next': { if (state.date !== todayRome() || m.status !== 'NS') return false; const n = nowRomeMin(); return t >= n && t <= n + (slot === 'next1' ? 60 : 180); }
    case 'am': return t < 720;
    case '12': return t >= 720 && t < 900;
    case '15': return t >= 900 && t < 1080;
    case '18': return t >= 1080 && t < 1260;
    case '21': return t >= 1260;
    default: return true;
  }
}

function passFilter(m) {
  return passTime(m) && passStatus(m);
}

// Major competitions: European club cups, top-5 leagues, main national-team tournaments (display order).
const MAJOR = ['AF2', 'AF3', 'AF848', 'AF531', 'I1', 'E0', 'SP1', 'D1', 'F1', 'AF1', 'AF4', 'AF5', 'AF9', 'AF32', 'AF34', 'AF29', 'AF30', 'AF31'];
const majorRank = (code) => { const i = MAJOR.indexOf(code); return i < 0 ? Infinity : i; };
const isMajor = (code) => MAJOR.includes(code);
// Favourite competitions (saved in the browser): always first, before the major ones.
const isFav = (code) => state.favs.has(code);
const favRank = (code) => (isFav(code) ? 0 : 1);
const PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4v2H6v-2l4-4z"/></svg>';
const pinBtn = (code) => `<button class="pin ${isFav(code) ? 'on' : ''}" data-pin="${esc(code)}" aria-pressed="${isFav(code)}" aria-label="${isFav(code) ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}" title="${isFav(code) ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}">${PIN}</button>`;
function onPin(e) {
  e.preventDefault(); e.stopPropagation();
  const c = e.currentTarget.dataset.pin;
  if (state.favs.has(c)) state.favs.delete(c); else state.favs.add(c);
  store.set('favs', [...state.favs]);
  renderSidebar(); renderList();
}
const STAR = '<svg class="star" viewBox="0 0 24 24" width="13" height="13" aria-label="Campionato principale"><path fill="currentColor" d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
function passStatus(m) {
  switch (state.filter) {
    case 'upcoming': return m.status === 'NS';
    case 'finished': return m.status === 'FT';
    case 'odds': return Boolean(m.move?.cur?.x12);
    case 'value': return m.pred?.hasValue;
    case 'alta': return m.pred?.confidence === 'alta';
    default: return true;
  }
}

const COLS = {
  FT: [['1', (p) => p.x12.home, 'x'], ['X', (p) => p.x12.draw, 'x'], ['2', (p) => p.x12.away, 'x'], ['O2.5', (p) => p.over25], ['GG', (p) => p.btts], ['MG 2-4', (p) => p.mg]],
  PT: [['1 PT', (p) => p.htX12.home, 'x'], ['X PT', (p) => p.htX12.draw, 'x'], ['2 PT', (p) => p.htX12.away, 'x'], ['O0.5', (p) => p.htOver05], ['O1.5', (p) => p.htOver15], ['MG 0-1', (p) => p.mgHt]],
};

function renderList() {
  const counts = state.dates?.counts || {};
  const days = Array.from({ length: 11 }, (_, i) => addDays(state.date, i - 5));
  const leagues = (state.data.leagues || []).filter((l) => !state.league || l.code === state.league);
  const cols = COLS[state.tf];
  // Matches per time slot, with the other filters applied (shown in the menu).
  const slotCount = Object.fromEntries(TIME_SLOTS.map(([k]) => [k, 0]));
  for (const l of leagues) for (const m of l.matches) if (passStatus(m)) for (const [k] of TIME_SLOTS) if (passTime(m, k)) slotCount[k]++;
  const isToday = state.date === todayRome();
  if (state.time.startsWith('next') && !isToday) state.time = 'all';
  let total = 0, hits = 0, played = 0;
  const byTime = state.time !== 'all'; // time filter: one list in kick-off order
  const ordered = [...leagues].sort((a, b) => favRank(a.code) - favRank(b.code) || (state.topFirst ? majorRank(a.code) - majorRank(b.code) : 0)); // stable: the rest keeps its order
  const hcols = `<div class="hcols"><span class="oh">1 · X · 2</span><span>AH</span><span>Tot</span>${cols.map(([n]) => `<span>${n}</span>`).join('')}<span>Esatto</span><span class="ih">Indice</span></div>`;
  let blocks;
  if (byTime) {
    const rows = [];
    for (const l of leagues) for (const m of l.matches) if (passFilter(m)) rows.push({ m, l });
    rows.sort((a, b) => (a.m.time || '').localeCompare(b.m.time || '') || favRank(a.l.code) - favRank(b.l.code) || majorRank(a.l.code) - majorRank(b.l.code) || a.m.home.localeCompare(b.m.home));
    total = rows.length;
    for (const { m } of rows) if (m.status === 'FT' && m.pred) { played++; if (outcomeKey(m.ft) === topKey(m.pred.x12)) hits++; }
    const label = TIME_SLOTS.find(([k]) => k === state.time)?.[1] || '';
    blocks = rows.length ? `
      <section class="league-block chrono">
        <div class="league-head static"><span class="lname">Per orario · ${esc(label)}</span><span class="lcount">${rows.length}</span>${hcols}</div>
        ${rows.map(({ m, l }) => rowHtml(m, cols, l)).join('')}
      </section>` : '';
  } else blocks = ordered.map((l) => {
    const rows = l.matches.filter(passFilter);
    if (!rows.length) return '';
    total += rows.length;
    for (const m of rows) if (m.status === 'FT' && m.pred) { played++; if (outcomeKey(m.ft) === topKey(m.pred.x12)) hits++; }
    const collapsed = state.collapsed.has(l.code);
    return `
      <section class="league-block ${collapsed ? 'collapsed' : ''}">
        <div class="league-head ${isMajor(l.code) ? 'major' : ''} ${isFav(l.code) ? 'fav' : ''}" data-collapse="${esc(l.code)}">${leagueIcon(l)}<span class="lt"><span class="lname">${esc(l.name)}</span><span class="country">${esc(l.country)}</span></span>${isMajor(l.code) ? STAR : ''}
          <span class="lcount">${rows.length}</span>${pinBtn(l.code)}
          ${hcols}
        </div>
        ${collapsed ? '' : rows.map((m) => rowHtml(m, cols)).join('')}
      </section>`;
  }).join('');

  const st = state.status?.apiFootball;
  const banner = st && !st.enabled && !STATIC ? `<div class="banner">Stai vedendo solo i campionati di football-data.co.uk. Per avere <b>tutte le competizioni</b> (coppe europee, nazionali, campionati minori) inserisci la chiave API-Football nel file <code>.env</code> e riavvia.</div>`
    : '';

  // Re-rendering must not reset the horizontal scroll of the date strip and the filter pills (mobile).
  const prev = { f: $('#main .filters')?.scrollLeft || 0, d: $('#main .days')?.scrollLeft || 0, date: renderList.lastDate };
  renderList.lastDate = state.date;
  const today = todayRome();

  $('#main').innerHTML = `
    ${banner}
    <div class="datebar">
      <button class="nav" data-date="${addDays(state.date, -1)}" aria-label="Giorno precedente">‹</button>
      <div class="days">${days.map((d) => `
        <div class="day ${d === state.date ? 'active' : ''} ${d === today ? 'today' : ''} ${counts[d] ? '' : 'none'}" data-date="${d}"${d === today ? ' aria-current="date"' : ''}>
          <small>${dayLabel(d)}</small>${fmtDate(d)}</div>`).join('')}
      </div>
      <button class="nav" data-date="${addDays(state.date, 1)}" aria-label="Giorno successivo">›</button>
      <input type="date" value="${state.date}" min="${state.dates?.min || ''}" max="${state.dates?.max || ''}">
    </div>
    <div class="filters">
      <label class="chip time-sel ${state.time !== 'all' ? 'active' : ''}" title="Filtra per orario d'inizio">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <select data-time aria-label="Orario">${TIME_SLOTS.filter(([k]) => !k.startsWith('next') || isToday).map(([k, v]) => `<option value="${k}" ${state.time === k ? 'selected' : ''}>${v}${k === 'all' ? '' : ` (${slotCount[k]})`}</option>`).join('')}</select>
      </label>
      <button class="chip top-chip ${state.topFirst && !byTime ? 'active' : ''}" data-top ${byTime ? 'disabled title="Con il filtro orario le partite sono in ordine di inizio"' : 'title="Coppe europee, top 5 campionati e grandi tornei per nazionali sempre in alto"'}>${STAR}Top in alto</button>
      ${FILTERS.map(([k, v]) => `<button class="chip ${state.filter === k ? 'active' : ''}" data-filter="${k}">${v}</button>`).join('')}
      ${played ? `<span class="chip stat" title="Esito 1X2 più probabile indovinato sulle partite finite mostrate">1X2 centrati <b>${hits}/${played}</b> (${pct(hits / played)})</span>` : ''}
    </div>
    ${total ? blocks : `<div class="empty">Nessuna partita ${state.filter !== 'all' || state.time !== 'all' ? 'con questi filtri' : 'per questa data'}${state.league ? ' in questa competizione' : ''}.<br><br>
      <small>Le partite compaiono qualche giorno prima del turno. Usa le frecce per altre date.</small></div>`}
  `;

  const main = $('#main');
  const fbar = main.querySelector('.filters'), dbar = main.querySelector('.days');
  if (fbar) fbar.scrollLeft = prev.f;
  if (dbar) {
    if (prev.date === state.date) dbar.scrollLeft = prev.d;
    else { const a = dbar.querySelector('.day.active'); if (a) dbar.scrollLeft = a.offsetLeft - (dbar.clientWidth - a.offsetWidth) / 2 - dbar.offsetLeft; }
  }
  main.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', onPin));
  main.querySelector('[data-top]')?.addEventListener('click', () => { state.topFirst = !state.topFirst; store.set('topFirst', state.topFirst); renderList(); });
  main.querySelector('[data-time]')?.addEventListener('change', (e) => { state.time = e.target.value; renderList(); });
  main.querySelectorAll('[data-date]').forEach((el) => el.addEventListener('click', () => { location.hash = listHash(el.dataset.date, state.league); }));
  $('#main input[type=date]').addEventListener('change', (e) => { if (e.target.value) location.hash = listHash(e.target.value, state.league); });
  main.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('click', () => { state.filter = el.dataset.filter; renderList(); }));
  main.querySelectorAll('[data-collapse]').forEach((el) => el.addEventListener('click', () => {
    const c = el.dataset.collapse;
    if (state.collapsed.has(c)) state.collapsed.delete(c); else state.collapsed.add(c);
    store.set('collapsed', [...state.collapsed]);
    renderList();
  }));
  main.querySelectorAll('.row').forEach((el) => el.addEventListener('click', () => { location.hash = `#/m/${encodeURIComponent(el.dataset.id)}`; }));
}

const outcomeKey = ([h, a]) => (h > a ? 'home' : h === a ? 'draw' : 'away');
const topKey = (x) => Object.entries(x).sort((a, b) => b[1] - a[1])[0][0];

/** Arrow comparing current vs opening odds: ▼ shortening (money in), ▲ drifting. */
function arrow(cur, open) {
  if (!cur || !open || Math.abs(cur - open) < 0.015) return '';
  return cur < open ? '<i class="mv dn" title="quota in calo">▼</i>' : '<i class="mv up" title="quota in crescita">▲</i>';
}

function oddsCells(move) {
  const c = move?.cur, o = move?.open;
  const x = c?.x12?.odds;
  const x12 = x ? `<div class="oc">${x.map((v, i) => `<span>${fx(v)}${arrow(v, o?.x12?.odds?.[i])}</span>`).join('')}</div>` : '<div class="oc muted">–</div>';
  const lineCell = (cur, open, fmt) => {
    if (!cur) return '<div class="lc muted">–</div>';
    const moved = open && open.line !== cur.line;
    return `<div class="lc ${moved ? 'moved' : ''}" title="${moved ? `apertura ${fmt(open.line)}` : ''}${cur.book ? ` · ${esc(cur.book)}` : ''}">
      <b>${fmt(cur.line)}</b><small>${fx(cur.odds?.[0])} · ${fx(cur.odds?.[1])}</small></div>`;
  };
  return x12 + lineCell(c?.ah, o?.ah, sgn) + lineCell(c?.ou, o?.ou, (l) => fx(l, l % 0.5 ? 2 : 1));
}

function rowHtml(m, cols, league = null) {
  const p = m.pred;
  const fin = m.status === 'FT';
  const winH = fin && m.ft[0] > m.ft[1], winA = fin && m.ft[1] > m.ft[0];
  let pc = '';
  if (p) {
    const isPt = state.tf === 'PT';
    const sc = isPt ? m.ht : m.ft;
    const x12 = isPt ? p.htX12 : p.x12;
    const top = topKey(x12);
    const res = fin && sc ? outcomeKey(sc) : null;
    const keys = ['home', 'draw', 'away'];
    pc = cols.map(([label, f, kind], i) => {
      const v = f(p);
      if (kind === 'x') {
        const k = keys[i];
        return `<div class="pc ${top === k ? 'top' : ''} ${res && top === k ? (res === k ? 'hit' : 'miss') : ''}" data-l="${label}"><b>${pct(v)}</b></div>`;
      }
      return `<div class="pc ${v >= 0.6 ? 'hi' : ''}" data-l="${label}"><b>${pct(v)}</b></div>`;
    }).join('');
    const score = isPt ? p.scoreHt : p.score;
    pc += `<div class="pc score ${fin && sc && score === `${sc[0]}-${sc[1]}` ? 'hit' : ''}" data-l="Esatto"><b>${score}</b></div>`;
    pc += p.index ? `<div class="pc idx" data-l="Indice ${pct(p.index.score)}" title="Mercato più solido: modello ${pct(p.index.model)}${p.index.archive != null ? ` · archivio ${pct(p.index.archive)} su ${p.index.n}` : ''}">
      <b>${esc(p.index.label)}</b><small class="idx-p">${pct(p.index.score)}</small></div>` : '<div class="pc idx"></div>';
  }
  const timeCell = fin ? `<div class="time ft">Finale${m.afterExtra ? `<br><small>${m.statusText === 'PEN' ? 'rigori' : 'd.t.s.'}</small>` : ''}</div>`
    : m.statusText ? `<div class="time off">${esc(m.statusText)}</div>`
      : m.status === 'LIVE' ? '<div class="time live">Live</div>' : `<div class="time">${esc(m.time)}</div>`;
  return `
    <div class="row ${league && (isMajor(league.code) || isFav(league.code)) ? 'major' : ''}" data-id="${esc(m.id)}">
      ${timeCell}
      <div class="teams">
        ${league ? `<div class="tl">${leagueIcon(league)}<span>${esc(league.country)} · ${esc(league.name)}</span>${isMajor(league.code) ? STAR : ''}${isFav(league.code) ? `<i class="pin-mark">${PIN}</i>` : ''}</div>` : ''}
        <div class="t ${winH ? 'win' : ''}">${teamLogo(m.homeLogo)}<span>${esc(m.home)}</span>${p?.hasValue && !fin ? '<span class="badge value">VALUE</span>' : ''}</div>
        <div class="s num">${fin ? m.ft[0] : ''}${fin && m.ht ? `<span class="htsc">(${m.ht[0]})</span>` : ''}</div>
        <div class="t ${winA ? 'win' : ''}">${teamLogo(m.awayLogo)}<span>${esc(m.away)}</span></div>
        <div class="s num">${fin ? m.ft[1] : ''}${fin && m.ht ? `<span class="htsc">(${m.ht[1]})</span>` : ''}</div>
      </div>
      <div class="rcols num">${oddsCells(m.move)}${pc}</div>
    </div>`;
}

// ---------------------------------------------------------------- detail view
async function openDetail(id) {
  const panel = $('#detail');
  panel.hidden = false; $('#detail-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  if (state.detail?.match.id !== id) {
    panel.innerHTML = '<div class="loading">Calcolo pronostico completo…</div>';
    try { state.detail = await api(`/api/match?id=${encodeURIComponent(id)}`); } catch (e) { panel.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    state.tab = 'pred';
  }
  renderDetail();
}

function closeDetail(navigate = true) {
  $('#detail').hidden = true; $('#detail-backdrop').hidden = true;
  document.body.style.overflow = '';
  if (navigate) location.hash = listHash(state.date || todayRome(), state.league);
}

const TABS = [
  ['pred', 'Pronostico'], ['trend', 'Trend archivio'], ['ht', '1° Tempo'], ['mg', 'Multigol'], ['cs', 'Risultato esatto'], ['htft', 'Parziale/Finale'],
  ['asian', 'Linee asiatiche'], ['odds', 'Quote & Bookmaker'], ['form', 'Forma & H2H'], ['table', 'Classifica'],
];

const crestColor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 55%)`;
};
const initials = (n) => n.split(/\s+/).filter((w) => w.length > 1).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || n.slice(0, 2).toUpperCase();
const crest = (name, logo) => (logo ? `<div class="crest img"><img src="${esc(logo)}" alt=""></div>`
  : `<div class="crest" style="background:${crestColor(name)}">${esc(initials(name))}</div>`);

function renderDetail({ tabChanged = false } = {}) {
  const { match: m, league: l, prediction: p } = state.detail;
  const panel = $('#detail');
  const prevTabsLeft = panel.querySelector('.tabs')?.scrollLeft || 0;
  const fin = m.status === 'FT';
  const tabs = TABS.filter(([k]) => k !== 'table' || state.detail.standings.length);
  if (!tabs.some(([k]) => k === state.tab)) state.tab = 'pred';
  $('#detail').innerHTML = `
    <div class="d-head">
      <div class="d-top">${leagueIcon(l)} ${esc(l.country)} · ${esc(l.name)}${m.round ? ` · ${esc(m.round)}` : ''} · ${fmtDateLong(m.date)} ${esc(m.time)}
        <span class="badge conf-${p.confidence}">Fiducia ${p.confidence}</span>
        <button class="d-close" aria-label="Chiudi">✕</button></div>
      <div class="scoreboard">
        <div class="sb-team">${crest(m.home, m.homeLogo)}<div class="name">${esc(m.home)}</div></div>
        <div class="sb-mid">
          ${fin ? `<div class="big num">${m.ft[0]} - ${m.ft[1]}</div><div class="sub">Finale${m.ht ? ` · PT ${m.ht[0]}-${m.ht[1]}` : ''}${m.afterExtra ? ` · dopo supplementari ${m.afterExtra.join('-')}` : ''}</div>`
    : `<div class="when num">${esc(m.statusText || m.time)}</div><div class="sub">${fmtDateLong(m.date)}${m.venue ? ` · ${esc(m.venue)}` : ''}</div>`}
          <div class="sub" style="margin-top:6px">Esatto più probabile <b class="acc2">${p.expected.ft.score}</b> · PT <b class="acc2">${p.expected.ht.score}</b></div>
        </div>
        <div class="sb-team">${crest(m.away, m.awayLogo)}<div class="name">${esc(m.away)}</div></div>
      </div>
      <div class="xgline">Goal attesi <b class="num">${fx(p.expected.xg[0])} – ${fx(p.expected.xg[1])}</b> · 1° tempo <b class="num">${fx(p.expected.xgHt[0])} – ${fx(p.expected.xgHt[1])}</b>
        ${p.ah ? ` · AH <b class="num">${sgn(p.ah.line)}</b>` : ''}${p.totalLine ? ` · Total <b class="num">${p.totalLine.line}</b>` : ''}
        ${m.xg ? ` · xG reali <b class="num">${fx(m.xg[0])} – ${fx(m.xg[1])}</b>` : ''}</div>
    </div>
    <nav class="tabs">${tabs.map(([k, v]) => `<button class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${v}</button>`).join('')}</nav>
    <div class="d-body">${TAB_RENDER[state.tab]()}</div>`;
  $('#detail .d-close').addEventListener('click', () => closeDetail());
  // Keep the tab strip where it was (mobile) and, on a tab change, start the new tab from its top.
  const strip = panel.querySelector('.tabs');
  strip.scrollLeft = prevTabsLeft;
  if (tabChanged) {
    const head = panel.querySelector('.d-head').offsetHeight;
    if (panel.scrollTop > head) panel.scrollTop = head;
    const a = strip.querySelector('.tab.active');
    if (a && (a.offsetLeft < strip.scrollLeft || a.offsetLeft + a.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = a.offsetLeft - (strip.clientWidth - a.offsetWidth) / 2;
    }
  }
  panel.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { if (state.tab === b.dataset.tab) return; state.tab = b.dataset.tab; renderDetail({ tabChanged: true }); }));
  $('#detail').querySelectorAll('[data-ttf]').forEach((b) => b.addEventListener('click', () => { state.trendTf = b.dataset.ttf; renderDetail(); }));
  $('#detail').querySelectorAll('[data-goto]').forEach((r) => r.addEventListener('click', () => { location.hash = `#/m/${encodeURIComponent(r.dataset.goto)}`; }));
}

// ---- building blocks
function bars(items, { hl, odds, alt } = {}) {
  const max = Math.max(...items.map((i) => i.p || 0), 0.0001);
  return items.map((i) => `
    <div class="bar ${hl && hl(i) ? 'hl' : ''}">
      <span class="lbl">${esc(i.label)}</span>
      <span class="track"><span class="fill ${alt ? 'alt' : ''}" style="width:${((i.p || 0) / max) * 100}%"></span></span>
      <span class="v num">${pct(i.p, 1)}</span>
      <span class="o num">${odds === false ? '' : `@${odd(i.p)}`}</span>
    </div>`).join('');
}

function tri(x, labels = ['1', 'X', '2'], bookOdds) {
  const vals = [x.home, x.draw, x.away];
  const best = vals.indexOf(Math.max(...vals));
  return `<div class="tri">${vals.map((v, i) => `
    <div class="cell ${i === best ? 'best' : ''}"><small>${esc(labels[i])}</small><b class="num">${pct(v)}</b>
      <span class="q num">giusta ${odd(v)}${bookOdds ? ` · ${esc(bookOdds.book)} ${fx(bookOdds.odds[i])}` : ''}</span></div>`).join('')}</div>`;
}

const ouItems = (over, suffix = '') => Object.entries(over).flatMap(([l, p]) => [
  { label: `Over ${l}${suffix}`, p }, { label: `Under ${l}${suffix}`, p: 1 - p },
]);

function heatmap(matrix, actual) {
  const n = matrix.length;
  const max = Math.max(...matrix.flat());
  let cells = `<div class="ax"></div>${matrix[0].map((_, a) => `<div class="ax">${a}</div>`).join('')}`;
  matrix.forEach((row, h) => {
    cells += `<div class="ax">${h}</div>`;
    row.forEach((v, a) => {
      const isAct = actual && actual[0] === h && actual[1] === a;
      cells += `<div class="hc num" style="background:rgb(var(--heat) / ${(0.06 + 0.9 * v / max).toFixed(3)});${isAct ? 'box-shadow:inset 0 0 0 2px var(--foreground)' : ''}">
        <span>${h}-${a}</span>${pct(v, 1)}</div>`;
    });
  });
  return `<div class="heat" style="grid-template-columns: 22px repeat(${n}, 1fr)">${cells}</div>
    <div class="note">Righe: goal ${esc(state.detail.match.home)} · Colonne: goal ${esc(state.detail.match.away)}${actual ? ' · bordo scuro = risultato reale' : ''}</div>`;
}

const refX12 = () => {
  const x = state.detail.odds.x12;
  if (!x) return null;
  for (const b of ['b365', 'ps', 'sbo', 'avg']) if (x[b]) return { book: state.detail.odds.labels[b] || b, odds: x[b] };
  return null;
};

/** Did a trend market hit, given the final (or HT) score? */
function trendHit(label, ft, ht) {
  const pt = / PT$/.test(label) || /^MG PT/.test(label);
  const s = pt ? ht : ft;
  if (!s) return null;
  const [h, a] = s, t = h + a;
  const L = label.replace(/ PT$/, '').replace(/^MG PT/, 'MG');
  if (L === '1') return h > a; if (L === 'X') return h === a; if (L === '2') return h < a;
  if (L === '1X') return h >= a; if (L === 'X2') return h <= a; if (L === '12') return h !== a;
  let m;
  if ((m = /^Over ([\d.]+)$/.exec(L))) return t > Number(m[1]);
  if ((m = /^Under ([\d.]+)$/.exec(L))) return t < Number(m[1]);
  if (L === 'Goal') return h > 0 && a > 0; if (L === 'No Goal') return !(h > 0 && a > 0);
  if ((m = /^MG (\d)-(\d)$/.exec(L))) return t >= Number(m[1]) && t <= Number(m[2]);
  if (L === 'Casa segna') return h > 0; if (L === 'Ospite segna') return a > 0;
  if (L === 'Casa Over 1.5') return h > 1.5; if (L === 'Ospite Over 1.5') return a > 1.5;
  return null;
}

const TAB_RENDER = {
  pred() {
    const p = state.detail.prediction;
    const m = state.detail.match;
    const idx = p.trends.index;
    return `
      <div class="cards">
        <div class="card wide"><h3>Esito finale 1X2</h3>${tri(p.ft.x12, ['1 · ' + m.home, 'X · Pareggio', '2 · ' + m.away], refX12())}</div>
        ${idx.length ? `<div class="card wide"><h3>Indice · mercati più solidi</h3><div class="idx-cards">
          ${idx.map((r, i) => `<div class="idx-card ${i === 0 ? 'first' : ''}"><small>${r.group === 'PT' ? '1° tempo' : 'Finale'}</small><b>${esc(r.label)}</b>
            <span class="num">${pct(r.score)}</span><small>modello ${pct(r.model)}${r.archive != null ? ` · archivio ${pct(r.archive)} (${r.n})` : ''}</small></div>`).join('')}
        </div></div>` : ''}
        <div class="card wide verdict"><h3>Il pronostico</h3><p>${verdict(p, m)}</p></div>
        <div class="card picks"><h3>Pronostici principali</h3>
          ${p.picks.map((k) => `<div class="pick"><span class="cat">${esc(k.category)}</span><span class="lab">${esc(k.label)}</span>
            <span class="pp num">${pct(k.p)}</span><span class="fair num">@${fx(k.fair)}</span></div>`).join('')}
        </div>
        <div class="card"><h3>Under / Over finale</h3>${bars(ouItems(p.ft.over).filter((_, i) => i < 10), { hl: (i) => i.p >= 0.5 })}</div>
        <div class="card"><h3>Doppia chance · Goal</h3>
          ${bars([{ label: '1X', p: p.ft.dc['1X'] }, { label: 'X2', p: p.ft.dc.X2 }, { label: '12', p: p.ft.dc[12] },
    { label: 'Goal', p: p.ft.btts.yes }, { label: 'No Goal', p: p.ft.btts.no }, { label: 'Goal + O2.5', p: p.ft.bttsOver25 },
    { label: 'Pari', p: p.ft.oddEven.even }, { label: 'Dispari', p: p.ft.oddEven.odd }])}
        </div>
        <div class="card"><h3>Risultati esatti più probabili</h3>${bars(p.ft.exact.slice(0, 6).map((e) => ({ label: e.score, p: e.p })), { alt: true, hl: (i) => m.ft && i.label === `${m.ft[0]}-${m.ft[1]}` })}</div>
        <div class="card"><h3>Value bet</h3>
          ${p.value.length ? p.value.map((v) => `<div class="value-row"><span><b>${esc(v.market)}</b> · ${esc(v.selection)}<br><small class="muted">${esc(v.book)}</small></span>
            <span class="num">${pct(v.p)}</span><span class="num">@${fx(v.odds)}</span><span class="edge num">+${pct(v.edge, 1)}</span></div>`).join('')
    : '<div class="note">Nessuna quota sopra il valore giusto stimato (margine minimo 3%).</div>'}
        </div>
      </div>`;
  },

  trend() {
    const { prediction: p, match: m } = state.detail;
    const rows = p.trends.rows.filter((r) => r.group === state.trendTf);
    const idxLabels = new Set(p.trends.index.map((r) => r.label));
    const n = rows[0]?.n || 0;
    const cell = (v) => (v == null ? '<td class="r muted">–</td>' : `<td class="r num"><span class="pbar" style="--w:${(v * 100).toFixed(0)}%"></span>${pct(v)}</td>`);
    return `
      <div class="filters"><div class="seg">${['FT', 'PT'].map((t) => `<button class="${state.trendTf === t ? 'active' : ''}" data-ttf="${t}">${t === 'FT' ? 'Finale' : '1° tempo'}</button>`).join('')}</div>
        <span class="chip stat">Archivio: <b>${n}</b> partite con quote simili${p.archive ? ` (${p.archive.sameLeague} stesso campionato)` : ''}</span></div>
      <div class="card"><table class="t trend">
        <tr><th>Mercato</th><th class="r">Modello</th><th class="r">Archivio</th><th class="r">Diff.</th><th class="r">Quota giusta</th>${m.ft ? '<th class="r">Esito</th>' : ''}</tr>
        ${rows.map((r) => {
    const d = r.archive == null ? null : r.model - r.archive;
    const hit = m.ft ? trendHit(r.label, m.ft, m.ht) : null;
    return `<tr class="${idxLabels.has(r.label) ? 'me' : ''}"><td>${esc(r.label)}${idxLabels.has(r.label) ? ' <span class="badge conf-alta">indice</span>' : ''}</td>
            ${cell(r.model)}${cell(r.archive)}
            <td class="r num" style="color:${d != null && Math.abs(d) > 0.05 ? 'var(--warn)' : 'var(--muted-foreground)'}">${d == null ? '–' : (d * 100).toFixed(1)}</td>
            <td class="r num">${odd(r.archive == null ? r.model : (r.model + r.archive) / 2)}</td>
            ${m.ft ? `<td class="r">${hit == null ? '–' : hit ? '<span class="ok">✔</span>' : '<span class="ko">✘</span>'}</td>` : ''}</tr>`;
  }).join('')}
      </table>
      <div class="note">Archivio = come sono finite le partite passate con quote simili.</div></div>`;
  },

  ht() {
    const p = state.detail.prediction;
    const m = state.detail.match;
    return `
      <div class="cards">
        <div class="card wide"><h3>Esito 1° tempo</h3>${tri(p.ht.x12, ['1 PT', 'X PT', '2 PT'])}</div>
        <div class="card"><h3>Under / Over 1° tempo</h3>${bars(ouItems(p.ht.over, ' PT'), { hl: (i) => i.p >= 0.5 })}</div>
        <div class="card"><h3>Multigol 1° tempo</h3>${bars(p.ht.multigol.map((x) => ({ label: `MG PT ${x.range}`, p: x.p })), { alt: true })}</div>
        <div class="card"><h3>Goal / No Goal 1° tempo</h3>${bars([{ label: 'Goal PT', p: p.ht.btts.yes }, { label: 'No Goal PT', p: p.ht.btts.no },
    { label: `Segna ${m.home}`, p: p.ht.teamOver.home[0.5] }, { label: `Segna ${m.away}`, p: p.ht.teamOver.away[0.5] }])}</div>
        <div class="card"><h3>Risultato esatto 1° tempo</h3>${bars(p.ht.exact.slice(0, 6).map((e) => ({ label: e.score, p: e.p })), { alt: true, hl: (i) => m.ht && i.label === `${m.ht[0]}-${m.ht[1]}` })}</div>
        <div class="card"><h3>2° tempo</h3>${bars([...ouItems(p.secondHalf.over, ' ST').slice(0, 4),
    { label: '1 ST', p: p.secondHalf.x12.home }, { label: 'X ST', p: p.secondHalf.x12.draw }, { label: '2 ST', p: p.secondHalf.x12.away }])}</div>
        <div class="card"><h3>Tempo con più goal</h3>${bars([{ label: '1° tempo', p: p.halves.first }, { label: 'Uguale', p: p.halves.equal }, { label: '2° tempo', p: p.halves.second }])}</div>
        <div class="card wide"><h3>Mappa risultato 1° tempo</h3>${heatmap(p.ht.matrix, m.ht)}</div>
      </div>
      <div class="note">Quota di goal nel 1° tempo (${esc(p.inputs.htShareSource)}): casa ${pct(p.inputs.htShare[0])}, ospite ${pct(p.inputs.htShare[1])} dei goal totali.</div>`;
  },

  mg() {
    const p = state.detail.prediction;
    const m = state.detail.match;
    const tot = m.ft ? m.ft[0] + m.ft[1] : null;
    const inRange = (r, n) => {
      if (n === null) return false;
      if (r.endsWith('+')) return n >= parseInt(r, 10);
      const [a, b] = r.split('-').map(Number);
      return n >= a && n <= b;
    };
    return `
      <div class="cards">
        <div class="card"><h3>Multigol finale</h3>${bars(p.ft.multigol.map((x) => ({ label: `MG ${x.range}`, p: x.p, r: x.range })), { hl: (i) => inRange(i.r, tot) })}</div>
        <div class="card"><h3>Multigol ${esc(m.home)}</h3>${bars(p.ft.multigolHome.map((x) => ({ label: `Casa ${x.range}`, p: x.p })), { alt: true })}
          <h3 style="margin-top:16px">Multigol ${esc(m.away)}</h3>${bars(p.ft.multigolAway.map((x) => ({ label: `Osp. ${x.range}`, p: x.p })), { alt: true })}</div>
        <div class="card"><h3>Somma goal</h3>${bars(p.ft.totals.map((x) => ({ label: `${x.goals} goal`, p: x.p })), { hl: (i) => tot !== null && (i.label === `${tot} goal` || (tot >= 7 && i.label === '7+ goal')) })}</div>
        <div class="card"><h3>Goal per squadra</h3>${bars([
    { label: `${m.home} O0.5`, p: p.ft.teamOver.home[0.5] }, { label: `${m.home} O1.5`, p: p.ft.teamOver.home[1.5] }, { label: `${m.home} O2.5`, p: p.ft.teamOver.home[2.5] },
    { label: `${m.away} O0.5`, p: p.ft.teamOver.away[0.5] }, { label: `${m.away} O1.5`, p: p.ft.teamOver.away[1.5] }, { label: `${m.away} O2.5`, p: p.ft.teamOver.away[2.5] },
    { label: `Clean sheet ${m.home}`, p: p.ft.cleanSheet.home }, { label: `Clean sheet ${m.away}`, p: p.ft.cleanSheet.away }])}</div>
      </div>`;
  },

  cs() {
    const p = state.detail.prediction;
    const m = state.detail.match;
    const a = p.archive;
    return `
      <div class="cards">
        <div class="card wide"><h3>Mappa risultato esatto finale</h3>${heatmap(p.ft.matrix, m.ft)}</div>
        <div class="card"><h3>Top 10 risultati (modello)</h3>${bars(p.ft.exact.map((e) => ({ label: e.score, p: e.p })), { alt: true, hl: (i) => m.ft && i.label === `${m.ft[0]}-${m.ft[1]}` })}</div>
        ${a ? `<div class="card"><h3>Più frequenti con quote simili</h3>${bars(a.ft.exact.map((e) => ({ label: e.score, p: e.p })), { odds: false })}
          <div class="note">Su ${a.n} partite storiche con profilo di quota simile.</div></div>` : ''}
      </div>`;
  },

  htft() {
    const p = state.detail.prediction;
    const m = state.detail.match;
    const actual = m.ft && m.ht ? `${k3(m.ht)}/${k3(m.ft)}` : null;
    const items = Object.entries(p.htft).map(([k, v]) => ({ label: k, p: v })).sort((x, y) => y.p - x.p);
    return `
      <div class="cards">
        <div class="card"><h3>Parziale / Finale</h3>${bars(items, { hl: (i) => i.label === actual })}</div>
        ${p.archive?.htft ? `<div class="card"><h3>Archivio quote simili</h3>${bars(items.map((i) => ({ label: i.label, p: p.archive.htft[i.label] || 0 })), { odds: false, alt: true })}
          <div class="note">${p.archive.nHt} partite storiche con parziale disponibile.</div></div>` : ''}
      </div>`;
  },

  asian() {
    const { prediction: p, odds } = state.detail;
    const L = odds.labels;
    const bookCols = (g) => (g ? ['ps', 'sbo', 'b188', 'dafa', 'b365', 'avg'].filter((b) => g[b]).map((b) => `${esc(L[b])} ${fx(g[b][0])}/${fx(g[b][1])}`).join(' · ') : '');
    const value = (fair, g, i) => {
      if (!g) return '';
      const best = Math.max(...Object.entries(g).filter(([k, v]) => k !== 'line' && k !== 'avg' && Array.isArray(v)).map(([, v]) => v[i]));
      return Number.isFinite(best) && best > fair * 1.03 ? ' <span class="edge">value</span>' : '';
    };
    return `
      <div class="cards">
        <div class="card wide"><h3>Handicap asiatico · quote giuste del modello</h3>
          <table class="t"><tr><th>Linea casa</th><th class="r">Casa</th><th class="r">Ospite</th><th class="r">P(casa)</th><th>Bookmaker (casa/ospite)</th></tr>
          ${p.ahTable.map((r) => `<tr class="${p.ah?.line === r.line ? 'me' : ''}"><td class="num"><b>${sgn(r.line)}</b>${p.ah?.line === r.line ? ' <span class="badge conf-media">linea principale</span>' : ''}</td>
            <td class="r num">${fx(r.fairHome)}${value(r.fairHome, r.books, 0)}</td><td class="r num">${fx(r.fairAway)}${value(r.fairAway, r.books, 1)}</td>
            <td class="r num">${pct(r.pHome)}</td><td class="small">${bookCols(r.books) || '<span class="muted">non quotata</span>'}</td></tr>`).join('')}
          </table></div>
        <div class="card wide"><h3>Over/Under e total asiatico · quote giuste del modello</h3>
          <table class="t"><tr><th>Linea</th><th class="r">Over</th><th class="r">Under</th><th class="r">P(over)</th><th>Bookmaker (over/under)</th></tr>
          ${p.ouTable.map((r) => `<tr class="${p.totalLine?.line === r.line ? 'me' : ''}"><td class="num"><b>${r.line}</b>${p.totalLine?.line === r.line ? ' <span class="badge conf-media">linea principale</span>' : ''}</td>
            <td class="r num">${fx(r.fairOver)}${value(r.fairOver, r.books, 0)}</td><td class="r num">${fx(r.fairUnder)}${value(r.fairUnder, r.books, 1)}</td>
            <td class="r num">${pct(r.pOver)}</td><td class="small">${bookCols(r.books) || '<span class="muted">non quotata</span>'}</td></tr>`).join('')}
          </table>
          </div>
      </div>`;
  },

  odds() {
    const { odds, prediction: p, move } = state.detail;
    const L = odds.labels;
    const BOOKS = ['ps', 'sbo', 'b188', 'dafa', 'bfe', 'bf', 'b365', 'x1', 'mara', 'wh', 'bwin', 'unibet', 'b10', 'betway', 'iw', 'avg', 'max'];
    const rows = (g, n) => (g ? BOOKS.filter((b) => g[b]).map((b) => `<tr class="${b === 'avg' || b === 'max' ? 'agg' : ''}"><td>${esc(L[b] || b)}</td>${g[b].map((o) => `<td class="r num">${fx(o)}</td>`).join('')}
      ${n === 3 || n === 2 ? `<td class="r num muted">${pct(g[b].reduce((s, o) => s + 1 / o, 0) - 1, 1)}</td>` : ''}</tr>`).join('') : '');
    const table = (title, g, heads) => (g ? `<div class="card"><h3>${title}</h3><table class="t"><tr><th>Bookmaker</th>${heads.map((h) => `<th class="r">${h}</th>`).join('')}<th class="r">Aggio</th></tr>${rows(g, heads.length)}</table></div>` : '');
    const strip = (g) => (g ? Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'line')) : null);
    const mi = p.inputs;
    const mvRow = (label, o, c, fmt) => (c ? `<tr><td>${label}</td><td class="r num">${o ? fmt(o) : '–'}</td><td class="r num"><b>${fmt(c)}</b></td><td class="muted small">${esc(c.book || '')}</td></tr>` : '');
    const fx12 = (x) => x.odds.map((v) => fx(v)).join(' / ');
    const fln = (x) => `${sgn(x.line)} @ ${fx(x.odds[0])} / ${fx(x.odds[1])}`;
    const ftot = (x) => `${x.line} @ ${fx(x.odds[0])} / ${fx(x.odds[1])}`;
    return `
      <div class="cards">
        ${move?.cur ? `<div class="card wide"><h3>Movimento quote (apertura → attuale)</h3><table class="t">
          <tr><th>Mercato</th><th class="r">Apertura</th><th class="r">Attuale</th><th>Book</th></tr>
          ${mvRow('1 / X / 2', move.open?.x12, move.cur.x12, fx12)}${mvRow('Handicap asiatico', move.open?.ah, move.cur.ah, fln)}${mvRow('Total', move.open?.ou, move.cur.ou, ftot)}
          </table>${move.updated ? `<div class="note">Ultimo aggiornamento quote: ${new Date(move.updated).toLocaleString('it-IT')}</div>` : ''}</div>` : ''}
        ${table('1X2 finale', odds.x12, ['1', 'X', '2'])}
        ${odds.closing.x12 ? table('1X2 chiusura', odds.closing.x12, ['1', 'X', '2']) : ''}
        ${table(`Handicap asiatico ${sgn(odds.ah?.line)}`, strip(odds.ah), ['Casa', 'Ospite'])}
        ${odds.ouMain ? table(`Total ${odds.ouMain.line}`, strip(odds.ouMain), ['Over', 'Under']) : table('Under/Over 2.5', odds.ou25, ['Over', 'Under'])}
        ${table('Goal / No Goal', odds.btts, ['Goal', 'No Goal'])}
        ${table('1X2 primo tempo', odds.ht1x2, ['1', 'X', '2'])}
        <div class="card"><h3>Goal attesi: da dove arrivano</h3>
          <div class="kv">
            ${mi.market ? `<span class="k">Mercato (${esc(mi.market.x12?.book || '')})</span><span class="num">${fx(mi.market.lh)} – ${fx(mi.market.la)}</span>` : ''}
            ${mi.model ? `<span class="k">Rating (${esc(mi.model.pool)})</span><span class="num">${fx(mi.model.lh)} – ${fx(mi.model.la)}</span>` : '<span class="k">Rating squadre</span><span class="muted">non disponibili</span>'}
            <span class="k"><b>Finale</b></span><span class="num"><b>${fx(mi.final.lh)} – ${fx(mi.final.la)}</b></span>
          </div>
        </div>
        ${p.archive ? `<div class="card wide"><h3>Partite storiche più simili</h3>
          <table class="t"><tr><th>Data</th><th>Partita</th><th class="r">1 / X / 2</th><th class="r">Over 2.5</th><th class="r">PT</th><th class="r">FT</th></tr>
          ${p.archive.examples.map((e) => `<tr class="click" data-goto="${esc(e.id)}"><td class="num">${fmtDateLong(e.date)}</td><td>${esc(e.home)} – ${esc(e.away)} <small class="muted">${esc(leagueBy(e.league).name)}</small></td>
            <td class="r num">${pct(e.profile.h)} / ${pct(e.profile.d)} / ${pct(e.profile.a)}</td><td class="r num">${pct(e.profile.o)}</td>
            <td class="r num">${e.ht ? e.ht.join('-') : '–'}</td><td class="r num"><b>${e.ft.join('-')}</b></td></tr>`).join('')}
          </table></div>` : ''}
        ${!odds.x12 ? '<div class="card wide"><div class="note">Quote non ancora disponibili.</div></div>' : ''}
      </div>`;
  },

  form() {
    const { form, h2h, match: m } = state.detail;
    const formTable = (list, team) => (list.length ? `
      <div class="form" style="margin-bottom:8px">${list.map((x) => `<i class="${x.result}">${x.result}</i>`).join('')}</div>
      <table class="t">${list.map((x) => `<tr class="click" data-goto="${esc(x.id)}"><td class="num">${fmtDate(x.date)}</td>
        <td style="${x.home === team ? 'font-weight:600' : ''}">${esc(x.home)}</td><td class="r num"><b>${x.ft.join('-')}</b></td>
        <td style="${x.away === team ? 'font-weight:600' : ''}">${esc(x.away)}</td><td class="r num muted">${x.ht ? `(${x.ht.join('-')})` : ''}</td>
        <td class="muted small">${esc(x.leagueName || '')}</td></tr>`).join('')}</table>`
      : '<div class="note">Nessuna partita precedente negli archivi.</div>');
    return `
      <div class="cards">
        <div class="card wide"><h3>Ultime ${esc(m.home)}</h3>${formTable(form.home, m.home)}</div>
        <div class="card wide"><h3>Ultime ${esc(m.away)}</h3>${formTable(form.away, m.away)}</div>
        <div class="card wide"><h3>Scontri diretti</h3>
          ${h2h.length ? `<table class="t">${h2h.map((x) => `<tr class="click" data-goto="${esc(x.id)}"><td class="num">${fmtDateLong(x.date)}</td><td>${esc(x.home)}</td>
            <td class="r num"><b>${x.ft.join('-')}</b></td><td>${esc(x.away)}</td><td class="r num muted">${x.ht ? `(${x.ht.join('-')})` : ''}</td><td class="muted small">${esc(x.leagueName || '')}</td></tr>`).join('')}</table>`
    : '<div class="note">Nessun precedente negli archivi.</div>'}
        </div>
        ${m.stats ? `<div class="card wide"><h3>Statistiche partita</h3><div class="kv">
          ${Object.entries({ shots: 'Tiri', sot: 'Tiri in porta', corners: 'Calci d\'angolo', yellow: 'Ammonizioni', red: 'Espulsioni' })
      .filter(([k]) => m.stats[k]).map(([k, n]) => `<span class="k">${n}</span><span class="num">${m.stats[k][0]} – ${m.stats[k][1]}</span>`).join('')}
        </div></div>` : ''}
      </div>`;
  },

  table() {
    const { standings, match: m } = state.detail;
    if (!standings.length) return '<div class="empty">Classifica non disponibile.</div>';
    return `<div class="card"><table class="t">
      <tr><th>#</th><th>Squadra</th><th class="r">G</th><th class="r">V</th><th class="r">N</th><th class="r">P</th><th class="r">GF:GS</th><th class="r">DR</th><th class="r">Pt</th><th class="r">Forma</th></tr>
      ${standings.map((r, i) => { const side = r.team === (m.homeKey || m.home) ? 'Casa' : r.team === (m.awayKey || m.away) ? 'Trasf.' : ''; return `<tr class="${side ? 'me' : ''}"><td class="num">${i + 1}</td><td>${side ? `<b>${esc(r.team)}</b> <span class="me-tag">${side}</span>` : esc(r.team)}</td>
        <td class="r num">${r.p}</td><td class="r num">${r.w}</td><td class="r num">${r.d}</td><td class="r num">${r.l}</td><td class="r num">${r.gf}:${r.ga}</td>
        <td class="r num">${r.gd > 0 ? '+' : ''}${r.gd}</td><td class="r num"><b>${r.pts}</b></td>
        <td class="r"><span class="form">${r.form.map((f) => `<i class="${f}">${f}</i>`).join('')}</span></td></tr>`; }).join('')}
    </table></div>`;
  },
};

const k3 = ([h, a]) => (h > a ? '1' : h === a ? 'X' : '2');

/** Short written prediction built from the numbers of this match. */
function verdict(p, m) {
  const H = esc(m.home), A = esc(m.away);
  const x = p.ft.x12;
  const [gh, ga] = p.expected.xg;
  const tot = gh + ga;
  const o25 = p.ft.over['2.5'];
  const gg = p.ft.btts.yes;
  const ht05 = p.ht?.over?.['0.5'];
  const SIMPLE = { 1: `vittoria ${H}`, X: 'pareggio', 2: `vittoria ${A}`, '1X': 'doppia chance 1X', X2: 'doppia chance X2', 12: 'doppia chance 12' };
  const nice = (l) => SIMPLE[l] || esc(String(l).replace(/^MG PT /, 'Multigol 1° tempo ').replace(/^MG /, 'Multigol ').replace(/ PT$/, ' 1° tempo'));
  const s = [];

  const homeFav = x.home >= x.away;
  const fav = homeFav ? H : A, other = homeFav ? A : H, pf = homeFav ? x.home : x.away;
  if (x.draw >= Math.max(x.home, x.away)) s.push(`Partita molto equilibrata: il pareggio è l'esito più probabile (${pct(x.draw)}).`);
  else if (pf >= 0.6) s.push(`<b>${fav}</b> è nettamente favorito (${pct(pf)})${homeFav ? '' : ' anche in trasferta'}.`);
  else if (pf >= 0.45) s.push(`<b>${fav}</b> parte favorito (${pct(pf)}), ma ${other} può strappare un risultato: ${homeFav ? 'X2' : '1X'} al ${pct(1 - pf)}.`);
  else s.push(`Partita aperta: ${H} ${pct(x.home)}, pareggio ${pct(x.draw)}, ${A} ${pct(x.away)}.`);

  if (o25 >= 0.6) s.push(`Ci si aspettano goal: circa ${fx(tot, 1)} reti, Over 2.5 al ${pct(o25)}.`);
  else if (o25 <= 0.42) s.push(`Pochi goal previsti (circa ${fx(tot, 1)}): Under 2.5 al ${pct(1 - o25)}.`);
  else s.push(`Sui goal è in bilico: circa ${fx(tot, 1)} reti attese, Over 2.5 al ${pct(o25)}.`);

  if (gg >= 0.58) s.push(`Entrambe dovrebbero segnare (Goal ${pct(gg)}).`);
  else if (gg <= 0.42) s.push(`${gh < ga ? H : A} fatica a trovare la porta: No Goal al ${pct(1 - gg)}.`);

  if (ht05 != null && ht05 >= 0.75) s.push(`Probabile almeno un goal già nel primo tempo (${pct(ht05)}).`);
  else if (ht05 != null && ht05 <= 0.6) s.push(`Primo tempo bloccato: 0-0 all'intervallo al ${pct(1 - ht05)}.`);

  const best = p.trends.index[0];
  if (best) s.push(`La scelta più solida è <b>${nice(best.label)}${best.group === 'PT' && !/PT|1° tempo/.test(best.label) ? ' (1° tempo)' : ''}</b> (${pct(best.score)}); risultato più probabile ${esc(p.expected.ft.score)}.`);
  else s.push(`Risultato più probabile ${esc(p.expected.ft.score)}.`);

  const v = m.status !== 'FT' && p.value[0];
  if (v) s.push(`Da tenere d'occhio: ${v.market === '1X2' ? nice(v.selection) : `${esc(v.market)} ${esc(v.selection)}`} a ${fx(v.odds)} (valore +${pct(v.edge, 1)}).`);
  if (p.confidence === 'bassa') s.push('<span class="muted">Dati limitati: pronostico meno affidabile.</span>');
  return s.join(' ');
}

// ---------------------------------------------------------------- search & boot
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#search-results');
  if (q.length < 2) { box.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = res.length ? res.map((m) => `<div class="sr" data-id="${esc(m.id)}"><span class="d num">${fmtDateLong(m.date)}</span>
      <span>${esc(m.home)} – ${esc(m.away)} ${m.ft ? `<b class="num">${m.ft.join('-')}</b>` : `<span class="muted">${esc(m.time)}</span>`}<br><small class="muted">${esc(m.leagueName || '')}</small></span></div>`).join('')
      : '<div class="sr">Nessun risultato</div>';
    box.hidden = false;
    box.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => { box.hidden = true; e.target.value = ''; location.hash = `#/m/${encodeURIComponent(el.dataset.id)}`; }));
  }, 200);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#search-results').hidden = true; });
$('#league-filter').addEventListener('input', renderSidebar);
$('#detail-backdrop').addEventListener('click', () => closeDetail());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detail').hidden) closeDetail(); });
// Small, non-blocking messages at the bottom of the screen.
let toastTimer;
function toast(msg, { busy = false, ms = 2600 } = {}) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.innerHTML = `${busy ? '<span class="spinner"></span>' : ''}${esc(msg)}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (!busy) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

$('#refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true; b.classList.add('spin');
  toast('Aggiornamento in corso…', { busy: true });
  try {
    if (STATIC) {
      // Online version: data is rebuilt on a schedule, here we only pick up the latest build.
      const s = await api('/api/status', { cache: 'no-store' });
      if (s.builtAt === state.status?.builtAt) { toast('Dati già aggiornati'); return; }
    } else await api('/api/refresh', { method: 'POST' });
    await reloadAll();
    toast('Dati aggiornati');
  } catch {
    toast('Aggiornamento non riuscito, riprova tra poco');
  } finally { b.disabled = false; b.classList.remove('spin'); }
});

async function reloadAll() {
  [state.leagues, state.dates, state.status] = await Promise.all([api('/api/leagues'), api('/api/dates'), api('/api/status')]);
  dayCache.clear();
  const y = window.scrollY;
  // Keep the current list on screen until the fresh data for the same day is ready (no blank flash).
  if (state.date) state.data = await fetchDay(state.date).catch(() => null);
  state.detail = null;
  await route();
  window.scrollTo(0, y); // a background refresh must not move the page
}

// While API-Football syncs in the background, poll and refresh the list when it is done.
let wasSyncing = false;
if (!STATIC) setInterval(async () => {
  try {
    const s = await api('/api/status');
    const syncing = s.apiFootball.syncing;
    if (wasSyncing && !syncing && $('#detail').hidden) { await reloadAll(); toast('Quote aggiornate'); }
    else state.status = s;
    wasSyncing = syncing;
  } catch { /* server restarting */ }
}, 15000);

// Back to top: follows whichever container is scrolling (page or the match sheet).
const toTop = $('#to-top');
const activeScroller = () => ($('#detail').hidden ? document.scrollingElement : $('#detail'));
const updateToTop = () => { toTop.classList.toggle('show', activeScroller().scrollTop > 480); };
window.addEventListener('scroll', updateToTop, { passive: true });
$('#detail').addEventListener('scroll', updateToTop, { passive: true });
toTop.addEventListener('click', () => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  activeScroller().scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
});
new MutationObserver(updateToTop).observe($('#detail'), { attributes: true, attributeFilter: ['hidden'] });

// Theme: saved choice, else system preference (applied before paint in index.html).
const setThemeColor = () => document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.body).backgroundColor);
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  setThemeColor();
});
setThemeColor();

// Competitions drawer (mobile)
const closeNav = () => document.body.classList.remove('nav-open');
$('#menu').addEventListener('click', () => document.body.classList.add('nav-open'));
$('#menu-close').addEventListener('click', closeNav);
$('#nav-backdrop').addEventListener('click', closeNav);
$('#leagues').addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });

window.addEventListener('hashchange', () => { closeNav(); route(); });
(async () => {
  [state.leagues, state.dates, state.status] = await Promise.all([api('/api/leagues'), api('/api/dates'), api('/api/status')]);
  wasSyncing = state.status.apiFootball.syncing;
  await route();
})();
