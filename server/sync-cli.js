// Manual API-Football sync: node server/sync-cli.js [--force]
import './env.js';
import { syncApiFootball } from './providers/apifootball/sync.js';
const r = await syncApiFootball({ force: process.argv.includes('--force') });
if (!r.enabled) console.log('APIFOOTBALL_KEY non impostata: copia .env.example in .env e inserisci la tua chiave.');
