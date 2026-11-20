# Sporty Predict

Web app in stile livescore con pronostici per il calcio basati su quote storiche (Bet365, Pinnacle, Betfair Exchange, media/max dei bookmaker, handicap asiatico).

## Avvio

```bash
cp .env.example .env   # poi inserisci APIFOOTBALL_KEY (facoltativa, ma serve per tutte le competizioni)
npm run ingest         # scarica gli archivi CSV di football-data (prima volta ~25 MB)
npm start              # http://localhost:3000 — avvia anche la sincronizzazione API-Football in background
npm run sync           # sincronizzazione API-Football manuale (--force per ignorare la cache)
npm test               # test della pipeline API-Football (con dati simulati)
npm run backtest       # verifica walk-forward della qualità dei pronostici
```

## API-Football (tutte le competizioni)

Con `APIFOOTBALL_KEY` impostata il server scarica, per i 3 giorni passati e i 7 futuri:

- **tutte le partite del giorno** di ogni competizione (coppe europee, nazionali, campionati minori): 1 chiamata/giorno di calendario;
- **quote pre-partita** di tutti i bookmaker (Pinnacle, SBOBET, 188Bet, Dafabet, Bet365, 1xBet…), mercati 1X2, handicap asiatico su tutte le linee, Over/Under su tutte le linee, 1° tempo, Goal/No Goal. Paginazione 10 partite/chiamata; oggi e domani ogni 3 ore, il resto della settimana ogni 12 ore;
- **storico** (stagione corrente + precedente) di ogni campionato che ha partite nella finestra e non è già coperto da football-data: serve per i rating delle squadre.

Ogni rilevazione delle quote viene salvata in `data/af/odds/`: la prima è l'**apertura**, l'ultima la **quota attuale** (da qui le frecce di movimento). API-Football conserva solo 7 giorni di storico quote, quindi l'archivio storico per questi campionati cresce da quando lasci girare l'app.

### Piano Free di API-Football

Il piano gratuito ha limiti stretti, che l'app rileva da sola (`data/af/plan.json`) per non sprecare chiamate:

- 100 chiamate al giorno, 10 al minuto;
- partite solo **da ieri a domani**;
- quote: al massimo 3 pagine per data (30 partite). Le altre si scaricano una per una, in ordine di priorità (coppe europee, nazionali, Italia, campionati in archivio, grandi campionati europei), finché resta quota. In un giorno normale si coprono circa 100 partite;
- **niente storici della stagione in corso**: per le competizioni non coperte da football-data il pronostico usa solo quote + archivio di quote simili.

Con un piano a pagamento questi limiti spariscono e l'app scarica tutto (7 giorni avanti, storici, quote ogni 3 ore).

Consumo indicativo: un weekend pieno richiede alcune centinaia di chiamate alla prima sincronizzazione (storici) e poi ~100–300 al giorno. Il piano gratuito (100/giorno) basta solo per provare; per l'uso reale serve un piano a pagamento. Il client rispetta il limite al minuto e lascia sempre libero il 10% della quota giornaliera (`APIFOOTBALL_RESERVE_PCT`).

Le partite dei campionati già presenti in football-data vengono **fuse** con l'archivio (riconoscimento automatico dei nomi, es. "Manchester United" ↔ "Man United"), così conservano quote di chiusura, xG e rating.

Rating per tipo di competizione:
- campionati → rating del campionato;
- nazionali → un unico pool con tutte le partite delle nazionali (qualificazioni, Nations League, amichevoli…);
- coppe per club → rating del campionato nazionale se le due squadre giocano nello stesso; altrimenti (es. Champions League tra club di paesi diversi) il pronostico si basa solo su mercato + archivio, perché le forze di campionati diversi non sono confrontabili.

Nessuna dipendenza esterna: serve solo Node ≥ 20.

## Fonte dati

[football-data.co.uk](https://www.football-data.co.uk): 5 stagioni × 22 campionati principali (risultato finale e del primo tempo, xG, quote 1X2, U/O 2.5, handicap asiatico, apertura e chiusura) + 16 campionati extra (solo risultato finale e quote 1X2). I dati vengono riscaricati ogni ora se sono più vecchi di 6 ore; le fixture escono pochi giorni prima di ogni turno.

## Modello

1. **Rating squadre**: modello Poisson attacco/difesa per campionato, con decadimento temporale, target 50% goal + 50% xG e prior più debole per le neopromosse.
2. **Goal attesi impliciti nel mercato**: λ casa/ospite ricavate dalle quote del book più "sharp" disponibile (Pinnacle → Betfair → media → Bet365) togliendo l'aggio (metodo power) da 1X2, U/O 2.5 e handicap asiatico.
3. **Fusione**: 70% mercato + 30% rating → matrice dei risultati Dixon-Coles. Il primo tempo usa la quota di goal del primo tempo stimata sul campionato; il 2° tempo è la parte restante, così il Parziale/Finale è coerente.
4. **Archivio quote simili**: le 200 partite storiche con il profilo di quota più vicino (prima del calcio d'inizio) vengono fuse con le matrici finale e primo tempo (peso ~20%).

Mercati: 1X2, doppia chance, draw no bet, U/O 0.5–5.5, Goal/No Goal, pari/dispari, multigol finale/primo tempo/casa/ospite, somma goal, risultato esatto (finale e primo tempo, con mappa di calore), Parziale/Finale, 2° tempo, tempo con più goal, value bet confrontando le quote "giuste" con Bet365/media/max.

## Struttura

```
server/config.js        campionati, parametri del modello
server/ingest.js        download dei CSV
server/store.js         normalizzazione, classifiche, forma, scontri diretti
server/model/*.js       poisson, rating, mercato, archivio, previsione
server/index.js         API HTTP + file statici
public/                 interfaccia (HTML/CSS/JS senza framework)
```

## Limiti attuali / passi successivi

- Senza chiave API-Football la copertura è limitata ai 38 campionati di football-data. Il live non è gestito.
- Le quote del primo tempo, del multigol e del risultato esatto non sono negli archivi: quei mercati sono derivati dalla matrice dei risultati, non calibrati sulle loro quote specifiche.

## Pubblicazione online gratuita (versione statica)

`npm run build` genera in `dist/` un sito statico con i pronostici già calcolati per una finestra di giorni
(default 7 indietro e 10 avanti: `STATIC_DAYS_BACK`, `STATIC_DAYS_AHEAD`). `npm run build:sync` prima aggiorna i dati.
Il workflow `.github/workflows/pubblica.yml` lo esegue su GitHub Actions due volte al giorno e pubblica `dist/`
su Cloudflare Pages. Gli archivi in `data/` restano nella cache di Actions, così la quota API-Football non si spreca.

Configurazione (una volta sola):
1. Crea un repository **privato** su GitHub e caricaci il progetto (`.env`, `data/` e `dist/` sono esclusi da `.gitignore`).
2. Su Cloudflare: *My Profile → API Tokens → Create Token →* modello "Edit Cloudflare Workers" oppure token
   personalizzato con permesso **Account → Cloudflare Pages → Edit**. Copia anche l'**Account ID** (dashboard, colonna destra).
3. Su GitHub: *Settings → Secrets and variables → Actions → New repository secret*:
   `APIFOOTBALL_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. *Actions → Pubblica pronostici → Run workflow*. Il sito sarà su `https://sporty-predict.pages.dev`
   (nome diverso: variabile `CF_PAGES_PROJECT`).

Nella versione online il pulsante Aggiorna carica l'ultima pubblicazione; le partite fuori dalla finestra non sono disponibili.
