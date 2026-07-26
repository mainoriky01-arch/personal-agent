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
import { MemoryStore, InMemorySessionRepo } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { PushDeliverer } from "../src/push-deliverer.js";
import { Api } from "../src/api.js";

/**
 * COD-7 — the /usage window is resolved in the user's timezone, not UTC.
 *
 * The same instant lands inside a 21:00–21:30 window when read in Europe/Rome
 * (the default) but outside it when the Api is constructed for UTC, proving the
 * window position follows `users.timezone` rather than the server clock.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

// 19:15 UTC = 21:15 Europe/Rome (CEST) on a Tuesday.
const AT = "2026-07-14T19:15:00Z";

function setup(timezone?: string) {
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
  const habit: Habit = { id: "h1", title: "Lettura serale", type: "reduce", status: "active" };
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
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 8,
    enabled: true,
  };
  store.habits.set(habit.id, habit);
  store.commitments.set(commitment.id, commitment);
  store.rules.set(rule.id, rule);

  const clock: Clock = { nowIso: () => AT };
  let n = 0;
  const ids: IdGen = { next: (p) => `${p}_${++n}` };
  const push = new PushDeliverer();
  const intervention = new InterventionService(new InMemorySessionRepo(), clock, push, ids);
  // 9th arg is the timezone; omit to exercise the Europe/Rome default.
  const api = new Api(
    store,
    new AiOrchestrationService(new FakeExtractor()),
    intervention,
    clock,
    undefined,
    undefined,
    undefined,
    undefined,
    timezone,
  );
  return { api, push };
}

describe("POST /usage — window resolves in the user's timezone (COD-7)", () => {
  it("in-window in Europe/Rome (default) → delivers (AC-1, AC-3)", async () => {
    const { api, push } = setup(); // default Europe/Rome
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65, atIso: AT });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(true);
    expect(push.all()).toHaveLength(1);
  });

  it("same instant is out-of-window in UTC → no alarm (AC-1)", async () => {
    const { api, push } = setup("UTC"); // 19:15 UTC is outside 21:00–21:30
    const r = await api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65, atIso: AT });
    expect(r.status).toBe(200);
    expect(r.data!.delivered).toBe(false);
    expect(r.data!.reason).toBe("out_of_window");
    expect(push.all()).toHaveLength(0);
  });
});
