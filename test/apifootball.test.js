// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-test-'));
process.env.AF_DIR = tmp;

const { parseOdds } = await import('../server/providers/apifootball/odds.js');
const { matchTeams } = await import('../server/providers/apifootball/teams.js');
const { isNationalCompetition } = await import('../server/providers/apifootball/leagues.js');

const v = (value, odd, extra = {}) => ({ value, odd: String(odd), ...extra });
const bookmaker = (id, name, ahStyle) => ({
  id, name,
  bets: [
    { id: 1, name: 'Match Winner', values: [v('Home', 1.8), v('Draw', 3.6), v('Away', 4.5)] },
    { id: 5, name: 'Goals Over/Under', values: [v('Over 2.5', 1.85), v('Under 2.5', 2.0), v('Over 2.75', 2.05), v('Under 2.75', 1.8), v('Over 1.5', 1.3), v('Under 1.5', 3.4)] },
    {
      id: 4, name: 'Asian Handicap',
      values: ahStyle === 'mirror'
        ? [v('Home -0.5', 1.82), v('Away +0.5', 2.06), v('Home -1', 2.6), v('Away +1', 1.5), v('Home -0.75', 2.15), v('Away +0.75', 1.75)]
        : [v('Home', 1.82, { handicap: '-0.5' }), v('Away', 2.06, { handicap: '-0.5' }), v('Home', 2.6, { handicap: '-1' }), v('Away', 1.5, { handicap: '-1' })],
    },
    { id: 13, name: 'First Half Winner', values: [v('Home', 2.4), v('Draw', 2.1), v('Away', 5)] },
    { id: 6, name: 'Goals Over/Under First Half', values: [v('Over 0.5', 1.4), v('Under 0.5', 2.9), v('Over 1.5', 3.0), v('Under 1.5', 1.38)] },
    { id: 8, name: 'Both Teams Score', values: [v('Yes', 1.9), v('No', 1.9)] },
  ],
});

test('parseOdds handles both Asian-handicap conventions and finds balanced lines', () => {
  for (const style of ['mirror', 'same']) {
    const o = parseOdds([bookmaker(4, 'Pinnacle', style), bookmaker(8, 'Bet365', style)]);
    assert.deepEqual(o.x12.ps, [1.8, 3.6, 4.5]);
    assert.equal(o.ah.line, -0.5, style);
    assert.deepEqual(o.ah.ps, [1.82, 2.06], style);
    assert.deepEqual(o.ahLines['-1'].b365, [2.6, 1.5], style);
    assert.equal(o.ouMain.line, 2.5);
    assert.deepEqual(o.ou['2.75'].ps, [2.05, 1.8]);
    assert.deepEqual(o.ou25.avg, [1.85, 2]);
    assert.deepEqual(o.ht1x2.ps, [2.4, 2.1, 5]);
    assert.deepEqual(o.htou['1.5'].ps, [3, 1.38]);
    assert.deepEqual(o.btts.b365, [1.9, 1.9]);
  }
});

test('real API-Football Asian handicap format (away quoted with the home line, symmetric ladder)', () => {
  // Observed on a live /odds response: {"value":"Home -1.25","odd":"4.65"},{"value":"Away -1.25","odd":"1.18"}, ...
  const ladder = [[-1.25, 4.65, 1.18], [-1, 4.15, 1.22], [-0.75, 3.0, 1.38], [-0.5, 2.55, 1.5], [-0.25, 2.1, 1.75], [0, 1.72, 2.12],
    [0.25, 1.5, 2.55], [0.5, 1.36, 3.05], [0.75, 1.27, 3.7], [1, 1.2, 4.4], [1.25, 1.16, 5.1]];
  const values = ladder.flatMap(([l, h, a]) => [v(`Home ${l > 0 ? '+' : ''}${l}`, h), v(`Away ${l > 0 ? '+' : ''}${l}`, a)]);
  const o = parseOdds([{ name: 'Pinnacle', bets: [{ name: 'Asian Handicap', values }] }]);
  assert.deepEqual(o.ahLines['-1.25'].ps, [4.65, 1.18]);
  assert.deepEqual(o.ahLines['0.5'].ps, [1.36, 3.05]);
  assert.equal(o.ah.line, -0.25); // most balanced pair: 2.10 / 1.75
});

test('team names map onto football-data abbreviations', () => {
  const fd = ['Man United', 'Man City', "Nott'm Forest", 'Tottenham', 'Brighton', 'Newcastle', 'Arsenal', 'Wolves'];
  const m = matchTeams(['Manchester United', 'Manchester City', 'Nottingham Forest', 'Tottenham Hotspur', 'Brighton & Hove Albion', 'Newcastle United', 'Arsenal'], fd);
  assert.equal(m.get('Manchester United'), 'Man United');
  assert.equal(m.get('Manchester City'), 'Man City');
  assert.equal(m.get('Nottingham Forest'), "Nott'm Forest");
  assert.equal(m.get('Tottenham Hotspur'), 'Tottenham');
  assert.equal(m.get('Brighton & Hove Albion'), 'Brighton');
  assert.equal(m.get('Newcastle United'), 'Newcastle');
  const it = matchTeams(['AC Milan', 'Inter', 'AS Roma', 'Hellas Verona', 'Juventus'], ['Milan', 'Inter', 'Roma', 'Verona', 'Juventus', 'Venezia']);
  assert.equal(it.get('AC Milan'), 'Milan');
  assert.equal(it.get('Hellas Verona'), 'Verona');
  assert.equal(it.get('AS Roma'), 'Roma');
});

test('national-team competitions are recognised', () => {
  assert.equal(isNationalCompetition({ name: 'World Cup - Qualification Europe', country: 'World' }), true);
  assert.equal(isNationalCompetition({ name: 'UEFA Nations League', country: 'World' }), true);
  assert.equal(isNationalCompetition({ name: 'UEFA Champions League', country: 'World' }), false);
  assert.equal(isNationalCompetition({ name: 'Friendlies Clubs', country: 'World' }), false);
});

test('end to end: API fixtures merge with football-data and every competition gets a prediction', async () => {
  const date = '2026-11-28';
  const ids = new Map();
  const teamId = (n) => { if (!ids.has(n)) ids.set(n, 500 + ids.size); return ids.get(n); };
  const fx = (id, league, home, away, time = '20:45') => ({
    fixture: { id, date: `${date}T${time}:00+01:00`, timestamp: 0, status: { short: 'NS' }, venue: { name: 'X' }, referee: null },
    league: { season: league.season ?? 2026, round: 'R1', logo: '', flag: null, ...league },
    teams: { home: { id: teamId(home), name: home, logo: '' }, away: { id: teamId(away), name: away, logo: '' } },
    goals: { home: null, away: null }, score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } },
  });
  const serieA = { id: 135, name: 'Serie A', country: 'Italy' };
  const ucl = { id: 2, name: 'UEFA Champions League', country: 'World' };
  const wcq = { id: 32, name: 'World Cup - Qualification Europe', country: 'World', season: 2024 };
  const est = { id: 329, name: 'Meistriliiga', country: 'Estonia' };
  fs.mkdirSync(path.join(tmp, 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'odds'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'history'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'leagues.json'), JSON.stringify([
    { league: { ...serieA, type: 'League' }, country: { name: 'Italy' } }, { league: { ...ucl, type: 'Cup' }, country: { name: 'World' } },
    { league: { ...wcq, type: 'Cup' }, country: { name: 'World' } }, { league: { ...est, type: 'League' }, country: { name: 'Estonia' } },
  ]));
  fs.writeFileSync(path.join(tmp, 'fixtures', `${date}.json`), JSON.stringify([
    fx(1, serieA, 'AC Milan', 'Inter'), fx(2, ucl, 'Inter', 'Arsenal'), fx(3, wcq, 'Italy', 'Norway'), fx(4, est, 'Flora Tallinn', 'Levadia'),
    fx(5, ucl, 'AC Milan', 'Juventus'),
  ]));
  // history for national teams and the Estonian league so ratings exist
  const hist = (league, teams, n) => Array.from({ length: n }, (_, i) => {
    const f = fx(1000 + league.id * 100 + i, league, teams[i % teams.length], teams[(i + 1 + (i % 3)) % teams.length]);
    f.fixture.date = `2026-${String(3 + (i % 8)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}T18:00:00+01:00`;
    f.fixture.status.short = 'FT';
    f.score.fulltime = { home: i % 3, away: (i * 7) % 3 };
    f.score.halftime = { home: i % 2, away: 0 };
    return f;
  }).filter((f) => f.teams.home.name !== f.teams.away.name);
  fs.writeFileSync(path.join(tmp, 'history', '32_2024.json'), JSON.stringify(hist(wcq, ['Italy', 'Norway', 'Israel', 'Estonia', 'Moldova'], 60)));
  fs.writeFileSync(path.join(tmp, 'history', '329_2026.json'), JSON.stringify(hist(est, ['Flora Tallinn', 'Levadia', 'Paide', 'Nomme Kalju', 'Narva'], 80)));
  const odds = parseOdds([bookmaker(4, 'Pinnacle', 'mirror'), bookmaker(5, 'SBO', 'mirror'), bookmaker(8, 'Bet365', 'mirror')]);
  fs.writeFileSync(path.join(tmp, 'odds', `${date}.json`), JSON.stringify({
    1: { first: { t: 1, o: odds }, last: { t: 2, o: odds } }, 2: { first: { t: 1, o: odds }, last: { t: 2, o: odds } },
  }));

  const { Store } = await import('../server/store.js');
  const { Predictor } = await import('../server/model/predict.js');
  const store = await new Store().load();
  const pred = new Predictor(store);

  const derby = store.byId.get('I1-20261128-milan-inter');
  assert.ok(derby, 'Serie A fixture merged under the football-data id and names');
  assert.equal(derby.homeName, 'AC Milan');
  const p1 = pred.predict(derby);
  assert.equal(p1.inputs.market.x12.book, 'Pinnacle');
  assert.equal(p1.inputs.market.ah.line, -0.5);
  assert.equal(p1.inputs.htShareSource, 'quote primo tempo');
  assert.ok(p1.inputs.model.known, 'Serie A ratings from football-data history');

  const cl = store.byId.get('af2');
  assert.equal(store.leagues.get(cl.league).category, 'Coppe internazionali');
  const p2 = pred.predict(cl);
  assert.equal(p2.inputs.model, null, 'Inter (Serie A) vs Arsenal (Premier) -> market only');
  assert.equal(p2.inputs.weights.market, 1);

  const p5 = pred.predict(store.byId.get('af5'));
  assert.match(p5.inputs.model.pool, /Serie A/, 'two Serie A clubs in a cup use Serie A ratings');

  const nat = pred.predict(store.byId.get('af3'));
  assert.match(nat.inputs.model.pool, /Nazionali/);
  assert.ok(nat.inputs.model.known);

  const minor = pred.predict(store.byId.get('af4'));
  assert.ok(minor.inputs.model.known, 'minor league rated from its own history');
  assert.ok(minor.trends.rows.length > 30);
  for (const p of [p1, p2, p5, nat, minor]) {
    const s = p.ft.x12.home + p.ft.x12.draw + p.ft.x12.away;
    assert.ok(Math.abs(s - 1) < 1e-6);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('events: compact timeline, red cards, live row', async () => {
  const { compactEvents, redCards, liveRow, compactStats } = await import('../server/providers/apifootball/events.js');
  const H = 10, A = 20;
  const raw = [
    { time: { elapsed: 12 }, team: { id: H }, player: { name: 'Rossi' }, assist: { name: 'Bianchi' }, type: 'Goal', detail: 'Normal Goal' },
    { time: { elapsed: 30 }, team: { id: A }, player: { name: 'Verdi' }, type: 'Card', detail: 'Yellow Card' },
    { time: { elapsed: 45, extra: 2 }, team: { id: A }, player: { name: 'Verdi' }, type: 'Card', detail: 'Second Yellow card' },
    { time: { elapsed: 60 }, team: { id: H }, player: { name: 'Neri' }, type: 'Goal', detail: 'Penalty' },
    { time: { elapsed: 70 }, team: { id: A }, player: { name: 'Gialli' }, type: 'Goal', detail: 'Missed Penalty' },
    { time: { elapsed: 75 }, team: { id: H }, player: { name: 'Neri' }, type: 'Var', detail: 'Goal cancelled' },
    { time: { elapsed: 120 }, team: { id: H }, player: { name: 'Rossi' }, type: 'Goal', detail: 'Penalty', comments: 'Penalty Shootout' },
  ];
  const ev = compactEvents(raw, H);
  assert.deepEqual(ev.map((e) => e.k), ['goal', 'yc', 'y2', 'pen', 'mpen', 'var']); // shoot-out kick left out
  assert.deepEqual(ev[0], { m: 12, s: 'h', k: 'goal', p: 'Rossi', a: 'Bianchi' });
  assert.equal(ev[2].x, 2);
  assert.deepEqual(redCards(ev), [0, 1]);
  assert.equal(redCards([]), null);

  const row = liveRow({ fixture: { id: 5, status: { short: 'AET', elapsed: 120 } }, teams: { home: { id: H }, away: { id: A } },
    goals: { home: 2, away: 1 }, score: { halftime: { home: 1, away: 0 }, fulltime: { home: 1, away: 1 } }, events: raw });
  assert.deepEqual([row.st, row.g, row.ht, row.ft, row.rc], ['AET', [2, 1], [1, 0], [1, 1], [0, 1]]);

  const st = compactStats([
    { team: { id: A }, statistics: [{ type: 'Ball Possession', value: '45%' }, { type: 'Corner Kicks', value: null }] },
    { team: { id: H }, statistics: [{ type: 'Ball Possession', value: '55%' }, { type: 'Corner Kicks', value: 6 }] },
  ], H);
  assert.deepEqual(st, { poss: [55, 45], corners: [6, 0] });
});
