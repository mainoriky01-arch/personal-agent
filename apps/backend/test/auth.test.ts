import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";

// Deterministic fake LLM (unused by the auth gate, required by the ctor).
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

const TOKEN = "s3cr3t-token";

async function listen(server: ReturnType<typeof createApiServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("Bearer token auth gate (COD-16) — token configured", () => {
  let server: ReturnType<typeof createApiServer>;
  let base: string;

  beforeAll(async () => {
    server = createApiServer(makeApi(), { authToken: TOKEN });
    base = await listen(server);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("AC-1: a protected route without an Authorization header → 401 unauthorized", async () => {
    const res = await fetch(`${base}/coach`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "unauthorized" });
  });

  it("AC-2: the correct Bearer token → the request proceeds (200)", async () => {
    const res = await fetch(`${base}/coach`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    // Same shape as without auth: the default coach profile.
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("AC-4: GET /health is exempt — 200 without any header", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("AC-5: a wrong token → 401", async () => {
    const res = await fetch(`${base}/coach`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("AC-5: a non-Bearer scheme → 401", async () => {
    const res = await fetch(`${base}/coach`, {
      headers: { Authorization: TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it("AC-5: a token of different length does not throw → 401 (not 500)", async () => {
    const res = await fetch(`${base}/coach`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  it("a protected POST route without a header → 401 (gate runs before dispatch)", async () => {
    const res = await fetch(`${base}/chat/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "voglio leggere" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Bearer token auth gate (COD-16) — no token configured (open, AC-3)", () => {
  let server: ReturnType<typeof createApiServer>;
  let base: string;

  beforeAll(async () => {
    // No options → open, exactly how every existing test constructs the server.
    server = createApiServer(makeApi());
    base = await listen(server);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("AC-3: a protected route responds normally without any header (200)", async () => {
    const res = await fetch(`${base}/coach`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("AC-3: an empty-string token is treated as unset (open)", async () => {
    const s2 = createApiServer(makeApi(), { authToken: "   " });
    const b2 = await listen(s2);
    try {
      const res = await fetch(`${b2}/coach`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});
