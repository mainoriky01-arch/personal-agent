import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";

class FakeExtractor implements IntentExtractor {
  constructor(private intent: Intent) {}
  async extract() { return this.intent; }
}

const completeIntent: Intent = {
  goal: "leggere",
  substituteBehavior: "lettura",
  days: [1, 2, 3, 4, 5],
  startMinuteOfDay: 1260,
  durationMinutes: 30,
  interferingApps: ["instagram"],
  intensity: "firm",
};

let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(async () => {
  const store = new MemoryStore();
  const ai = new AiOrchestrationService(new FakeExtractor(completeIntent));
  server = createApiServer(new Api(store, ai));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTTP API server (real requests, §25)", () => {
  it("GET /health → ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("POST /chat/draft → complete draft", async () => {
    const res = await fetch(`${base}/chat/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "voglio leggere alle 21, sii severo" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.status).toBe("complete");
  });

  it("POST /chat/draft with empty text → 400", async () => {
    const res = await fetch(`${base}/chat/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("full flow: create habit → confirm rule → active rule", async () => {
    const h = await (await fetch(`${base}/habits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Lettura serale", type: "substitute" }),
    })).json();
    expect(h.data.id).toBeTruthy();

    const draft = await (await fetch(`${base}/chat/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "leggere alle 21" }),
    })).json();

    const rule = await (await fetch(`${base}/rules/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ habitId: h.data.id, proposal: draft.data.proposal }),
    })).json();

    expect(rule.status).toBe(201);
    expect(rule.data.enabled).toBe(true);
  });

  it("memory: POST then GET then DELETE", async () => {
    const add = await (await fetch(`${base}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Voglio leggere di più",
        category: "goal",
        source: "user_stated",
        confidence: 1,
        proactiveUseAllowed: true,
      }),
    })).json();
    expect(add.status).toBe(201);

    const list = await (await fetch(`${base}/memory?userId=u1`)).json();
    expect(list.data.length).toBe(1);

    const del = await fetch(`${base}/memory/${add.data.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
