// Tiny .env loader (no dependencies). Existing process env vars win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch { /* no .env file */ }

export const env = {
  apiKey: process.env.APIFOOTBALL_KEY || '',
  rapidApi: process.env.APIFOOTBALL_RAPIDAPI === '1',
  daysAhead: Number(process.env.APIFOOTBALL_DAYS_AHEAD || 7),
  daysBack: Number(process.env.APIFOOTBALL_DAYS_BACK || 3),
  reservePct: Number(process.env.APIFOOTBALL_RESERVE_PCT || 10),
  maxPerMinute: Number(process.env.APIFOOTBALL_MAX_PER_MINUTE || 0), // 0 = use header value
};
