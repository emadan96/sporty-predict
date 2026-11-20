// Updates the data, builds the static site and uploads it to Cloudflare Pages from this PC.
// Usage: npm run pubblica   (first time: npx wrangler login)
// Options: --no-sync  publish the data already on disk without calling football-data / API-Football
import './env.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

const PROJECT = process.env.CF_PAGES_PROJECT || 'sporty-predict';
const WRANGLER = 'wrangler@4';
const stamp = () => new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

function run(cmd, args, { allowFail = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32', encoding: 'utf8' });
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

// 3) Upload (the project is created on the first run; only changed files are sent)
run('npx', ['--yes', WRANGLER, 'pages', 'project', 'create', PROJECT, '--production-branch=main'], { allowFail: true, quiet: true });
run('npx', ['--yes', WRANGLER, 'pages', 'deploy', 'dist', `--project-name=${PROJECT}`, '--branch=main', '--commit-dirty=true']);
console.log(`=== Pubblicato ${stamp()} ===`);
