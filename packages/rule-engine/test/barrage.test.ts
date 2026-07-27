import { describe, it, expect } from "vitest";
import {
  InterventionLevel,
  type Rule,
  type InterventionSession,
} from "@pa/shared-types";
import { decide, type DecisionContext } from "../src/engine.js";

/**
 * COD-11 — barrage mode. While the same distraction persists in-window, a
 * barrage rule re-delivers at the CURRENT level every cooldown instead of
 * climbing the ladder, but the session/day caps stay the hard ceiling.
 */

const base: Rule = {
  id: "r1",
  habitId: "h1",
  commitmentId: "c1",
  intensity: "firm",
  interferingApps: ["instagram"],
  thresholdMinutes: 2,
  cooldownSeconds: 60,
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
const barrageRule: Rule = { ...base, barrage: true };

// A live session that already sent its first contact and is past cooldown.
const intervened: InterventionSession = {
  id: "s1",
  ruleId: "r1",
  date: "2026-07-14",
  state: "intervened",
  level: InterventionLevel.ContextualNudge,
  interventionsSent: 1,
  lastInterventionAt: "2026-07-14T21:03:00Z",
};

const ctx: DecisionContext = {
  nowIso: "2026-07-14T21:05:00Z", // +120s > 60s cooldown
  inWindow: true,
  activeDay: true,
  distractionDetected: true,
  habitCompleted: false,
  interventionsToday: 1,
  exceptionActive: false,
  coachPaused: false,
  quietHours: false,
  emergencyRequested: false,
};

describe("barrage mode (COD-11)", () => {
  it("re-delivers at the CURRENT level without escalating (AC-2)", () => {
    const d = decide(barrageRule, intervened, ctx);
    expect(d.kind).toBe("intervene");
    expect(d.level).toBe(InterventionLevel.ContextualNudge); // unchanged, no climb
    expect(d.reason).toBe("barrage_repeat");
  });

  it("without the flag, the same tick escalates (AC-1 — default unchanged)", () => {
    const d = decide(base, intervened, ctx);
    expect(d.kind).toBe("escalate");
    expect(d.level).toBe(InterventionLevel.DirectIntervention); // climbed one rung
    expect(d.reason).toBe("escalation_after_ignore");
  });

  it("respects the session cap even in barrage (AC-3)", () => {
    const capped = { ...intervened, interventionsSent: base.maxInterventionsPerSession };
    const d = decide(barrageRule, capped, ctx);
    expect(d.kind).toBe("none");
    expect(d.reason).toBe("session_cap_reached");
  });

  it("respects the daily cap even in barrage (AC-3)", () => {
    const d = decide(barrageRule, intervened, { ...ctx, interventionsToday: base.maxInterventionsPerDay });
    expect(d.kind).toBe("none");
    expect(d.reason).toBe("daily_budget_exhausted");
  });

  it("still honours cooldown between barrage pushes (AC-2 cadence)", () => {
    const d = decide(barrageRule, intervened, { ...ctx, nowIso: "2026-07-14T21:03:30Z" }); // +30s < 60s
    expect(d.kind).toBe("none");
    expect(d.reason).toBe("cooldown_active");
  });
});
