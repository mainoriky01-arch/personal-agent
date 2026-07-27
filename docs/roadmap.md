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
      Input/Output:
        - Input: Nessun cambio HTTP; l'`aiDraft` iniettato in `InterventionService`.
        - Success Output: Env presente → l'adattatore genera la bozza; il Safety Layer la valida; bozza sicura → consegnata, altrimenti fallback al template.
        - Failure Output: Errore LLM → fallback al template (comportamento già presente in `composeMessage`).
      AC:
        - [ ] AC-1: Nuovo `LlmCopyWriter` fornisce `aiDraft(ctx)` via SDK Anthropic; API key da env.
        - [ ] AC-2: Ogni output LLM passa per il Safety Layer esistente prima della consegna; output non-safe → fallback al template.
        - [ ] AC-3: Selezione per-config in `main.ts`; default template in dev/test.
        - [ ] AC-4: Test ermetici: client iniettato; output non-safe → fallback; nessuna rete.
      Out of Scope (Non-goals):
        - NG-1: Nessun bypass del Safety Layer.
        - NG-2: Nessun LLM nella decisione di intervento (solo copy).
        - NG-3: Nessun segreto committato.
      Constraints: Come `llm-intent-adapter` (SDK Anthropic, env, client iniettabile); riusare il Safety Layer di `@pa/intervention-writer` senza modificarlo.
      Files: apps/backend/src/llm-copywriter.ts (nuovo), apps/backend/src/main.ts, .env.example, apps/backend/test/*
      Tests: "llm-copy": safe→consegnato, unsafe→fallback template, selezione da env, nessuna rete.
      Verify:
        1. con env → bozze LLM (mock) validate dal Safety Layer
        2. senza env → template invariati.
      Risk: Medio.
      After: llm-intent-adapter

- [ ] (slug: device-register) Registrazione del device token APNs
      Goal: Un endpoint per registrare/aggiornare il device token APNs dell'utente, così le push reali hanno un destinatario persistito.
      Problem: `ApnsDeliverer` legge il token da env (COD-10 NG-2): un solo device statico. Per un utente reale il token va registrato dal client e conservato.
      Input/Output:
        - Input: `POST /devices { token, platform }` con `platform: "ios"`.
        - Success Output: 200/201 con device registrato (upsert per (user, token)) nella tabella `devices` esistente.
        - Failure Output: 400 "token_required" / "platform_invalid".
      AC:
        - [ ] AC-1: `POST /devices` fa upsert del token per l'utente di default nella tabella `devices`.
        - [ ] AC-2: In durable mode il token sopravvive al riavvio (test di persistenza).
        - [ ] AC-3: Body invalido → 400; `platform` non in {ios} → 400.
        - [ ] AC-4: Test: registra → persistito → riletto.
      Out of Scope (Non-goals):
        - NG-1: Nessuna auth/verifica proprietà del token (single default user).
        - NG-2: Nessun invio APNs reale nei test.
        - NG-3: Nessun cablaggio del token dentro `ApnsDeliverer` in questo item (follow-up separato).
      Constraints: Usare la tabella `devices` già nello schema; nuovo `PgDeviceRepo`; nessun cambio alla logica di rete APNs.
      Files: apps/backend/src/db/pg-device-repo.ts (nuovo), apps/backend/src/api.ts, apps/backend/src/server.ts, apps/backend/test/*
      Tests: "device-register": upsert + persistenza durevole; validazioni 400.
      Verify:
        1. PA_DB_PATH=./data pnpm --filter @pa/backend dev
        2. POST /devices con token/platform → 200
        3. riavvia → il token è ancora presente.
      Risk: Medio, isolato nella persistenza device.
      After: (nessuno — APNs COD-10 già merged)

---

## Non-loop — di tua competenza (il loop NON può costruirli)

Questi NON sono in formato item (niente `slug`), quindi l'orchestrator li ignora
di proposito: richiedono lavoro nativo/di ricerca fuori da questo backend.

- **Spike di fattibilità piattaforma (PRIORITÀ #1).** Verificare, sul repo nativo
  `personal-agent-phase0`, cosa può realmente fare il client: su iOS il tracking
  in tempo reale passa solo dallo Screen Time API (FamilyControls/DeviceActivity,
  on-device, sandboxato) e il "bombardamento push server-driven" rischia di essere
  infattibile / rifiutato in review. Esito atteso: decidere se detection+shield
  stanno on-device (probabile) e cosa resta al backend.
- **Ridefinizione del confine backend/client** in base allo spike (probabile:
  detection+shield on-device; backend = config, coach, storico, sync).
- **Auth / multi-utente reale** (Sign in with Apple) — da specificare come item di
  roadmap solo dopo la decisione sul confine.

