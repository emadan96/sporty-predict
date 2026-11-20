import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data', 'raw');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const PORT = Number(process.env.PORT || 3000);

export const BASE_URL = 'https://www.football-data.co.uk';

// Main leagues: full data (HT score, xG, 1X2, O/U 2.5, Asian handicap, many bookmakers).
export const MAIN_LEAGUES = {
  I1: { country: 'Italia', name: 'Serie A', flag: 'it' },
  I2: { country: 'Italia', name: 'Serie B', flag: 'it' },
  E0: { country: 'Inghilterra', name: 'Premier League', flag: 'gb-eng' },
  E1: { country: 'Inghilterra', name: 'Championship', flag: 'gb-eng' },
  E2: { country: 'Inghilterra', name: 'League One', flag: 'gb-eng' },
  E3: { country: 'Inghilterra', name: 'League Two', flag: 'gb-eng' },
  EC: { country: 'Inghilterra', name: 'National League', flag: 'gb-eng' },
  SP1: { country: 'Spagna', name: 'LaLiga', flag: 'es' },
  SP2: { country: 'Spagna', name: 'LaLiga 2', flag: 'es' },
  D1: { country: 'Germania', name: 'Bundesliga', flag: 'de' },
  D2: { country: 'Germania', name: '2. Bundesliga', flag: 'de' },
  F1: { country: 'Francia', name: 'Ligue 1', flag: 'fr' },
  F2: { country: 'Francia', name: 'Ligue 2', flag: 'fr' },
  N1: { country: 'Olanda', name: 'Eredivisie', flag: 'nl' },
  B1: { country: 'Belgio', name: 'Jupiler Pro League', flag: 'be' },
  P1: { country: 'Portogallo', name: 'Liga Portugal', flag: 'pt' },
  T1: { country: 'Turchia', name: 'Süper Lig', flag: 'tr' },
  G1: { country: 'Grecia', name: 'Super League', flag: 'gr' },
  SC0: { country: 'Scozia', name: 'Premiership', flag: 'gb-sct' },
  SC1: { country: 'Scozia', name: 'Championship', flag: 'gb-sct' },
  SC2: { country: 'Scozia', name: 'League One', flag: 'gb-sct' },
  SC3: { country: 'Scozia', name: 'League Two', flag: 'gb-sct' },
};

// Extra leagues: FT score + 1X2 closing odds only (no HT, no O/U, no AH).
export const EXTRA_LEAGUES = {
  ARG: { country: 'Argentina', name: 'Liga Profesional', flag: 'ar' },
  AUT: { country: 'Austria', name: 'Bundesliga', flag: 'at' },
  BRA: { country: 'Brasile', name: 'Serie A', flag: 'br' },
  CHN: { country: 'Cina', name: 'Super League', flag: 'cn' },
  DNK: { country: 'Danimarca', name: 'Superliga', flag: 'dk' },
  FIN: { country: 'Finlandia', name: 'Veikkausliiga', flag: 'fi' },
  IRL: { country: 'Irlanda', name: 'Premier Division', flag: 'ie' },
  JPN: { country: 'Giappone', name: 'J1 League', flag: 'jp' },
  MEX: { country: 'Messico', name: 'Liga MX', flag: 'mx' },
  NOR: { country: 'Norvegia', name: 'Eliteserien', flag: 'no' },
  POL: { country: 'Polonia', name: 'Ekstraklasa', flag: 'pl' },
  ROU: { country: 'Romania', name: 'Liga I', flag: 'ro' },
  RUS: { country: 'Russia', name: 'Premier League', flag: 'ru' },
  SWE: { country: 'Svezia', name: 'Allsvenskan', flag: 'se' },
  SWZ: { country: 'Svizzera', name: 'Super League', flag: 'ch' },
  USA: { country: 'USA', name: 'MLS', flag: 'us' },
};

// Country name used in football-data "new" files -> league code.
export const EXTRA_COUNTRY_TO_CODE = {
  Argentina: 'ARG', Austria: 'AUT', Brazil: 'BRA', China: 'CHN', Denmark: 'DNK',
  Finland: 'FIN', Ireland: 'IRL', Japan: 'JPN', Mexico: 'MEX', Norway: 'NOR',
  Poland: 'POL', Romania: 'ROU', Russia: 'RUS', Sweden: 'SWE', Switzerland: 'SWZ', USA: 'USA',
};

export const LEAGUES = { ...MAIN_LEAGUES, ...EXTRA_LEAGUES };

// Season codes like "2627" for 2026/27. Seasons start in July.
export function seasonCodes(count, now = new Date()) {
  const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const codes = [];
  for (let i = 0; i < count; i++) {
    const y = startYear - i;
    codes.push(String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0'));
  }
  return codes;
}

export const MAIN_SEASONS = 5;      // seasons downloaded for main leagues
export const EXTRA_YEARS_BACK = 4;  // years of history kept for extra leagues
export const REFRESH_HOURS = 6;     // re-download current-season files after this

// Model parameters
export const MODEL = {
  decayPerDay: 0.0025,      // time decay for team ratings (half-life ~ 9 months)
  priorWeight: 4,           // pseudo-matches shrinking ratings toward league average
  xgWeight: 0.5,            // share of xG (vs goals) used as rating target when available
  marketWeight: 0.7,        // weight of market-implied lambdas when odds exist
  rho: -0.06,               // Dixon-Coles low-score correlation
  defaultHtShare: 0.445,    // share of goals scored in the 1st half when league data lacks HT
  maxGoals: 10,
  similarK: 200,            // nearest historical matches for "similar odds" archive
};

// Italy uses the same DST calendar as the UK; football-data times are UK local time.
export const UK_TO_ROME_HOURS = 1;
