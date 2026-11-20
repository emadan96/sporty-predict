// Updates the data, builds the static site and uploads it to Cloudflare from this PC.
// Usage: npm run pubblica   (first time: npx wrangler login)
// Options: --no-sync  publish the data already on disk without calling football-data / API-Football
import './env.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

const WRANGLER = 'wrangler@4';
const stamp = () => new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

function run(cmd, args, { allowFail = false, quiet = false } = {}) {
  // npx is a .cmd on Windows and needs a shell; node itself is run directly (its path has spaces).
  const shell = process.platform === 'win32' && cmd === 'npx';
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit', shell, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    if (quiet) process.stderr.write(`${r.stdout || ''}${r.stderr || ''}`);
    throw new Error(`${cmd} ${args.join(' ')} → codice ${r.status}`);
  }
  return r;
}

console.log(`\n=== Pubblicazione ${stamp()} ===`);

// 1) Cloudflare access (wrangler login, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in .env)
const who = run('npx', ['--yes', WRANGLER, 'whoami'], { allowFail: true, quiet: true });
if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
  console.error('Non sei collegato a Cloudflare. Esegui una volta:  npx wrangler login');
  process.exit(1);
}

// 2) Data + static site
run(process.execPath, [path.join('server', 'build-static.js'), ...(process.argv.includes('--no-sync') ? [] : ['--sync'])]);

// 3) Upload to Cloudflare (static assets, see wrangler.jsonc). Only changed files are sent.
run('npx', ['--yes', WRANGLER, 'deploy']);
console.log(`=== Pubblicato ${stamp()} ===`);
