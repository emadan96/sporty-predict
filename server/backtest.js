// Walk-forward backtest: every prediction only uses data available before kick-off.
// Usage: node server/backtest.js [numMatches=1500]
import { Store } from './store.js';
import { Predictor } from './model/predict.js';
import { marketInputs } from './model/market.js';
import { MAIN_LEAGUES } from './config.js';

const N = Number(process.argv[2] || 1500);
const store = await new Store().load();
const predictor = new Predictor(store);
const sample = store.playedAll.filter((m) => MAIN_LEAGUES[m.league] && m.ht && m.odds?.x12 && m.odds?.ou25).slice(-N);

const ll = (p) => -Math.log(Math.max(p, 1e-9));
const acc = {};
const add = (k, v) => { acc[k] = acc[k] || { s: 0, n: 0 }; acc[k].s += v; acc[k].n++; };
const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));

const t0 = Date.now();
for (const m of sample) {
  const p = predictor.predict(m);
  const [h, a] = m.ft, [hh, ha] = m.ht;
  const res = h > a ? 'home' : h === a ? 'draw' : 'away';
  const resHt = hh > ha ? 'home' : hh === ha ? 'draw' : 'away';
  const mk = marketInputs(m);
  const mp = { home: mk.x12.p[0], draw: mk.x12.p[1], away: mk.x12.p[2] };
  add('1X2 logloss · modello', ll(p.ft.x12[res]));
  add('1X2 logloss · solo quote', ll(mp[res]));
  const o = h + a > 2.5 ? 1 : 0;
  add('O2.5 Brier · modello', (p.ft.over[2.5] - o) ** 2);
  if (mk.ou?.line === 2.5) add('O2.5 Brier · solo quote', (mk.ou.p[0] - o) ** 2);
  add('GG Brier · modello', (p.ft.btts.yes - (h > 0 && a > 0 ? 1 : 0)) ** 2);
  add('PT 1X2 logloss · modello', ll(p.ht.x12[resHt]));
  add('PT O0.5 Brier · modello', (p.ht.over[0.5] - (hh + ha > 0 ? 1 : 0)) ** 2);
  add('Esatto: top-1 centrato', p.ft.exact[0].score === `${h}-${a}` ? 1 : 0);
  add('Esatto: nei top-3', p.ft.exact.slice(0, 3).some((e) => e.score === `${h}-${a}`) ? 1 : 0);
  add('Esatto PT: top-1 centrato', p.ht.exact[0].score === `${hh}-${ha}` ? 1 : 0);
  const mg = p.ft.multigol.find((x) => x.range === '2-4');
  add('Multigol 2-4: prob. media', mg.p);
  add('Multigol 2-4: frequenza reale', h + a >= 2 && h + a <= 4 ? 1 : 0);
  const b = Math.min(9, Math.floor(p.ft.over[2.5] * 10));
  bins[b].p += p.ft.over[2.5]; bins[b].y += o; bins[b].n++;
}

console.log(`Backtest su ${sample.length} partite (${sample[0].date} → ${sample.at(-1).date}) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
for (const [k, v] of Object.entries(acc)) console.log(`${k.padEnd(34)} ${(v.s / v.n).toFixed(4)}`);
console.log('\nCalibrazione Over 2.5 (prob. prevista → frequenza reale):');
for (const b of bins) if (b.n >= 20) console.log(`  ${(b.p / b.n * 100).toFixed(1).padStart(5)}% → ${(b.y / b.n * 100).toFixed(1).padStart(5)}%  (n=${b.n})`);
