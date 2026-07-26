import { InterventionService, type Clock, type IdGen } from "@pa/intervention-service";
import { MemoryStore, InMemorySessionRepo, type ConfigRepo } from "./repos.js";
import { AiOrchestrationService, type IntentExtractor } from "./orchestration.js";
import { PushDeliverer } from "./push-deliverer.js";
import { Api } from "./api.js";
import { createApiServer } from "./server.js";
import { createDb } from "./db/db.js";
import { ensureDefaultUser } from "./db/default-user.js";
import { PgConfigRepo } from "./db/pg-config-repo.js";

/**
 * Runnable entrypoint. Boots the HTTP API on PORT (default 8788).
 *
 * Storage mode is chosen by `PA_DB_PATH`:
 *   - set   → durable mode: open a file-backed PGlite at that path, apply the
 *             schema, and ensure the default local user (COD-2 foundation).
 *   - unset → in-memory mode: the current MemoryStore / InMemorySessionRepo.
 *
 * NOTE (COD-3): in durable mode user config (habits/commitments/rules) is
 * persisted via PgConfigRepo. Memory/coach and the intervention session path
 * still live in the in-memory store — they land in COD-4.
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

  // Durable mode persists user config (habits/commitments/rules) via PgConfigRepo
  // (COD-3); unset PA_DB_PATH keeps everything in the in-memory store.
  let config: ConfigRepo | undefined;
  if (dbPath) {
    const db = await createDb(dbPath);
    const userId = await ensureDefaultUser(db);
    config = new PgConfigRepo(db);
    // eslint-disable-next-line no-console
    console.log(`[pa-backend] durable mode (PGlite file: ${dbPath}) — default user ${userId}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("[pa-backend] in-memory mode (set PA_DB_PATH to enable durable storage)");
  }

  const store = new MemoryStore();
  const ai = new AiOrchestrationService(stubExtractor);

  // Intervention path (§23.5): deterministic engine + stub push delivery (§23.8).
  // The clock is real here; tests inject a fixed one. Swap PushDeliverer for the
  // real APNs adapter in production (COD-1 NG-2).
  const clock: Clock = { nowIso: () => new Date().toISOString() };
  let idSeq = 0;
  const ids: IdGen = { next: (prefix) => `${prefix}_${++idSeq}` };
  const intervention = new InterventionService(
    new InMemorySessionRepo(),
    clock,
    new PushDeliverer(),
    ids,
  );

  const api = new Api(store, ai, intervention, clock, config);
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
