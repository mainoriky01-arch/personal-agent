import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";

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

describe("Seatbelt state mirror (§1.7 device loop) — Api methods", () => {
  let api: Api;
  beforeEach(() => {
    api = makeApi();
  });

  it("is inactive for a user that never triggered", () => {
    expect(api.seatbeltStatus("riccardo")).toEqual({ userId: "riccardo", active: false });
  });

  it("trigger marks the user active with target app and a since timestamp", () => {
    const res = api.triggerSeatbelt({ userId: "riccardo", targetApp: "Instagram" });
    expect(res.ok).toBe(true);
    expect(res.data!.active).toBe(true);
    expect(res.data!.targetApp).toBe("Instagram");
    expect(typeof res.data!.since).toBe("string");
    expect(api.seatbeltStatus("riccardo").active).toBe(true);
  });

  it("resolved clears the user back to inactive", () => {
    api.triggerSeatbelt({ userId: "riccardo", targetApp: "Instagram" });
    const res = api.resolveSeatbelt({ userId: "riccardo" });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ userId: "riccardo", active: false });
    expect(api.seatbeltStatus("riccardo").active).toBe(false);
  });

  it("resolved is idempotent for a user with no active barrage", () => {
    const res = api.resolveSeatbelt({ userId: "riccardo" });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data!.active).toBe(false);
  });

  it("re-trigger overwrites the target app (latest wins)", () => {
    api.triggerSeatbelt({ userId: "riccardo", targetApp: "Instagram" });
    api.triggerSeatbelt({ userId: "riccardo", targetApp: "TikTok" });
    expect(api.seatbeltStatus("riccardo").targetApp).toBe("TikTok");
  });

  it("state is per-user isolated", () => {
    api.triggerSeatbelt({ userId: "riccardo", targetApp: "Instagram" });
    expect(api.seatbeltStatus("altro").active).toBe(false);
    expect(api.seatbeltStatus("riccardo").active).toBe(true);
  });

  it("trigger rejects a missing userId", () => {
    const res = api.triggerSeatbelt({ targetApp: "Instagram" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toBe("userId_required");
  });

  it("trigger rejects a missing targetApp", () => {
    const res = api.triggerSeatbelt({ userId: "riccardo" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toBe("targetApp_required");
  });

  it("resolved rejects a missing userId", () => {
    const res = api.resolveSeatbelt({});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toBe("userId_required");
  });
});

describe("Seatbelt HTTP routes (real requests, §1.7)", () => {
  let server: ReturnType<typeof createApiServer>;
  let base: string;

  beforeAll(async () => {
    server = createApiServer(makeApi());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("POST /seatbelt/trigger → 200 active:true", async () => {
    const res = await post("/seatbelt/trigger", { userId: "riccardo", targetApp: "Instagram" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.active).toBe(true);
    expect(body.data.targetApp).toBe("Instagram");
  });

  it("POST /seatbelt/resolved → 200 active:false", async () => {
    const res = await post("/seatbelt/resolved", { userId: "riccardo" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.active).toBe(false);
  });

  it("POST /seatbelt/trigger without targetApp → 400", async () => {
    const res = await post("/seatbelt/trigger", { userId: "riccardo" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("targetApp_required");
  });
});
