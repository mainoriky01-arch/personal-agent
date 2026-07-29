# Roadmap

This file is the **only** source the Finn-loop orchestrator uses to generate new
work autonomously (`finn-spec-auto`). You own it. The loop never invents scope —
it only expands what you write here into build-ready Linear issues, one at a
time, and only when the queue is empty.

## Authoritative contract

Every item **must** follow the **Automated Spec & Roadmap Contract in
[`CLAUDE.md`](../CLAUDE.md) §3** — the three core principles (§3.1), the item
schema (§3.2), the anti-patterns (§3.3), and the worked example (§3.4). That is
the single source of truth for the format; this file only holds the live queue.

## How the loop consumes it

- Each pending item becomes **one** build-ready issue (one PR-sized unit,
  < 400 lines of diff).
- The orchestrator picks the **first unchecked** item that has no Linear issue
  yet and whose `After:` prerequisite is already merged (`Done`), expands it into
  a full spec per the CLAUDE.md §3.2 schema, and files it on team `COD` as
  `agent-ready` with a `Roadmap: <slug>` marker.
- If an item is too vague to spec **without guessing**, the loop skips it and
  tells you exactly what is missing — it never invents scope.
- Tick `- [x]` yourself for your own tracking; the loop also skips any item whose
  `slug` already has a Linear issue, so it never duplicates.

## Pending items

<!--
Add real items below using the CLAUDE.md §3.2 schema. Until you add one, the
orchestrator has nothing to generate and simply skips its spec-generation step.
See CLAUDE.md §3.4 for a fully-worked example at the right level of detail.
-->

- [ ] (slug: expose-rule-flags) Esporre `barrage` e `dailyBudgetMinutes` in /rules/confirm
      Goal: Permettere di configurare barrage e budget giornaliero creando una regola via `POST /rules/confirm`.
      Problem: I flag esistono su `Rule`, nel motore e nel DB (COD-9/COD-11), ma `/rules/confirm` non li mappa: oggi si impostano solo nei test, non da API — non testabili a mano né usabili dal client.
      Input/Output:
        - Input: `POST /rules/confirm { habitId, proposal }` con due campi opzionali nel proposal: `barrage?: boolean`, `dailyBudgetMinutes?: number`.
        - Success Output: 201 con la regola creata che riporta `barrage` e `dailyBudgetMinutes`; in durable mode i valori sono persistiti (già supportati da PgConfigRepo).
        - Failure Output: 400 "dailyBudgetMinutes_invalid" se presente e non intero > 0; 404 "habit_not_found" invariato.
      AC:
        - [ ] AC-1: `RuleProposal` ha `barrage?: boolean` e `dailyBudgetMinutes?: number` opzionali; assenti → default (false / undefined) e comportamento invariato.
        - [ ] AC-2: `confirmRule` mappa entrambi sulla Rule creata e la risposta li riporta.
        - [ ] AC-3: `dailyBudgetMinutes` presente ma non intero > 0 → 400 "dailyBudgetMinutes_invalid".
        - [ ] AC-4: in durable mode `getRule` sulla regola creata conserva `barrage` e `dailyBudgetMinutes`.
      Out of Scope (Non-goals):
        - NG-1: Nessun cambio alla forma della rotta o ad altri campi del proposal.
        - NG-2: Nessuna logica di motore nuova (barrage/budget già implementati).
        - NG-3: Nessuna esposizione di questi campi in altre rotte.
      Constraints: Modificare `RuleProposal` in `@pa/rule-drafting` e `confirmRule` in `api.ts`; non toccare il motore né lo schema.
      Files: packages/rule-drafting/src/types.ts, apps/backend/src/api.ts, apps/backend/test/*
      Tests: Nuovo test "confirm mappa barrage+budget": proposal con `barrage:true` e `dailyBudgetMinutes:30` → regola con quei valori; budget invalido → 400.
      Verify:
        1. pnpm --filter @pa/backend dev
        2. crea habit (POST /habits), poi POST /rules/confirm con barrage:true e dailyBudgetMinutes:30
        3. verifica nella risposta i due campi valorizzati.
      Risk: Basso, isolato nel drafting + confirm.
      After: (nessuno — COD-9 e COD-11 già merged)

- [ ] (slug: llm-intent-adapter) Adattatore IntentExtractor LLM reale dietro env (stub di default)
      Goal: Un `IntentExtractor` basato su LLM Anthropic reale per `/chat/draft`, selezionato da env; stub keyword di default.
      Problem: L'agente conversazionale — cuore della visione — usa uno stub a keyword. Serve un adattatore LLM reale senza rompere i test ermetici né il hot-path deterministico.
      Input/Output:
        - Input: Nessun cambio HTTP; `POST /chat/draft { text }`.
        - Success Output: Con `ANTHROPIC_API_KEY` settata `main.ts` usa l'adattatore LLM; altrimenti lo stub. `/chat/draft` continua a restituire una proposta.
        - Failure Output: Errori LLM (rete/chiave) gestiti e loggati; fallback allo stub o a proposta vuota, mai crash.
      AC:
        - [ ] AC-1: Nuovo `LlmIntentExtractor implements IntentExtractor` che chiama l'SDK Anthropic; API key da env; nessun segreto nel repo.
        - [ ] AC-2: Selezione per-config in `main.ts`: env presente → LLM, altrimenti stub (default dev/test).
        - [ ] AC-3: Il hot-path del motore resta senza LLM (estrazione solo per il drafting, mai per decidere se intervenire).
        - [ ] AC-4: Test ermetici: client LLM iniettato, nessuna rete; mapping testo→Intent unit-testato; errore LLM → fallback gestito.
      Out of Scope (Non-goals):
        - NG-1: Nessun LLM nella decisione di intervento (hot-path deterministico).
        - NG-2: Nessun segreto committato.
        - NG-3: Nessun cambio ai contratti HTTP.
      Constraints: Usare l'SDK ufficiale `@anthropic-ai/sdk`, API key da env `ANTHROPIC_API_KEY`, modello Claude più recente (il builder consulti il riferimento claude-api per l'ID corrente); il client dev'essere iniettabile per i test (nessuna rete nei test).
      Files: apps/backend/src/llm-intent-extractor.ts (nuovo), apps/backend/src/main.ts, .env.example, apps/backend/test/*
      Tests: "llm-intent": mapping input→Intent, selezione stub/LLM da env, errore→fallback, nessuna rete.
      Verify:
        1. senza ANTHROPIC_API_KEY → log "in-memory/stub extractor"
        2. con ANTHROPIC_API_KEY fittizia → log "LLM extractor" (nessuna chiamata reale nei test).
      Risk: Medio — nuova dipendenza SDK; isolata dietro la porta esistente.
      After: (nessuno)

- [ ] (slug: llm-copywriter-adapter) Adattatore CopyWriter LLM reale per i messaggi, col Safety Layer sempre applicato
      Goal: Comporre il testo degli interventi con un LLM Anthropic dietro env, mantenendo il Safety Layer come gate invalicabile; template di default.
      Problem: I messaggi vengono da template. Per un coach empatico serve testo generato da LLM, ma deve SEMPRE passare il Safety Layer e mai entrare nel hot-path decisionale.
      Nota decisione (2026-07-28, Riccardo — Opzione A): la porta `aiDraft` di
        `InterventionService` è oggi **sincrona** (`(ctx) => string | undefined`),
        incompatibile con una chiamata LLM asincrona. Si adotta la porta **async**:
        `aiDraft?: (ctx) => Promise<string | undefined>`, `await`-ata in `handleTick`.
        Giustificazione §1.7: il backend NON è il cervello real-time (enforcement
        on-device via shield), quindi il path push è *secondario* e una chiamata
        async lì è accettabile. Lo scope include perciò `@pa/intervention-service`.
        Il hot-path deterministico resta `decide()`, che non chiama mai l'LLM.
      Input/Output:
        - Input: Nessun cambio HTTP; l'`aiDraft` (ora async) iniettato in `InterventionService`.
        - Success Output: Env presente → l'adattatore genera la bozza; il Safety Layer la valida; bozza sicura → consegnata, altrimenti fallback al template.
        - Failure Output: Errore LLM → `aiDraft` risolve `undefined` → fallback al template (comportamento già presente in `composeMessage`).
      AC:
        - [ ] AC-1: La porta `aiDraft` di `InterventionService` diventa `(ctx) => Promise<string | undefined>` ed è `await`-ata in `handleTick`; il comportamento è invariato quando `aiDraft` è assente.
        - [ ] AC-2: Nuovo `LlmCopyWriter` in `apps/backend` fornisce `aiDraft(ctx): Promise<string | undefined>` via transport Anthropic iniettabile (riuso `LlmComplete`/pattern di COD-14, `fetch`, nessun SDK); API key da env.
        - [ ] AC-3: Ogni output LLM passa per il Safety Layer esistente (`composeMessage`) prima della consegna; output non-safe → `source:"template"`/fallback (mai consegnato non-safe).
        - [ ] AC-4: Selezione per-config in `main.ts`: `ANTHROPIC_API_KEY` presente → `LlmCopyWriter` iniettato; assente → nessun `aiDraft` (template, default dev/test). Il log indica quale è attivo.
        - [ ] AC-5: Test ermetici: transport iniettato (fake, nessuna rete); output non-safe → fallback verificato; errore transport → `undefined` → fallback; il tick resta verde.
      Out of Scope (Non-goals):
        - NG-1: Nessun bypass né modifica del Safety Layer di `@pa/intervention-writer`.
        - NG-2: Nessun LLM in `decide()` (hot-path decisionale deterministico); l'LLM tocca solo la *composizione del testo*.
        - NG-3: Nessun segreto committato — solo lettura da env.
        - NG-4: Nessun cambio ai contratti HTTP né alla forma di `MessageContext`.
      Constraints: Riusare il transport `fetch` iniettabile di COD-14 (`LlmComplete`, nessun SDK, §1.4); riusare il Safety Layer di `@pa/intervention-writer` senza modificarlo. Cambiare la firma di `aiDraft` in `@pa/intervention-service` da sync ad async è **in scope** (unico cambio permesso a quel pacchetto). `MessageContext` invariato.
      Files: apps/backend/src/llm-copywriter.ts (nuovo), apps/backend/src/main.ts, .env.example, packages/intervention-service/src/service.ts (firma aiDraft → async), apps/backend/test/*, packages/intervention-service/test/*
      Tests: "llm-copy": safe→consegnato (source ai), unsafe→fallback template, errore→fallback, selezione da env, nessuna rete; test esistenti di InterventionService aggiornati alla porta async e verdi.
      Verify:
        1. con `ANTHROPIC_API_KEY` (fittizia) → log copywriter LLM; bozze (mock) validate dal Safety Layer
        2. senza env → template invariati.
      Risk: Medio — cambia la firma di `aiDraft` in `@pa/intervention-service` (sync→async); isolato, tutti i call-site aggiornati e testati.
      After: llm-intent-adapter

- [ ] (slug: api-auth) Autenticazione a bearer token condiviso dietro env (aperto di default)
      Goal: Proteggere tutte le rotte (tranne `/health`) con un bearer token letto da env; assente → aperto, comportamento dev/test invariato.
      Problem: Il backend non ha alcuna autenticazione — `grep` su server/api non trova nulla. Chiunque conosca l'URL può leggere/scrivere regole, memory, coach e far scattare/risolvere lo shield. È il prerequisito 🔴 per esporre il backend fuori da localhost.
      Input/Output:
        - Input: header `Authorization: Bearer <token>` su tutte le rotte tranne `GET /health`; token atteso dall'env `PA_AUTH_TOKEN`.
        - Success Output: token valido → richiesta procede invariata; `PA_AUTH_TOKEN` non settata → nessun controllo (default dev/test).
        - Failure Output: 401 "unauthorized" quando `PA_AUTH_TOKEN` è settata e l'header manca o non combacia.
      AC:
        - [ ] AC-1: Con `PA_AUTH_TOKEN` settata, ogni rotta tranne `/health` senza header valido → 401 "unauthorized".
        - [ ] AC-2: Con header `Authorization: Bearer <PA_AUTH_TOKEN>` corretto → la richiesta procede normalmente (stesse risposte di oggi).
        - [ ] AC-3: Con `PA_AUTH_TOKEN` non settata → nessun 401; tutti i test esistenti restano verdi senza modifiche.
        - [ ] AC-4: `GET /health` non richiede token (per gli health check dell'host).
      Out of Scope (Non-goals):
        - NG-1: Nessun multi-utente, login per-utente o Sign in with Apple.
        - NG-2: Nessun cambio alle forme di request/response delle rotte.
        - NG-3: Nessun rate-limiting.
      Constraints: Il controllo vive nel transport (`server.ts`), non nell'`Api`; token da env `PA_AUTH_TOKEN` passato via `main.ts`; confronto constant-time (`crypto.timingSafeEqual`); nessuna dipendenza nuova.
      Files: apps/backend/src/server.ts, apps/backend/src/main.ts, .env.example, apps/backend/test/*
      Tests: "auth": env settata → 401 senza header e 200 con header valido; `/health` esente; env non settata → aperto, suite invariata.
      Verify:
        1. PA_AUTH_TOKEN=segreto pnpm --filter @pa/backend dev
        2. curl -s -o /dev/null -w "%{http_code}" http://localhost:8788/coach → 401
        3. curl -H "Authorization: Bearer segreto" http://localhost:8788/coach → 200
        4. curl http://localhost:8788/health → 200 (senza header)
      Risk: Basso, isolato nel transport.
      After: (nessuno)

- [ ] (slug: prod-runtime) Avvio di produzione + spegnimento pulito del backend
      Goal: Un comando `start` che boota il server leggendo PORT/PA_DB_PATH e uno spegnimento pulito su SIGTERM/SIGINT, così il backend può girare su un host reale invece che solo in `dev`.
      Problem: Esiste solo lo script `dev` (tsx). Per ospitare il backend su un host serve un avvio stabile e uno shutdown che chiuda il server (e il Db in durable mode) senza troncare richieste in volo. Gap 🔴 verso l'hosting.
      Input/Output:
        - Input: `pnpm --filter @pa/backend start` con env PORT/PA_DB_PATH.
        - Success Output: il server ascolta su PORT, `GET /health` → 200; su SIGTERM chiude server (e Db in durable mode) ed esce con codice 0.
        - Failure Output: errore di boot (es. porta occupata) → log chiaro ed exit code ≠ 0.
      AC:
        - [ ] AC-1: `apps/backend/package.json` ha uno script `start` che avvia `src/main.ts` leggendo PORT e PA_DB_PATH.
        - [ ] AC-2: `main.ts` intercetta SIGTERM e SIGINT: chiude il server HTTP e, in durable mode, il `Db`, poi exit 0.
        - [ ] AC-3: Test di boot: il server parte su porta effimera, `GET /health` → 200, poi lo shutdown chiude senza errori.
        - [ ] AC-4: Nessun cambio ai contratti HTTP; le rotte si comportano come prima.
      Out of Scope (Non-goals):
        - NG-1: Nessuna scelta di provider di hosting né file di deploy (Dockerfile/fly.toml) — resta di tua competenza (host non ancora scelto).
        - NG-2: Nessun clustering / multi-processo / PM2.
        - NG-3: Nessun cambio alla logica delle rotte o allo storage.
      Constraints: Solo stdlib Node (§1.4); riusare `createDb`/`createApiServer` esistenti; lo shutdown deve essere idempotente.
      Files: apps/backend/package.json, apps/backend/src/main.ts, apps/backend/test/*
      Tests: "prod-runtime": boot su porta effimera → /health 200; segnale di shutdown → server chiuso, nessuna eccezione.
      Verify:
        1. pnpm --filter @pa/backend start & sleep 1
        2. curl http://localhost:8788/health → 200
        3. kill -TERM %1 → il processo esce pulito (codice 0)
      Risk: Basso, isolato nell'entrypoint.
      After: (nessuno)

- [ ] (slug: ops-health-logging) Readiness `/health` + logging strutturato per richiesta
      Goal: Trasformare `/health` in una vera readiness (riporta modalità storage e, in durable mode, che il DB risponde) e loggare una riga strutturata per ogni richiesta.
      Problem: `/health` risponde sempre `{status:"ok"}` anche se il DB è morto, e non c'è alcun log per richiesta: in produzione saresti cieco su errori e latenza. Gap 🟡 di osservabilità.
      Input/Output:
        - Input: `GET /health`; ogni richiesta HTTP.
        - Success Output: 200 `{ status:"ok", storage:"memory" }` in memory mode; in durable mode esegue `SELECT 1` e risponde `{ status:"ok", storage:"durable", db:"ok" }`.
        - Failure Output: in durable mode, se `SELECT 1` fallisce → 503 `{ status:"degraded", storage:"durable", db:"error" }`.
      AC:
        - [ ] AC-1: In memory mode `GET /health` → 200 `{status:"ok", storage:"memory"}`.
        - [ ] AC-2: In durable mode `/health` esegue `SELECT 1`; ok → 200 con `db:"ok"`; query in errore → 503 con `db:"error"`.
        - [ ] AC-3: Ogni richiesta emette una riga di log strutturata su stdout con method, path, status e durationMs; disattivabile via env `PA_LOG=off` (default off nei test per non sporcare l'output).
        - [ ] AC-4: Nessun cambio alle forme di response delle altre rotte.
      Out of Scope (Non-goals):
        - NG-1: Nessun sistema esterno di metriche/tracing (Prometheus/OpenTelemetry).
        - NG-2: Nessun logging di body/payload — solo metadati (method/path/status/durata).
        - NG-3: Nessun cambio ai contratti delle altre rotte.
      Constraints: La readiness usa il `Db` iniettato in `Api`; il logging vive nel transport (`server.ts`); solo stdlib, nessuna dipendenza nuova.
      Files: apps/backend/src/server.ts, apps/backend/src/api.ts, apps/backend/src/main.ts, .env.example, apps/backend/test/*
      Tests: "health-readiness": memory→ok/storage:memory; durable con Db reale (PGlite)→db:ok; Db che lancia→503 db:error. "req-log": una richiesta con PA_LOG on produce una riga con i campi attesi; con PA_LOG=off nessuna riga.
      Verify:
        1. pnpm --filter @pa/backend dev → curl /health → {status:ok, storage:memory}
        2. PA_DB_PATH=./data pnpm --filter @pa/backend dev → curl /health → {status:ok, storage:durable, db:ok}
      Risk: Basso, isolato in health + transport.
      After: (nessuno)

---

> **Nota architetturale (confine ridefinito — vincolo iOS confermato).** Su iOS
> il tracking passa **solo** dallo Screen Time API di Apple (on-device): il
> rilevamento e il blocco (shield) stanno **sul dispositivo**, non sul backend. Il
> backend NON è più il cervello real-time — fa **config + coach LLM + storico +
> sync** (vedi `CLAUDE.md §1.7`). Perciò gli item del loop qui sopra sono
> ri-centrati sull'**agente LLM** (il moat) e sulla config; la push server-driven
> resta solo un canale *secondario* di nudge remoti, non l'enforcement.

## Non-loop — di tua competenza (il loop NON può costruirli)

Questi NON sono in formato item (niente `slug`), quindi l'orchestrator li ignora
di proposito.

- **iOS — signing & run su device (`personal-agent-phase0`).** Sbloccato dall'Apple
  Developer Program a pagamento. Da fare in Xcode: generare il progetto da
  `project.yml` (XcodeGen), selezionare il team, far registrare i 4 App ID con
  Family Controls (Development) + App Group `group.com.utentra.personalagent.phase0`,
  installare su iPhone fisico (Screen Time non gira nel Simulator).
- **iOS — richiesta entitlement Family Controls *distribution* ad Apple** (collo di
  bottiglia sui tempi): https://developer.apple.com/contact/request/family-controls-distribution
  — chiederla il giorno 1 se punti a TestFlight/App Store.
- **iOS — puntare il client a un backend vivo:** l'URL `trycloudflare` in
  `Shared/Constants.swift` è effimero/morto; sostituirlo con l'URL stabile
  dell'host (o un tunnel/IP LAN per il test locale) e ricompilare.
- **iOS — mandare il bearer token** (header `Authorization`) dal `NetworkManager`
  e dal `MonitorExtension` una volta attivo l'item `api-auth` lato backend.
- **Hosting & deploy del backend:** scegliere il provider (Fly.io / Railway / Render
  / VPS) e scrivere la config di deploy (Dockerfile/`fly.toml`) + volume persistente
  per `PA_DB_PATH` + backup del file PGlite. Il codice è reso ospitabile dagli item
  `prod-runtime` e `ops-health-logging`; la scelta dell'host e i secret restano tuoi.

- **Spike Screen Time API (PRIORITÀ #1) — ora è "definire il contratto", non "se è
  fattibile".** Il vincolo è confermato: solo FamilyControls / DeviceActivity /
  ManagedSettings, on-device, con token opachi e callback su soglie (non stream
  real-time). Sul repo nativo `personal-agent-phase0`, determinare esattamente:
  quali eventi/soglie espone DeviceActivity, come si applica lo shield, e **il
  contratto device↔backend** (che config scarica il device, che riepiloghi d'uso
  ri-manda). Da qui escono i candidati backend sotto.
- **Ridefinizione del confine backend/client** — fatta a livello di visione in
  `CLAUDE.md §1.7`; i dettagli d'implementazione dipendono dal contratto sopra.

## Candidati backend — da specificare DOPO il contratto del device

Non ancora item perché speccarli ora vorrebbe dire **indovinare** il contratto del
client (vietato dalla §3 di CLAUDE.md). Diventano item del loop appena lo spike
fissa le forme esatte:

- **config-sync** — endpoint read con cui il device scarica le sue regole/limiti
  (autorate dall'agente LLM).
- **usage-report** — endpoint per riepiloghi d'uso batch dal device → storico
  (probabile riuso/rimodellazione di `/usage`, non più trigger real-time).
- **device-register** — registrazione del device token per le push **secondarie**
  (nudge remoti/coaching); serve solo se useremo push remote oltre allo shield
  on-device. (Spec bozza già pronta se serve: `POST /devices { token, platform }`,
  upsert in tabella `devices`.)
- **multi-utente** (Sign in with Apple, dati scoped per utente) — più avanti.
  L'auth base a bearer token è invece già un item attivo (`api-auth`) qui sopra.

> **Aggiornamento contratto device (2026-07-29).** Il contratto device↔backend
> non è più da indovinare: letto dal client reale, il device chiama solo
> `/chat/draft`, `/rules/confirm`, `/seatbelt/trigger`, `/seatbelt/resolved`
> (il rilevamento e lo shield sono on-device). `config-sync` e `usage-report`
> restano opzionali/futuri perché **il client attuale non li invoca**; diventano
> item solo se/quando il client inizierà a scaricarli.

