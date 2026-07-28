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
import { Api } from "./api.js";
import { createApiServer } from "./server.js";
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
  let timezone: string | undefined;
  let sessionRepo: SessionRepo = new InMemorySessionRepo();
  if (dbPath) {
    const db = await createDb(dbPath);
    const userId = await ensureDefaultUser(db);
    dbRef = db;
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
  const intervention = new InterventionService(sessionRepo, clock, deliverer, ids);

  const api = new Api(store, ai, intervention, clock, config, memory, coach, dbRef, timezone, usage);
  const server = createApiServer(api);

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
