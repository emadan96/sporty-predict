// Fuzzy matching of API-Football team names to football-data names (which use abbreviations).

const STOP = new Set(['fc', 'cf', 'ac', 'afc', 'sc', 'ssc', 'as', 'us', 'calcio', 'club', 'de', 'cd', 'ud', 'sd', 'rc', 'rcd', 'fk', 'sk', 'bk', 'ff', 'sv',
  'vfb', 'vfl', 'tsg', 'fsv', 'bsc', '1', 'ca', 'cr', 'se', 'ec', 'ad', 'aa', 'the', 'and']);

// API name (normalized) -> football-data name
const ALIASES = {
  'manchester united': 'Man United', 'manchester city': 'Man City', 'nottingham forest': "Nott'm Forest",
  'wolverhampton wanderers': 'Wolves', 'wolves': 'Wolves', 'sheffield wednesday': 'Sheffield Weds', 'sheffield utd': 'Sheffield United',
  'queens park rangers': 'QPR', 'west bromwich albion': 'West Brom', 'brighton hove albion': 'Brighton', 'tottenham hotspur': 'Tottenham',
  'paris saint germain': 'Paris SG', 'saint etienne': 'St Etienne', 'bayern munchen': 'Bayern Munich', 'bayern munich': 'Bayern Munich',
  'borussia monchengladbach': "M'gladbach", 'eintracht frankfurt': 'Ein Frankfurt', '1 fc koln': 'FC Koln', 'fc koln': 'FC Koln',
  'athletic club': 'Ath Bilbao', 'athletic bilbao': 'Ath Bilbao', 'atletico madrid': 'Ath Madrid', 'real sociedad': 'Sociedad',
  'celta vigo': 'Celta', 'rayo vallecano': 'Vallecano', 'espanyol': 'Espanol', 'real betis': 'Betis', 'deportivo alaves': 'Alaves',
  'ac milan': 'Milan', 'inter': 'Inter', 'as roma': 'Roma', 'hellas verona': 'Verona', 'bayer leverkusen': 'Leverkusen',
  'borussia dortmund': 'Dortmund', 'sporting cp': 'Sp Lisbon', 'sporting lisbon': 'Sp Lisbon', 'sc braga': 'Sp Braga', 'braga': 'Sp Braga',
  'vitoria guimaraes': 'Guimaraes', 'olympiakos piraeus': 'Olympiakos', 'psv eindhoven': 'PSV Eindhoven', 'az alkmaar': 'AZ Alkmaar',
  'union st gilloise': 'St. Gilloise', 'union saint gilloise': 'St. Gilloise', 'club brugge kv': 'Club Brugge', 'stade brestois 29': 'Brest',
  'mainz 05': 'Mainz', 'fc st pauli': 'St Pauli', 'st pauli': 'St Pauli', 'heidenheim': 'Heidenheim', '1899 hoffenheim': 'Hoffenheim',
};

export function normName(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/ß/g, 'ss')
    .replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const tokens = (s) => normName(s).split(' ').filter((t) => t && !STOP.has(t));

function bigrams(s) {
  const x = s.replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, n = 0;
  for (const [g, c] of A) { n += c; inter += Math.min(c, B.get(g) || 0); }
  for (const c of B.values()) n += c;
  return n ? (2 * inter) / n : 0;
}

export function similarity(api, fd) {
  const a = tokens(api), b = tokens(fd);
  if (!a.length || !b.length) return 0;
  const ja = a.join(' '), jb = b.join(' ');
  if (ja === jb) return 1;
  // abbreviations like "Ath", "Sp", "Weds": prefix-match tokens
  const pref = (x, y) => x.startsWith(y) || y.startsWith(x);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const covered = short.filter((t) => long.some((u) => pref(t, u))).length / short.length;
  return Math.max(covered * 0.92, dice(ja, jb));
}

/** Build { apiName -> fdName } for one league given both name lists. One-to-one, best scores first. */
export function matchTeams(apiNames, fdNames) {
  const fdSet = new Set(fdNames);
  const pairs = [];
  for (const a of apiNames) {
    const alias = ALIASES[normName(a)];
    if (alias && fdSet.has(alias)) { pairs.push({ a, f: alias, s: 2 }); continue; }
    for (const f of fdNames) {
      const s = similarity(a, f);
      if (s >= 0.6) pairs.push({ a, f, s });
    }
  }
  pairs.sort((x, y) => y.s - x.s);
  const map = new Map(), used = new Set();
  for (const { a, f } of pairs) {
    if (map.has(a) || used.has(f)) continue;
    map.set(a, f); used.add(f);
  }
  return map;
}
