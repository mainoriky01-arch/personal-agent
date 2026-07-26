# CLAUDE.md — Operating Guidelines

This file is the authoritative reference for agents working in this repository. It defines development commands, architecture, codebase vision, and the contract rules for roadmaps and automated PR generation.

---

## 1. Global Context & Vision

### 1.1 Vision
Personal Agent is a behavioral and educational agent that non-magically monitors digital distractions and applies deterministic state-machine interventions (such as push alarms, nudges, and restrictions) to help Riccardo stay focused and build healthy habits. The intervention channel is **push** (delivered through the `Deliverer` port); there is no iMessage channel.

### 1.2 Current State
Assessed against merged `main`, the in-flight PRs, and the persistence backlog (COD-1…COD-4). Keep this section honest: distinguish what actually runs on `main` from what is only proposed in an open PR or still planned.

* **Operational on `main`:** Pristine TypeScript monorepo — 5 packages + 1 backend — with a fully passing Vitest suite.
  * **Deterministic Engine:** `@pa/rule-engine` is a pure function (`decide()`) controlling state-machine transitions (cooldown, quiet hours, sessions, daily budget limits, emergency bypasses) with no hot-path LLM calls.
  * **Rule Drafting:** `@pa/rule-drafting` translates raw input text to validated rule proposals.
  * **Message Synthesis:** `@pa/intervention-writer` contains templates and a deterministic `Safety Layer` blocking negative or discouraging language.
  * **Database (PGlite):** SQL layer powered by PGlite (WASM Postgres in-process). `createTestDb()` applies `schema.sql` for hermetic integration tests. `PgSessionRepo` (`apps/backend/src/db/pg-session-repo.ts`) is implemented and integration-tested (`pg-repo.test.ts`) but **not yet wired** into the running server. `PgHabitRepo`, `PgRuleRepo`, `PgMemoryRepo`, and `PgCoachRepo` **do not exist yet** — they are delivered by COD-3/COD-4.
  * **HTTP API:** Pure Node.js `http` server (no Express/Fastify — zero unnecessary dependencies) at `apps/backend/src/server.ts`. Live routes: `GET /health`, `POST /chat/draft`, `POST /habits`, `POST /rules/confirm`, `GET/POST /memory`, `DELETE /memory/:id`, `PATCH /rules/:id/suspend`. All config, memory, and session data currently lives in the in-memory `MemoryStore` / `InMemorySessionRepo`.

* **In-flight (open PRs, not yet merged):**
  * **COD-1 (PR #2) — push alarm path:** adds `POST /usage` (phone → engine → alarm). It computes `distractionDetected` and drives `InterventionService.handleTick()`, delivering on the **push** channel via a stub `PushDeliverer`. Reviewed: `loop-approved`.
  * **COD-2 (PR #3) — durable DB foundation:** adds `createDb(path)` (file-backed PGlite + idempotent `schema.sql` bootstrap), a `PA_DB_PATH`-selected durable-vs-in-memory mode, and an idempotent default local user. Domain entities remain in `MemoryStore`. Awaiting review.

* **Planned (agent-ready backlog):**
  * **COD-3 — persist user config:** real pg repos for habits/commitments/rules/rule_exceptions scoped to the default user, and the matching `Api` handlers made async; HTTP route shapes stay identical.
  * **COD-4 — persist intervention path + memory + coach:** wire `PgSessionRepo`, add pg memory/coach repos, and make `deleteAccount` wipe durable data.

* **Mocked / Stubbed:**
  * **Push Delivery:** stub `PushDeliverer` (COD-1) records deliveries in-memory and returns a synthetic id — no real APNs certificates/tokens/retry. This lets the full usage → engine → alarm path run and be tested without device infrastructure.
  * **LLM Calls:** Injected via ports (`IntentExtractor`, `CopyWriter`) in `apps/backend/src/orchestration.ts`. No network-dependent SDK calls exist in the core hot-path.
  * **Shield Extensions:** Native OS blocking controls (iOS/macOS Shield clients) are managed by external clients (e.g. `personal-agent-phase0`) communicating via backend API triggers.

### 1.3 Architecture
Standard modern `pnpm` monorepo.
* `@pa/shared-types` (`packages/shared-types`): Shared domain model contracts, types, and state enums.
* `@pa/rule-engine` (`packages/rule-engine`): Pure deterministic rule evaluator.
* `@pa/rule-drafting` (`packages/rule-drafting`): Plain text to structured rules mapping.
* `@pa/intervention-writer` (`packages/intervention-writer`): Safe copywriting and fallback generation.
* `@pa/intervention-service` (`packages/intervention-service`): Lifecycle orchestration of rule triggering.
* `@pa/backend` (`apps/backend`): REST endpoint server + PGlite storage layer.

### 1.4 Non-Negotiable Constraints
* **Language & Style:** Strict TypeScript. Use native module syntax (`import ... from "./foo.js"` / specifiers must include extension where necessary).
* **Minimalist Dependencies:** The backend uses Node's standard `http` module. Do not introduce large web frameworks.
* **Deterministic Hot Path:** Never execute LLM calls to decide whether to intervene. The engine must remain a fast, pure, reproducible function.
* **Safety First:** All composed copy must run through `Safety Layer` validation.

### 1.5 Definition of "Done"
A task is done only when:
1. `pnpm -r typecheck` is fully green.
2. `pnpm run test` executes successfully and all 88+ tests are green.
3. `pnpm -r build` passes with zero compiler/bundler failures.
4. HTTP REST endpoints do not break backward compatibility.

### 1.6 Test Environment
* Runs entirely locally, using Vitest.
* PGlite operates in-process, meaning the real Postgres SQL tests run inside any standard CI environment with zero database setup required.
* Push delivery is an in-memory stub (no network, no APNs), so the full usage → engine → alarm path is exercised end-to-end without device infrastructure or secrets, keeping tests stable and hermetic.

---

## 2. Command Reference

```bash
pnpm install                     # Install monorepo dependencies
pnpm run test                    # Run all Vitest tests across the repository
pnpm -r typecheck                # Check TypeScript compilation rules for all packages
pnpm -r build                    # Build every package and application
pnpm --filter @pa/backend dev     # Launch backend on http://127.0.0.1:8788
```

---

## 3. Automated Spec & Roadmap Contract (Finn-loop)

To prevent scope creep and guarantee high-quality execution by autonomous coding loops, all items added to the roadmap or Linear backlog must strictly follow these rules:

### 3.1 Three Core Principles
1. **One PR per Item:** One issue = exactly one pull request. If an item cannot be described without "and then also...", it MUST be split into two separate issues. Diff target: < 400 lines of change.
2. **Binary Acceptance Criteria (AC):** Every criterion must be strictly true or false by examining the code or running a test. Avoid subjective words like "well", "fast", or "user-friendly".
3. **Explicit Non-goals (NG):** State what the agent must NOT change. Anything not explicitly listed as a non-goal is subject area the AI might drift into.

### 3.2 Roadmap Item Schema

Each item must be written in this format:

```md
- [ ] (slug: <short-id>) <Active Title>
      Goal: <One-sentence concrete objective>
      Problem: <Why is this needed right now? What is blocked without it?>
      Input/Output:
        - Input: <Exact schema, types, or API payload shape>
        - Success Output: <Exact response payload or DB updates>
        - Failure Output: <Specific HTTP codes and reason strings>
      AC:
        - [ ] AC-1: <Binary assertion 1>
        - [ ] AC-2: <Binary assertion 2>
      Out of Scope (Non-goals):
        - NG-1: <Boundary limitation 1>
        - NG-2: <Boundary limitation 2>
      Constraints: <Specific files to touch, interfaces to respect, or package limits>
      Files: <List of files/directories where code must live>
      Tests: <Expected custom test names and behavior verification assertions>
      Verify: <Numbered manual CLI/curl verify steps>
      Risk: <None / Impacted components>
      After: <Optional prerequisite slug>
```

### 3.3 Anti-patterns to Avoid
* ❌ **Subjective ACs:** "The database write should be fast and bulletproof."
* ❌ **Huge Epics:** "Implement SQLite storage." (Write "Persist Habits into PGlite database" instead).
* ❌ **Implicit Dependencies:** Leaving out ordering. Always specify prerequisites explicitly with `After:`.
* ❌ **Missing Non-goals:** Not defining boundaries, which leads to automated agents refactoring adjacent packages.

### 3.4 Excellent Example in Practice

```md
- [ ] (slug: persist-habits) Persisti gli habits sul DB durevole
      Goal: Gli habits sopravvivono al riavvio quando PA_DB_PATH è settato.
      Problem: Attualmente gli habits vivono solo in memoria, causando perdita dati al riavvio del server.
      Input/Output:
        - Input: Nessun cambiamento ai contratti HTTP; stessa POST /habits.
        - Success Output: Status 201 con habit creato, riga inserita in pglite.
        - Failure Output: 400 "title_required".
      AC:
        - [ ] AC-1: Quando PA_DB_PATH è configurato, POST /habits scrive su PGlite durevole.
        - [ ] AC-2: Al riavvio del server con lo stesso PA_DB_PATH, GET /habits restituisce l'habit persistito.
        - [ ] AC-3: Se PA_DB_PATH non è settato, il comportamento in-memory rimane inalterato.
        - [ ] AC-4: Il record viene inserito associato a user_id dell'utente corrente de-serializzato.
      Out of Scope (Non-goals):
        - NG-1: Nessuna sincronizzazione cloud o esportazione.
        - NG-2: Nessuna autenticazione utente implementata in questa fase.
        - NG-3: Nessun tool per migrare database pregressi.
      Constraints: Mantenere l'interfaccia Repo invariata; non aggiungere il pacchetto 'pg' nativo.
      Files: apps/backend/src/repos.ts, apps/backend/src/db/*.ts
      Tests: Nuovo test induttivo "habit persiste tra reopen"; tutti i test in-memory verdi.
      Verify:
        1. PA_DB_PATH=./data pnpm --filter @pa/backend dev
        2. curl -X POST -H "Content-Type: application/json" -d '{"title":"Leggere"}' http://localhost:8788/habits
        3. Arresta server (Ctrl+C)
        4. Riavvia server
        5. curl http://localhost:8788/habits -> controlla la presenza dell'habit registrato.
      Risk: Basso, isolato nella persistenza degli habits.
      After: cod-2-durable-db
```
