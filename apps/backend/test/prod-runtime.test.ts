import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";
import { createShutdown } from "../src/runtime.js";

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {
      goal: "leggere",
      substituteBehavior: "lettura",
      days: [1, 2, 3, 4, 5],
      startMinuteOfDay: 1260,
      durationMinutes: 30,
      interferingApps: ["instagram"],
      intensity: "firm",
    };
  }
}

const makeApi = () => new Api(new MemoryStore(), new AiOrchestrationService(new FakeExtractor()));

describe("Production runtime — boot + graceful shutdown (COD-17)", () => {
  it("boots on an ephemeral port, serves /health, then shutdown closes the server", async () => {
    const server = createApiServer(makeApi());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // The server is up and serving.
    const res = await fetch(`${base}/health`, { headers: { connection: "close" } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(server.listening).toBe(true);

    // Shutdown stops the server without throwing.
    const shutdown = createShutdown(server);
    await shutdown();
    expect(server.listening).toBe(false);
  });

  it("shutdown is idempotent — a second call resolves without throwing", async () => {
    const server = createApiServer(makeApi());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const shutdown = createShutdown(server);
    await shutdown();
    // Second invocation returns the cached result, never re-closing or throwing.
    await expect(shutdown()).resolves.toBeUndefined();
    expect(server.listening).toBe(false);
  });

  it("closeDb is invoked exactly once during shutdown (durable mode wiring)", async () => {
    const server = createApiServer(makeApi());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    let closes = 0;
    const shutdown = createShutdown(server, async () => {
      closes += 1;
    });
    await shutdown();
    await shutdown(); // idempotent: must not close the Db again
    expect(closes).toBe(1);
    expect(server.listening).toBe(false);
  });
});
