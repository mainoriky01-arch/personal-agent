import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createApiServer, type ServerOptions } from "../src/server.js";
import { createTestDb, type Db } from "../src/db/db.js";

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

// db is the 8th constructor arg; undefined → in-memory readiness.
const apiWith = (db?: Db) =>
  new Api(new MemoryStore(), new AiOrchestrationService(new FakeExtractor()), undefined, undefined, undefined, undefined, undefined, db);

async function withServer<T>(
  api: Api,
  options: ServerOptions,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createApiServer(api, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Readiness /health (COD-18)", () => {
  it("AC-1: in-memory mode → 200 {status:ok, storage:memory} (no db field)", async () => {
    await withServer(apiWith(), {}, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", storage: "memory" });
    });
  });

  it("AC-2 (ok): durable mode with a live Db → 200 {status:ok, storage:durable, db:ok}", async () => {
    const db = await createTestDb();
    try {
      await withServer(apiWith(db), {}, async (base) => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ok", storage: "durable", db: "ok" });
      });
    } finally {
      await db.close();
    }
    // createTestDb boots a fresh PGlite (~several seconds), past the default 5s.
  }, 20000);

  it("AC-2 (error): durable mode where SELECT 1 throws → 503 degraded, no 500", async () => {
    const brokenDb: Db = {
      query: async () => {
        throw new Error("db down");
      },
      tx: async (fn) => fn(brokenDb),
    };
    await withServer(apiWith(brokenDb), {}, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "degraded", storage: "durable", db: "error" });
    });
  });
});

describe("Per-request logging (COD-18)", () => {
  it("AC-3: with log enabled, one structured line per request (method/path/status/durationMs)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await withServer(apiWith(), { log: true }, async (base) => {
        await fetch(`${base}/health`);
        // 'finish' fires on the server after the response is flushed.
        await new Promise((r) => setTimeout(r, 30));
      });
      const lines = spy.mock.calls
        .map((c) => c[0])
        .filter((a): a is string => typeof a === "string")
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter((o): o is Record<string, unknown> => o !== null && "durationMs" in o);
      expect(lines).toHaveLength(1);
      expect(lines[0].method).toBe("GET");
      expect(lines[0].path).toBe("/health");
      expect(lines[0].status).toBe(200);
      expect(typeof lines[0].durationMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  it("AC-3: with logging off (default), no request log line is emitted", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await withServer(apiWith(), {}, async (base) => {
        await fetch(`${base}/health`);
        await new Promise((r) => setTimeout(r, 30));
      });
      const logLines = spy.mock.calls
        .map((c) => c[0])
        .filter((a): a is string => typeof a === "string")
        .filter((s) => s.includes("durationMs"));
      expect(logLines).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
