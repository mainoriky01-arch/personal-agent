import { MemoryStore } from "./repos.js";
import { AiOrchestrationService, type IntentExtractor } from "./orchestration.js";
import { Api } from "./api.js";
import { createApiServer } from "./server.js";

/**
 * Runnable entrypoint. Boots the HTTP API on PORT (default 8788).
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

const port = Number(process.env.PORT ?? 8788);
const store = new MemoryStore();
const ai = new AiOrchestrationService(stubExtractor);
const api = new Api(store, ai);
const server = createApiServer(api);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[pa-backend] listening on http://127.0.0.1:${port}`);
});
