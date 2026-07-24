import { describe, it, expect } from "vitest";
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
import type { AddressInfo } from "node:net";
import { MemoryStore, InMemorySessionRepo } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { PushDeliverer } from "../src/push-deliverer.js";
import { Api } from "../src/api.js";
import { createApiServer } from "../src/server.js";

/**
 * POST /usage — the phone → engine → push-alarm path (COD-1, §23.4/§23.5).
 *
 * A fixed clock and the stub PushDeliverer make the whole flow deterministic and
 * assertable with no device/APNs infrastructure.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

// Report time: Tue 2026-07-14 21:03 UTC — inside a 21:00–21:30 window.
const NOW = "2026-07-14T21:03:00Z";

function setup(opts: { enabled?: boolean } = {}) {
  const store = new MemoryStore();

  const commitment: Commitment = {
    id: "c1",
    naturalText: "Ogni sera alle 21:00 leggo 30 min",
    days: [0, 1, 2, 3, 4, 5, 6],
    startMinuteOfDay: 1260, // 21:00
    endMinuteOfDay: 1290, // 21:30
    durationMinutes: 30,
    version: 1,
    confirmedByUser: true,
  };
  const habit: Habit = {
    id: "h1",
    title: "Lettura serale",
    type: "reduce",
    status: "active",
    motivation: "voglio leggere di più",
  };
  const rule: Rule = {
    id: "r1",
    habitId: "h1",
    commitmentId: "c1",
    intensity: "firm",
    interferingApps: ["instagram"],
    thresholdMinutes: 1, // 60s streak
    cooldownSeconds: 30,
    escalation: [
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Restriction,
    ],
    exceptions: [],
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 8,
    enabled: opts.enabled ?? true,
  };
  store.habits.set(habit.id, habit);
  store.commitments.set(commitment.id, commitment);
  store.rules.set(rule.id, rule);

  const clock: Clock = { nowIso: () => NOW };
  let n = 0;
  const ids: IdGen = { next: (p) => `${p}_${++n}` };
  const push = new PushDeliverer();
  const intervention = new InterventionService(new InMemorySessionRepo(), clock, push, ids);
  const api = new Api(store, new AiOrchestrationService(new FakeExtractor()), intervention, clock);

  return { api, push, store };
}

describe("POST /usage — ingestion → engine → push alarm (COD-1)", () => {
  it("above threshold, in window, target app → delivers a push alarm (AC-4)", async () => {
    const { api, push } = setup();
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(true);
    expect(r.data!.decisionKind).toBe("intervene");
    expect(r.data!.intervention!.channel).toBe("push");
    expect(push.all()).toHaveLength(1);
    expect(push.all()[0].channel).toBe("push");
  });

  it("below threshold → no alarm (AC-5)", async () => {
    const { api, push } = setup();
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 30 });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(false);
    expect(push.all()).toHaveLength(0);
  });

  it("outside the window → no alarm (AC-5)", async () => {
    const { api, push } = setup();
    // Same day, 10:00 UTC — well outside 21:00–21:30.
    const r = await api.ingestUsage({
      ruleId: "r1",
      appId: "instagram",
      foregroundSeconds: 65,
      atIso: "2026-07-14T10:00:00Z",
    });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(false);
    expect(r.data!.reason).toBe("out_of_window");
    expect(push.all()).toHaveLength(0);
  });

  it("non-target app over threshold → no alarm (AC-5)", async () => {
    const { api, push } = setup();
    const r = await api.ingestUsage({ ruleId: "r1", appId: "spotify", foregroundSeconds: 65 });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(false);
    expect(push.all()).toHaveLength(0);
  });

  it("disabled rule → no-op 200 (AC-5)", async () => {
    const { api, push } = setup({ enabled: false });
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(false);
    expect(r.data!.reason).toBe("rule_disabled");
    expect(push.all()).toHaveLength(0);
  });

  it("two ticks within cooldown → only one push (AC-6)", async () => {
    const { api, push } = setup();
    const first = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 });
    const second = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 70 });
    expect(first.data!.delivered).toBe(true);
    expect(second.data!.delivered).toBe(false);
    expect(second.data!.reason).toBe("cooldown_active");
    expect(push.all()).toHaveLength(1);
  });

  it("streak is per-report, never accumulated server-side (AC-3)", async () => {
    const { api, push } = setup();
    // A 65s streak fires; then the app is reopened and reports 5s again. 5s is
    // below the 60s threshold, so no new alarm — proving the backend compares the
    // reported streak and does NOT sum 65 + 5.
    const first = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 });
    const reopened = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 5 });
    expect(first.data!.delivered).toBe(true);
    expect(reopened.data!.delivered).toBe(false);
    expect(push.all()).toHaveLength(1);
  });

  it("unknown ruleId → 404 (AC-1)", async () => {
    const { api } = setup();
    const r = await api.ingestUsage({ ruleId: "nope", appId: "instagram", foregroundSeconds: 65 });
    expect(r.status).toBe(404);
    expect(r.error).toBe("rule_not_found");
  });

  it("invalid body → 400 (AC-1)", async () => {
    const { api } = setup();
    expect((await api.ingestUsage({ appId: "instagram", foregroundSeconds: 65 })).status).toBe(400);
    expect((await api.ingestUsage({ ruleId: "r1", foregroundSeconds: 65 })).status).toBe(400);
    expect(
      (await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: -1 })).status,
    ).toBe(400);
    expect(
      (await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: "x" })).status,
    ).toBe(400);
  });

  it("usage endpoint is unavailable when the intervention service is not wired", async () => {
    const store = new MemoryStore();
    const api = new Api(store, new AiOrchestrationService(new FakeExtractor()));
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 });
    expect(r.status).toBe(503);
  });

  it("HTTP POST /usage round-trips through the server (AC-1, AC-4)", async () => {
    const { api } = setup();
    const server = createApiServer(api);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/usage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65 }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.delivered).toBe(true);
      expect(body.data.intervention.channel).toBe("push");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
