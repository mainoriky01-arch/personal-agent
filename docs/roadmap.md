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
- **auth / multi-utente** (Sign in with Apple) — più avanti (tua indicazione).

