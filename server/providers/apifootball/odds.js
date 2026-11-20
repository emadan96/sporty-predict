// Parse API-Football pre-match odds (bookmakers[].bets[].values[]) into the app's compact format:
// { x12:{book:[1,X,2]}, ou:{'2.5':{book:[o,u]}}, ouMain:{line, book:[o,u]}, ou25, ah:{line, book:[h,a]},
//   ahLines:{'-0.75':{book:[h,a]}}, ht1x2, htou:{'0.5':{...}}, btts:{book:[yes,no]}, dc }

const BOOK_KEYS = [
  [/pinnacle/i, 'ps'], [/bet365/i, 'b365'], [/^betfair/i, 'bf'], [/sport betting online|sbobet|^sbo/i, 'sbo'],
  [/188/i, 'b188'], [/dafabet/i, 'dafa'], [/1xbet/i, 'x1'], [/marathon/i, 'mara'], [/william hill/i, 'wh'],
  [/bwin/i, 'bwin'], [/unibet/i, 'unibet'], [/10bet/i, 'b10'], [/betway/i, 'betway'], [/interwetten/i, 'iw'],
];
// Books whose prices drive the model (Asian / sharp books first).
export const SHARP_ORDER = ['ps', 'sbo', 'b188', 'dafa', 'bfe', 'avg', 'b365', 'x1', 'max'];

export function bookKey(name) {
  for (const [re, k] of BOOK_KEYS) if (re.test(name)) return k;
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

const num = (x) => {
  const n = parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const lineKey = (x) => String(Math.round(x * 100) / 100);

function threeWay(values) {
  const get = (n) => num(values.find((v) => String(v.value).toLowerCase() === n)?.odd);
  const o = [get('home'), get('draw'), get('away')];
  return o.every((x) => x && x > 1) ? o : null;
}

function overUnder(values) {
  const lines = {};
  for (const v of values) {
    const m = /^(over|under)\s*([\d.]+)?/i.exec(String(v.value));
    if (!m) continue;
    const line = num(m[2] ?? v.handicap);
    const odd = num(v.odd);
    if (line == null || !odd || odd <= 1) continue;
    const k = lineKey(line);
    lines[k] = lines[k] || [null, null];
    lines[k][m[1].toLowerCase() === 'over' ? 0 : 1] = odd;
  }
  for (const k of Object.keys(lines)) if (!lines[k][0] || !lines[k][1]) delete lines[k];
  return lines;
}

/** Asian handicap: returns { [homeLine]: [homeOdd, awayOdd] }. Handles "Home -1"/"Away +1" and handicap fields. */
function asianLines(values) {
  const home = new Map(), away = new Map();
  for (const v of values) {
    const m = /^(home|away)\s*([+-]?[\d.]+)?/i.exec(String(v.value));
    if (!m) continue;
    const line = num(m[2] ?? v.handicap);
    const odd = num(v.odd);
    if (line == null || !odd || odd <= 1) continue;
    (m[1].toLowerCase() === 'home' ? home : away).set(lineKey(line), odd);
  }
  // Convention detection. API-Football writes the away side with the HOME line ("Home -1.25" / "Away -1.25"),
  // other feeds mirror it ("Away +1.25"). With symmetric ladders both pairings exist, so pick the one whose
  // pairs look like real two-way markets (sum of implied probabilities ~1.02-1.10).
  const build = (mirror) => {
    const out = {};
    for (const [k, oh] of home) {
      const oa = away.get(mirror ? lineKey(-Number(k)) : k);
      if (oa) out[k] = [oh, oa];
    }
    return out;
  };
  const badness = (pairs) => {
    const xs = Object.entries(pairs).filter(([k]) => Number(k) !== 0).map(([, [a, b]]) => Math.abs(1 / a + 1 / b - 1.05));
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Infinity;
  };
  const same = build(false), mirror = build(true);
  return badness(same) <= badness(mirror) ? same : mirror;
}

const mainLine = (lines) => {
  let best = null;
  for (const [k, [a, b]] of Object.entries(lines)) {
    const d = Math.abs(1 / a - 1 / b);
    if (!best || d < best.d) best = { k, d };
  }
  return best?.k ?? null;
};

function aggregate(perBook, size) {
  // perBook: { book: odds[] } -> adds avg and max
  const books = Object.values(perBook);
  if (!books.length) return null;
  const avg = [], max = [];
  for (let i = 0; i < size; i++) {
    const xs = books.map((o) => o[i]).filter(Boolean);
    avg.push(+(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3));
    max.push(Math.max(...xs));
  }
  return { ...perBook, avg, max };
}

const pickSharp = (group) => SHARP_ORDER.find((b) => group?.[b]);

export function parseOdds(bookmakers = []) {
  const x12 = {}, ht1x2 = {}, btts = {};
  const ou = {}, htou = {}, ah = {};
  for (const bm of bookmakers) {
    const b = bookKey(bm.name);
    for (const bet of bm.bets || []) {
      const name = bet.name;
      if (name === 'Match Winner') { const o = threeWay(bet.values); if (o) x12[b] = o; }
      else if (name === 'First Half Winner') { const o = threeWay(bet.values); if (o) ht1x2[b] = o; }
      else if (name === 'Both Teams Score') {
        const y = num(bet.values.find((v) => v.value === 'Yes')?.odd), n = num(bet.values.find((v) => v.value === 'No')?.odd);
        if (y > 1 && n > 1) btts[b] = [y, n];
      } else if (name === 'Goals Over/Under') {
        for (const [k, o] of Object.entries(overUnder(bet.values))) (ou[k] = ou[k] || {})[b] = o;
      } else if (name === 'Goals Over/Under First Half') {
        for (const [k, o] of Object.entries(overUnder(bet.values))) (htou[k] = htou[k] || {})[b] = o;
      } else if (name === 'Asian Handicap') {
        for (const [k, o] of Object.entries(asianLines(bet.values))) (ah[k] = ah[k] || {})[b] = o;
      }
    }
  }
  const out = {};
  if (Object.keys(x12).length) out.x12 = aggregate(x12, 3);
  if (Object.keys(ht1x2).length) out.ht1x2 = aggregate(ht1x2, 3);
  if (Object.keys(btts).length) out.btts = aggregate(btts, 2);
  if (Object.keys(ou).length) {
    out.ou = Object.fromEntries(Object.entries(ou).map(([k, g]) => [k, aggregate(g, 2)]));
    if (out.ou['2.5']) out.ou25 = out.ou['2.5'];
    // main (balanced) total line according to the sharpest book that prices most lines
    const ref = SHARP_ORDER.find((b) => Object.values(ou).some((g) => g[b])) || 'avg';
    const refLines = Object.fromEntries(Object.entries(out.ou).filter(([, g]) => g[ref]).map(([k, g]) => [k, g[ref]]));
    const k = mainLine(refLines);
    if (k) out.ouMain = { line: Number(k), ...out.ou[k] };
  }
  if (Object.keys(htou).length) out.htou = Object.fromEntries(Object.entries(htou).map(([k, g]) => [k, aggregate(g, 2)]));
  if (Object.keys(ah).length) {
    out.ahLines = Object.fromEntries(Object.entries(ah).map(([k, g]) => [k, aggregate(g, 2)]));
    const ref = SHARP_ORDER.find((b) => Object.values(ah).some((g) => g[b])) || 'avg';
    const refLines = Object.fromEntries(Object.entries(out.ahLines).filter(([, g]) => g[ref]).map(([k, g]) => [k, g[ref]]));
    const k = mainLine(refLines);
    if (k) out.ah = { line: Number(k), ...out.ahLines[k] };
  }
  return Object.keys(out).length ? out : null;
}

/** Small snapshot used to show opening -> current movement. */
export function snapshot(o) {
  if (!o) return null;
  const b = (g) => pickSharp(g);
  return {
    x12: o.x12 ? { book: b(o.x12), odds: o.x12[b(o.x12)], avg: o.x12.avg } : null,
    ah: o.ah ? { line: o.ah.line, book: b(o.ah), odds: o.ah[b(o.ah)] } : null,
    ou: o.ouMain ? { line: o.ouMain.line, book: b(o.ouMain), odds: o.ouMain[b(o.ouMain)] } : null,
  };
}
