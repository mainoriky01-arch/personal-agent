import { InterventionService, type Clock, type IdGen, type SessionRepo } from "@pa/intervention-service";
import {
  MemoryStore,
  InMemorySessionRepo,
  type ConfigRepo,
  type MemoryRepo,
  type CoachRepo,
  type UsageRepo,
} from "./repos.js";
import { AiOrchestrationService, type IntentExtractor } from "./orchestration.js";
import { PushDeliverer } from "./push-deliverer.js";
import { ApnsDeliverer, apnsConfigFromEnv } from "./apns-deliverer.js";
import { LlmIntentExtractor, llmConfigFromEnv, fetchComplete } from "./llm-intent-extractor.js";
import { LlmCopyWriter } from "./llm-copywriter.js";
import { Api } from "./api.js";
import { createApiServer } from "./server.js";
import { createShutdown } from "./runtime.js";
import { createDb, type Db } from "./db/db.js";
import { ensureDefaultUser } from "./db/default-user.js";
import { PgConfigRepo } from "./db/pg-config-repo.js";
import { PgMemoryRepo } from "./db/pg-memory-repo.js";
import { PgCoachRepo } from "./db/pg-coach-repo.js";
import { PgUsageRepo } from "./db/pg-usage-repo.js";
import { PgSessionRepo } from "./db/pg-session-repo.js";

/**
 * Runnable entrypoint. Boots the HTTP API on PORT (default 8788).
 *
 * Storage mode is chosen by `PA_DB_PATH`:
 *   - set   → durable mode: open a file-backed PGlite at that path, apply the
 *             schema, and ensure the default local user (COD-2 foundation).
 *   - unset → in-memory mode: the current MemoryStore / InMemorySessionRepo.
 *
 * NOTE (COD-4): in durable mode user config (PgConfigRepo), memory
 * (PgMemoryRepo), coach (PgCoachRepo) and the intervention session path
 * (PgSessionRepo) are all pg-backed. Unset PA_DB_PATH → everything in-memory.
 *
 * The IntentExtractor here is a minimal keyword stub so the server runs with no
 * API keys. In production this is replaced by the real LLM adapter (spec §23.6).
 */

const stubExtractor: IntentExtractor = {
  async extract(text: string) {
    // Extremely small heuristic — real system uses an LLM. Enough to boot/demo.
    const lower = text.toLowerCase();
    return {
      goal: lower.includes("legg") ? "leggere" : undefined,
      interferingApps: lower.includes("instagram") ? ["instagram"] : undefined,
    };
  },
};

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8788);
  const dbPath = process.env.PA_DB_PATH;

  // Durable mode (PA_DB_PATH set) persists config, memory, coach and the
  // intervention session path in pg; unset keeps everything in the in-memory
  // store / InMemorySessionRepo.
  let config: ConfigRepo | undefined;
  let memory: MemoryRepo | undefined;
  let coach: CoachRepo | undefined;
  let usage: UsageRepo | undefined;
  let dbRef: Db | undefined;
  // Closes the durable Db on shutdown; undefined in in-memory mode (COD-17).
  let closeDb: (() => Promise<void>) | undefined;
  let timezone: string | undefined;
  let sessionRepo: SessionRepo = new InMemorySessionRepo();
  if (dbPath) {
    const db = await createDb(dbPath);
    const userId = await ensureDefaultUser(db);
    dbRef = db;
    closeDb = () => db.close();
    config = new PgConfigRepo(db);
    memory = new PgMemoryRepo(db);
    coach = new PgCoachRepo(db);
    usage = new PgUsageRepo(db);
    sessionRepo = new PgSessionRepo(db);
    // The /usage window is resolved in the user's timezone (COD-7).
    const { rows } = await db.query<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [userId]);
    timezone = rows[0]?.timezone;
    // eslint-disable-next-line no-console
    console.log(`[pa-backend] durable mode (PGlite file: ${dbPath}) — default user ${userId} (tz ${timezone})`);
  } else {
    // eslint-disable-next-line no-console
    console.log("[pa-backend] in-memory mode (set PA_DB_PATH to enable durable storage)");
  }

  const store = new MemoryStore();
  // Intent extraction (§23.6, COD-14): real LLM adapter when ANTHROPIC_API_KEY is
  // set, else the keyword stub (the dev/test default) — no key, no network.
  const llmConfig = llmConfigFromEnv(process.env);
  const extractor: IntentExtractor = llmConfig
    ? new LlmIntentExtractor(fetchComplete(llmConfig))
    : stubExtractor;
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] intent extractor: ${llmConfig ? `LLM (${llmConfig.model})` : "keyword stub"}`);
  const ai = new AiOrchestrationService(extractor);

  // Intervention path (§23.5): deterministic engine + push delivery (§23.8).
  // The clock is real here; tests inject a fixed one. The deliverer is chosen by
  // config (COD-10): real APNs when its env is present, else the in-memory stub
  // (the dev/test default) — so nothing network-dependent runs without secrets.
  const clock: Clock = { nowIso: () => new Date().toISOString() };
  let idSeq = 0;
  const ids: IdGen = { next: (prefix) => `${prefix}_${++idSeq}` };
  const apnsConfig = apnsConfigFromEnv(process.env);
  const deliverer = apnsConfig ? new ApnsDeliverer(apnsConfig) : new PushDeliverer();
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] push delivery: ${apnsConfig ? "APNs" : "in-memory stub"}`);

  // Intervention copy (§23.6, COD-15): when ANTHROPIC_API_KEY is set, an LLM
  // copywriter drafts the message; it is UNTRUSTED and still passes the Safety
  // Layer inside composeMessage. Absent → no aiDraft, deterministic templates
  // (the dev/test default). Reuses the same env config as the intent extractor.
  const copywriter = llmConfig ? new LlmCopyWriter(fetchComplete(llmConfig)) : undefined;
  const aiDraft = copywriter ? copywriter.write.bind(copywriter) : undefined;
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] intervention copy: ${copywriter ? `LLM (${llmConfig!.model})` : "template"}`);
  const intervention = new InterventionService(sessionRepo, clock, deliverer, ids, aiDraft);

  const api = new Api(store, ai, intervention, clock, config, memory, coach, dbRef, timezone, usage);

  // Auth (COD-16): when PA_AUTH_TOKEN is set, every route except GET /health
  // requires `Authorization: Bearer <token>`; unset → open (the dev/test
  // default, and what the current client expects).
  const authToken = process.env.PA_AUTH_TOKEN?.trim() || undefined;
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] auth: ${authToken ? "bearer token (PA_AUTH_TOKEN set)" : "open (PA_AUTH_TOKEN unset)"}`);
  // Per-request logging (COD-18): on by default, disabled with PA_LOG=off.
  const log = process.env.PA_LOG !== "off";
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] request log: ${log ? "on" : "off (PA_LOG=off)"}`);
  const server = createApiServer(api, { authToken, log });

  // Graceful shutdown (COD-17): on SIGTERM/SIGINT stop the server (and, in
  // durable mode, close the Db), then exit 0. `once` + the idempotent shutdown
  // keep a repeated or racing signal from double-closing.
  const shutdown = createShutdown(server, closeDb);
  const onSignal = (sig: NodeJS.Signals): void => {
    // eslint-disable-next-line no-console
    console.log(`[pa-backend] ${sig} received — shutting down`);
    shutdown().then(
      () => process.exit(0),
      (e) => {
        // eslint-disable-next-line no-console
        console.error("[pa-backend] shutdown error:", e);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[pa-backend] listening on http://127.0.0.1:${port}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[pa-backend] failed to start:", e);
  process.exit(1);
});
