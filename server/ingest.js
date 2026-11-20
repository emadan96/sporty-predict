import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASE_URL, DATA_DIR, MAIN_LEAGUES, EXTRA_LEAGUES, MAIN_SEASONS, REFRESH_HOURS, seasonCodes,
} from './config.js';

async function fileAgeHours(file) {
  try {
    const st = await fs.stat(file);
    return (Date.now() - st.mtimeMs) / 3_600_000;
  } catch {
    return Infinity;
  }
}

async function download(url, file, { maxAgeHours = Infinity, force = false } = {}) {
  if (!force && (await fileAgeHours(file)) < maxAgeHours) return 'cached';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'sporty-predict/0.1' } });
    if (!res.ok) return `http ${res.status}`;
    const text = await res.text();
    if (!text.includes(',')) return 'empty';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return 'ok';
  } catch (e) {
    return `error ${e.message}`;
  }
}

/** Download all source CSVs. Past seasons are fetched once; current ones refresh periodically. */
export async function ingest({ force = false, log = console.log } = {}) {
  const seasons = seasonCodes(MAIN_SEASONS);
  const jobs = [];
  for (const code of Object.keys(MAIN_LEAGUES)) {
    seasons.forEach((s, i) => {
      jobs.push({
        url: `${BASE_URL}/mmz4281/${s}/${code}.csv`,
        file: path.join(DATA_DIR, 'main', `${s}_${code}.csv`),
        maxAgeHours: i === 0 ? REFRESH_HOURS : Infinity,
      });
    });
  }
  for (const code of Object.keys(EXTRA_LEAGUES)) {
    jobs.push({ url: `${BASE_URL}/new/${code}.csv`, file: path.join(DATA_DIR, 'extra', `${code}.csv`), maxAgeHours: REFRESH_HOURS });
  }
  jobs.push({ url: `${BASE_URL}/fixtures.csv`, file: path.join(DATA_DIR, 'fixtures.csv'), maxAgeHours: 1 });
  jobs.push({ url: `${BASE_URL}/new_league_fixtures.csv`, file: path.join(DATA_DIR, 'new_league_fixtures.csv'), maxAgeHours: 1 });

  const summary = { ok: 0, cached: 0, failed: [] };
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const r = await download(job.url, job.file, { maxAgeHours: job.maxAgeHours, force });
      if (r === 'ok') summary.ok++;
      else if (r === 'cached') summary.cached++;
      else summary.failed.push(`${job.url} (${r})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`[ingest] scaricati ${summary.ok}, in cache ${summary.cached}, falliti ${summary.failed.length}`);
  for (const f of summary.failed) log(`  - ${f}`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ingest({ force: process.argv.includes('--force') });
}
