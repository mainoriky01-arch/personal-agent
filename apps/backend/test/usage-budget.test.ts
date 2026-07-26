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
 * COD-9 — cumulative daily budget. When `rule.dailyBudgetMinutes` is set, /usage
 * accumulates reported foreground per (rule, local day) and fires once the
 * running total reaches the budget, on top of the streak criterion. The counter
 * resets at local midnight (a new local date is a new counter).
 *
 * Reports here stay below the streak threshold, so any alarm is attributable to
 * the budget alone.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

// Both instants are 21:03 Europe/Rome (in the 21:00–21:30 window) on adjacent days.
const DAY1 = "2026-07-14T19:03:00Z";
const DAY2 = "2026-07-15T19:03:00Z";

function setup(dailyBudgetMinutes?: number) {
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
    thresholdMinutes: 60, // 3600s streak — the 1000s reports never trip it
    cooldownSeconds: 30,
    escalation: [InterventionLevel.ContextualNudge],
    exceptions: [],
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 8,
    dailyBudgetMinutes,
    enabled: true,
  };
  store.habits.set(habit.id, habit);
  store.commitments.set(commitment.id, commitment);
  store.rules.set(rule.id, rule);

  const clock: Clock = { nowIso: () => DAY1 };
  let n = 0;
  const ids: IdGen = { next: (p) => `${p}_${++n}` };
  const push = new PushDeliverer();
  const intervention = new InterventionService(new InMemorySessionRepo(), clock, push, ids);
  const api = new Api(store, new AiOrchestrationService(new FakeExtractor()), intervention, clock);
  return { api, push };
}

const report = (api: Api, foregroundSeconds: number, atIso: string) =>
  api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds, atIso });

describe("POST /usage — cumulative daily budget (COD-9)", () => {
  it("under budget → no alarm; reaching the budget → alarm; new day → reset (AC-2, AC-3, AC-4)", async () => {
    const { api, push } = setup(30); // 30 min/day = 1800s

    // Day 1, report 1: 1000s cumulative < 1800 → no alarm.
    const r1 = await report(api, 1000, DAY1);
    expect(r1.data!.delivered).toBe(false);

    // Day 1, report 2: 2000s cumulative ≥ 1800 → budget alarm (streak still 1000 < 3600s).
    const r2 = await report(api, 1000, DAY1);
    expect(r2.data!.delivered).toBe(true);
    expect(r2.data!.decisionKind).toBe("intervene");
    expect(push.all()).toHaveLength(1);

    // Day 2: the counter resets at local midnight → 1000s < 1800 → no alarm.
    const r3 = await report(api, 1000, DAY2);
    expect(r3.data!.delivered).toBe(false);
    expect(push.all()).toHaveLength(1);
  });

  it("no dailyBudgetMinutes → streak-only behavior, sub-threshold usage never alarms (AC-1)", async () => {
    const { api, push } = setup(undefined);
    const r1 = await report(api, 1000, DAY1);
    const r2 = await report(api, 1000, DAY1); // would exceed a 1800s budget, but none is set
    expect(r1.data!.delivered).toBe(false);
    expect(r2.data!.delivered).toBe(false);
    expect(push.all()).toHaveLength(0);
  });
});
