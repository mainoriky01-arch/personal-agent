import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import {
  InterventionLevel,
  type Rule,
  type Commitment,
  type Habit,
} from "@pa/shared-types";
import type { Intent } from "@pa/rule-drafting";
import {
  InterventionService,
  type Clock,
  type IdGen,
} from "@pa/intervention-service";
import { MemoryStore, InMemorySessionRepo } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { PushDeliverer } from "../src/push-deliverer.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";

/**
 * COD-12 — POST /usage/ack suspends the barrage for the current foreground stay
 * and auto-resumes on return (the reported streak dropping = a reopen).
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

const AT = "2026-07-14T19:03:00Z"; // 21:03 Europe/Rome — inside 21:00–21:30

function setup() {
  const store = new MemoryStore();
  const commitment: Commitment = {
    id: "c1",
    naturalText: "Sera",
    days: [0, 1, 2, 3, 4, 5, 6],
    startMinuteOfDay: 1260,
    endMinuteOfDay: 1290,
    durationMinutes: 30,
    version: 1,
    confirmedByUser: true,
  };
  const habit: Habit = { id: "h1", title: "Meno Instagram", type: "reduce", status: "active" };
  const rule: Rule = {
    id: "r1",
    habitId: "h1",
    commitmentId: "c1",
    intensity: "firm",
    interferingApps: ["instagram"],
    thresholdMinutes: 1,
    cooldownSeconds: 30,
    escalation: [InterventionLevel.ContextualNudge],
    exceptions: [],
    maxInterventionsPerSession: 5,
    maxInterventionsPerDay: 20,
    barrage: true,
    enabled: true,
  };
  store.habits.set(habit.id, habit);
  store.commitments.set(commitment.id, commitment);
  store.rules.set(rule.id, rule);

  let nowMs = Date.parse(AT);
  const clock: Clock = { nowIso: () => new Date(nowMs).toISOString() };
  const advance = (s: number) => (nowMs += s * 1000);
  let n = 0;
  const ids: IdGen = { next: (p) => `${p}_${++n}` };
  const push = new PushDeliverer();
  const intervention = new InterventionService(new InMemorySessionRepo(), clock, push, ids);
  const api = new Api(store, new AiOrchestrationService(new FakeExtractor()), intervention, clock);
  return { api, push, advance };
}

const tick = (api: Api, foregroundSeconds: number) =>
  api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds, atIso: AT });

describe("POST /usage/ack — suspend barrage and resume on return (COD-12)", () => {
  it("ack suppresses the current stay; a return re-arms the barrage (AC-1, AC-2, AC-4)", async () => {
    const { api, push, advance } = setup();

    const first = await tick(api, 65); // barrage first contact → push #1
    expect(first.data!.delivered).toBe(true);
    expect(push.all()).toHaveLength(1);

    const ack = await api.ackUsage({ ruleId: "r1" });
    expect(ack.status).toBe(200);
    expect(ack.data!.acknowledged).toBe(true);

    advance(31);
    const stillIn = await tick(api, 130); // same stay, streak grew → suppressed
    expect(stillIn.data!.delivered).toBe(false);
    expect(stillIn.data!.reason).toBe("acknowledged");
    expect(push.all()).toHaveLength(1);

    advance(31);
    const returned = await tick(api, 65); // streak dropped = reopened → barrage resumes
    expect(returned.data!.delivered).toBe(true);
    expect(returned.data!.reason).toBe("barrage_repeat");
    expect(push.all()).toHaveLength(2);
  });

  it("rejects an unknown rule (404) and a missing ruleId (400) (AC-1)", async () => {
    const { api } = setup();
    expect((await api.ackUsage({ ruleId: "nope" })).status).toBe(404);
    expect((await api.ackUsage({})).status).toBe(400);
  });

  it("503 when the intervention service is not wired", async () => {
    const store = new MemoryStore();
    const api = new Api(store, new AiOrchestrationService(new FakeExtractor()));
    expect((await api.ackUsage({ ruleId: "r1" })).status).toBe(503);
  });

  it("HTTP POST /usage/ack round-trips through the server (AC-1)", async () => {
    const { api } = setup();
    const server = createApiServer(api);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/usage/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ruleId: "r1" }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.acknowledged).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
