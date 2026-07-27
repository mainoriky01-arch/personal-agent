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
 * COD-11 — barrage through /usage: repeated in-window ticks on the same
 * distraction deliver repeated pushes at cooldown cadence, up to the session cap,
 * then stop. A mutable clock advances past the cooldown between ticks.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

const AT = "2026-07-14T19:03:00Z"; // 21:03 Europe/Rome — inside 21:00–21:30

function setup(barrage: boolean) {
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
    barrage,
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

const tick = (api: Api) =>
  api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds: 65, atIso: AT });

describe("POST /usage — barrage delivers repeated pushes up to the cap (COD-11)", () => {
  it("N ticks → N pushes up to maxInterventionsPerSession, then stop (AC-2, AC-3, AC-4)", async () => {
    const { api, push, advance } = setup(true);
    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await tick(api);
      reasons.push(r.data!.reason);
      advance(31); // clear the 30s cooldown before the next tick
    }
    // Exactly 3 delivered (the session cap), never more.
    expect(push.all()).toHaveLength(3);
    // Repeats came from the barrage path, not escalation.
    expect(reasons[1]).toBe("barrage_repeat");
    expect(reasons[2]).toBe("barrage_repeat");
    // Once the cap is hit the barrage stops.
    expect(reasons[3]).toBe("session_cap_reached");
    expect(reasons[4]).toBe("session_cap_reached");
  });

  it("without barrage the same run escalates instead of repeating (AC-1)", async () => {
    const { api, push, advance } = setup(false);
    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await tick(api);
      reasons.push(r.data!.reason);
      advance(31);
    }
    expect(push.all()).toHaveLength(3); // same cap
    expect(reasons[1]).toBe("escalation_after_ignore");
    expect(reasons[3]).toBe("session_cap_reached");
  });
});
