import { describe, it, expect } from "vitest";
import {
  InterventionLevel,
  type Rule,
  type Commitment,
  type Habit,
  type CoachProfile,
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
 * COD-8 — quiet hours resolved from the coach profile suppress NEW proactive
 * (escalation) messages in /usage. The engine already holds escalation when
 * `TickSignal.quietHours` is true (§14.5); this proves `ingestUsage` computes
 * that flag from `coach.quietHours` in the user's timezone.
 *
 * The window position / quiet band is driven by a fixed in-band `atIso`
 * (21:03 Europe/Rome), while a mutable clock advances past the cooldown so the
 * second tick reaches the escalation decision — the only place the flag bites.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

// 19:03Z = 21:03 Europe/Rome (CEST) — inside the 21:00–21:30 window.
const AT = "2026-07-14T19:03:00Z";

function setup() {
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
    escalation: [
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Restriction,
    ],
    exceptions: [],
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 8,
    enabled: true,
  };
  store.habits.set(habit.id, habit);
  store.commitments.set(commitment.id, commitment);
  store.rules.set(rule.id, rule);

  // Mutable clock so the second tick's cooldown elapses (the escalation gate).
  let nowMs = Date.parse(AT);
  const clock: Clock = { nowIso: () => new Date(nowMs).toISOString() };
  const advance = (seconds: number) => (nowMs += seconds * 1000);

  let n = 0;
  const ids: IdGen = { next: (p) => `${p}_${++n}` };
  const push = new PushDeliverer();
  const intervention = new InterventionService(new InMemorySessionRepo(), clock, push, ids);
  const api = new Api(store, new AiOrchestrationService(new FakeExtractor()), intervention, clock);

  return { api, push, advance };
}

const coachWith = (quietHours: CoachProfile["quietHours"]): CoachProfile => ({
  tone: "direct",
  intensity: "firm",
  maxMessageLength: 200,
  humor: false,
  bannedWords: [],
  quietHours,
});

const tick = (api: Api, foregroundSeconds: number) =>
  api.ingestUsage({ ruleId: "r1", appId: "instagram", foregroundSeconds, atIso: AT });

describe("POST /usage — quiet hours suppress escalation (COD-8)", () => {
  it("inside a quiet-hours band → escalation is held, no new push (AC-1, AC-2, AC-4)", async () => {
    const { api, push, advance } = setup();
    await api.setCoach(coachWith([{ startHour: 21, endHour: 22 }])); // covers 21:03 Rome

    const first = await tick(api, 65); // first contact ignores quiet hours
    advance(31); // clear the 30s cooldown
    const second = await tick(api, 130); // would escalate, but quiet hours hold it

    expect(first.data!.delivered).toBe(true);
    expect(second.data!.delivered).toBe(false);
    expect(second.data!.reason).toBe("quiet_hours");
    expect(push.all()).toHaveLength(1);
  });

  it("outside every quiet-hours band → escalation is delivered (AC-4)", async () => {
    const { api, push, advance } = setup();
    await api.setCoach(coachWith([{ startHour: 3, endHour: 4 }])); // does NOT cover 21:03

    const first = await tick(api, 65);
    advance(31);
    const second = await tick(api, 130);

    expect(first.data!.delivered).toBe(true);
    expect(second.data!.delivered).toBe(true);
    expect(second.data!.reason).toBe("escalation_after_ignore");
    expect(push.all()).toHaveLength(2);
  });

  it("default coach (no bands) → quietHours false, behavior unchanged (AC-3)", async () => {
    const { api, push, advance } = setup(); // no setCoach → DEFAULT_COACH, quietHours: []

    const first = await tick(api, 65);
    advance(31);
    const second = await tick(api, 130);

    expect(first.data!.delivered).toBe(true);
    expect(second.data!.delivered).toBe(true);
    expect(push.all()).toHaveLength(2);
  });

  it("quiet band wrapping midnight (22→7) is respected (AC-1)", async () => {
    const { api, push, advance } = setup();
    await api.setCoach(coachWith([{ startHour: 22, endHour: 7 }])); // 21:03 is OUTSIDE 22→7

    const first = await tick(api, 65);
    advance(31);
    const second = await tick(api, 130);

    // 21:03 falls before the 22:00 wrap start, so escalation is NOT suppressed.
    expect(second.data!.delivered).toBe(true);
    expect(push.all()).toHaveLength(2);
  });
});
