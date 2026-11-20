// API-Football league ids <-> football-data codes, competition categories and display order.

// API league id -> [football-data code, API country name used to validate the mapping]
export const AF_TO_FD = {
  135: ['I1', 'Italy'], 136: ['I2', 'Italy'],
  39: ['E0', 'England'], 40: ['E1', 'England'], 41: ['E2', 'England'], 42: ['E3', 'England'], 43: ['EC', 'England'],
  140: ['SP1', 'Spain'], 141: ['SP2', 'Spain'], 78: ['D1', 'Germany'], 79: ['D2', 'Germany'],
  61: ['F1', 'France'], 62: ['F2', 'France'], 88: ['N1', 'Netherlands'], 144: ['B1', 'Belgium'],
  94: ['P1', 'Portugal'], 203: ['T1', 'Turkey'], 197: ['G1', 'Greece'],
  179: ['SC0', 'Scotland'], 180: ['SC1', 'Scotland'], 183: ['SC2', 'Scotland'], 184: ['SC3', 'Scotland'],
  128: ['ARG', 'Argentina'], 218: ['AUT', 'Austria'], 71: ['BRA', 'Brazil'], 169: ['CHN', 'China'],
  119: ['DNK', 'Denmark'], 244: ['FIN', 'Finland'], 357: ['IRL', 'Ireland'], 98: ['JPN', 'Japan'],
  262: ['MEX', 'Mexico'], 103: ['NOR', 'Norway'], 106: ['POL', 'Poland'], 283: ['ROU', 'Romania'],
  235: ['RUS', 'Russia'], 113: ['SWE', 'Sweden'], 207: ['SWZ', 'Switzerland'], 253: ['USA', 'USA'],
};

// Shown first, in this order (European club cups, then national teams).
export const FEATURED = [
  2, 3, 848, 531, // Champions League, Europa League, Conference League, UEFA Super Cup
  1, 4, 5, 32, 960, 10, 9, 6, 7, 22, 34, 29, 30, 31, // World Cup, Euro, Nations League, qualifiers, friendlies...
  137, 547, // Coppa Italia, Supercoppa
];

const NATIONAL_RE = /world cup|euro championship|nations league|friendlies(?! clubs)|qualification|copa america|africa cup|asian cup|gold cup|olympic/i;
export function isNationalCompetition(league) {
  return (league.country === 'World' || league.country === 'Europe' || /^(south|north) america|asia|africa|oceania/i.test(league.country || ''))
    && NATIONAL_RE.test(league.name) && !/club|u17|u19|u20|u21|u23|women/i.test(league.name)
    ? true : false;
}

export function category(league, type) {
  if (FEATURED.slice(0, 4).includes(league.id) || (/europe|world/i.test(league.country) && type === 'Cup' && !isNationalCompetition(league))) return 'Coppe internazionali';
  if (isNationalCompetition(league)) return 'Nazionali';
  return type === 'Cup' ? 'Coppe nazionali' : 'Campionati';
}

const COUNTRY_IT = {
  World: 'Mondo', Europe: 'Europa', Italy: 'Italia', England: 'Inghilterra', Spain: 'Spagna', Germany: 'Germania', France: 'Francia',
  Netherlands: 'Olanda', Belgium: 'Belgio', Portugal: 'Portogallo', Turkey: 'Turchia', Greece: 'Grecia', Scotland: 'Scozia',
  Wales: 'Galles', 'Northern-Ireland': 'Irlanda del Nord', Ireland: 'Irlanda', Austria: 'Austria', Switzerland: 'Svizzera',
  Denmark: 'Danimarca', Sweden: 'Svezia', Norway: 'Norvegia', Finland: 'Finlandia', Iceland: 'Islanda', Poland: 'Polonia',
  'Czech-Republic': 'Rep. Ceca', Slovakia: 'Slovacchia', Hungary: 'Ungheria', Romania: 'Romania', Bulgaria: 'Bulgaria',
  Serbia: 'Serbia', Croatia: 'Croazia', Slovenia: 'Slovenia', Bosnia: 'Bosnia', Albania: 'Albania', Ukraine: 'Ucraina',
  Russia: 'Russia', Belarus: 'Bielorussia', Cyprus: 'Cipro', Israel: 'Israele', Brazil: 'Brasile', Argentina: 'Argentina',
  Chile: 'Cile', Colombia: 'Colombia', Uruguay: 'Uruguay', Paraguay: 'Paraguay', Peru: 'Perù', Ecuador: 'Ecuador',
  Bolivia: 'Bolivia', Venezuela: 'Venezuela', Mexico: 'Messico', USA: 'USA', Canada: 'Canada', Japan: 'Giappone',
  'South-Korea': 'Corea del Sud', China: 'Cina', Australia: 'Australia', 'Saudi-Arabia': 'Arabia Saudita', Qatar: 'Qatar',
  'United-Arab-Emirates': 'Emirati Arabi', Egypt: 'Egitto', Morocco: 'Marocco', Algeria: 'Algeria', Tunisia: 'Tunisia',
  'South-Africa': 'Sudafrica', Nigeria: 'Nigeria', Ghana: 'Ghana', Iran: 'Iran', India: 'India', Indonesia: 'Indonesia',
  Thailand: 'Thailandia', Vietnam: 'Vietnam', Malaysia: 'Malesia', Estonia: 'Estonia', Latvia: 'Lettonia', Lithuania: 'Lituania',
  Georgia: 'Georgia', Armenia: 'Armenia', Azerbaidjan: 'Azerbaigian', Kazakhstan: 'Kazakistan', Moldova: 'Moldavia',
  Montenegro: 'Montenegro', Macedonia: 'Macedonia', Luxembourg: 'Lussemburgo', Malta: 'Malta', 'Costa-Rica': 'Costa Rica',
};
export const countryIt = (c) => COUNTRY_IT[c] || (c || '').replace(/-/g, ' ');
