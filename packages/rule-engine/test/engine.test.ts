import { describe, it, expect } from "vitest";
import {
  InterventionLevel,
  type Rule,
  type InterventionSession,
} from "@pa/shared-types";
import { decide, nextLevel, type DecisionContext } from "../src/engine.js";
import { isWithinWindow, isActiveDay, cooldownElapsed } from "../src/time.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const rule: Rule = {
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

const baseSession: InterventionSession = {
  id: "s1",
  ruleId: "r1",
  date: "2026-07-14",
  state: "scheduled",
  level: InterventionLevel.ObserveOnly,
  interventionsSent: 0,
};

const baseCtx: DecisionContext = {
  nowIso: "2026-07-14T21:03:00Z",
  inWindow: true,
  activeDay: true,
  distractionDetected: false,
  habitCompleted: false,
  interventionsToday: 0,
  exceptionActive: false,
  coachPaused: false,
  quietHours: false,
  emergencyRequested: false,
};

// ── Time helpers ─────────────────────────────────────────────────────────────

describe("isWithinWindow", () => {
  it("normal same-day window", () => {
    expect(isWithinWindow(1275, 1260, 1290)).toBe(true); // 21:15 in 21:00-21:30
    expect(isWithinWindow(1295, 1260, 1290)).toBe(false);
    expect(isWithinWindow(1260, 1260, 1290)).toBe(true); // inclusive start
    expect(isWithinWindow(1290, 1260, 1290)).toBe(false); // exclusive end
  });

  it("window wrapping past midnight (§39.1 'orario attraversa mezzanotte')", () => {
    // 23:30 (1410) .. 00:30 (30)
    expect(isWithinWindow(1425, 1410, 30)).toBe(true); // 23:45
    expect(isWithinWindow(15, 1410, 30)).toBe(true); // 00:15
    expect(isWithinWindow(60, 1410, 30)).toBe(false); // 01:00
  });

  it("empty window never matches", () => {
    expect(isWithinWindow(1260, 1260, 1260)).toBe(false);
  });
});

describe("isActiveDay", () => {
  it("weekday matching", () => {
    expect(isActiveDay(1, [1, 2, 3, 4, 5])).toBe(true); // Mon
    expect(isActiveDay(0, [1, 2, 3, 4, 5])).toBe(false); // Sun
  });
});

describe("cooldownElapsed", () => {
  it("first intervention always allowed", () => {
    expect(cooldownElapsed(undefined, 60, baseCtx.nowIso)).toBe(true);
  });
  it("blocks inside cooldown, allows after", () => {
    expect(cooldownElapsed("2026-07-14T21:02:30Z", 60, "2026-07-14T21:03:00Z")).toBe(false); // 30s < 60s
    expect(cooldownElapsed("2026-07-14T21:02:00Z", 60, "2026-07-14T21:03:00Z")).toBe(true); // 60s == 60s
  });
});

// ── nextLevel ────────────────────────────────────────────────────────────────

describe("nextLevel", () => {
  it("climbs the ladder and clamps at the top", () => {
    expect(nextLevel(rule, InterventionLevel.ContextualNudge)).toBe(InterventionLevel.DirectIntervention);
    expect(nextLevel(rule, InterventionLevel.DirectIntervention)).toBe(InterventionLevel.Restriction);
    expect(nextLevel(rule, InterventionLevel.Restriction)).toBe(InterventionLevel.Restriction); // clamp
  });
});

// ── decide(): hard stops (§29) ───────────────────────────────────────────────

describe("decide — hard stops", () => {
  it("disabled rule → none", () => {
    expect(decide({ ...rule, enabled: false }, baseSession, baseCtx).kind).toBe("none");
  });

  it("emergency request short-circuits everything (§7.6)", () => {
    const d = decide(rule, baseSession, { ...baseCtx, emergencyRequested: true, distractionDetected: true });
    expect(d.kind).toBe("emergency");
    expect(d.nextState).toBe("emergency");
  });

  it("coach paused → none (§14.5 'Basta per oggi')", () => {
    expect(decide(rule, { ...baseSession, state: "window_open" }, { ...baseCtx, coachPaused: true, distractionDetected: true }).reason).toBe("coach_paused");
  });

  it("exception active → none (§8.5)", () => {
    expect(decide(rule, { ...baseSession, state: "window_open" }, { ...baseCtx, exceptionActive: true, distractionDetected: true }).reason).toBe("exception_active");
  });

  it("habit completed → complete", () => {
    expect(decide(rule, { ...baseSession, state: "window_open" }, { ...baseCtx, habitCompleted: true }).kind).toBe("complete");
  });

  it("not an active day → none", () => {
    expect(decide(rule, baseSession, { ...baseCtx, inWindow: false, activeDay: false }).reason).toBe("not_active_day");
  });

  it("daily budget exhausted → none (§14.5)", () => {
    expect(decide(rule, { ...baseSession, state: "window_open" }, { ...baseCtx, interventionsToday: 8, distractionDetected: true }).reason).toBe("daily_budget_exhausted");
  });
});

// ── decide(): happy-path lifecycle (§15 example) ─────────────────────────────

describe("decide — full escalation lifecycle", () => {
  it("scheduled + before window → prewarn", () => {
    const d = decide(rule, baseSession, { ...baseCtx, inWindow: false });
    expect(d.kind).toBe("prewarn");
    expect(d.nextState).toBe("prewarned");
  });

  it("window opens → observe (no intervention yet)", () => {
    const d = decide(rule, { ...baseSession, state: "prewarned" }, baseCtx);
    expect(d.kind).toBe("none");
    expect(d.nextState).toBe("window_open");
  });

  it("first distraction → intervene at ladder[0]", () => {
    const d = decide(rule, { ...baseSession, state: "window_open" }, { ...baseCtx, distractionDetected: true });
    expect(d.kind).toBe("intervene");
    expect(d.level).toBe(InterventionLevel.ContextualNudge);
    expect(d.nextState).toBe("intervened");
  });

  it("ignored + cooldown elapsed → escalate one rung", () => {
    const session: InterventionSession = {
      ...baseSession,
      state: "intervened",
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 1,
      lastInterventionAt: "2026-07-14T21:02:00Z", // 60s before now
    };
    const d = decide(rule, session, { ...baseCtx, distractionDetected: true });
    expect(d.kind).toBe("escalate");
    expect(d.level).toBe(InterventionLevel.DirectIntervention);
  });

  it("ignored but still in cooldown → none (§14.5 anti-spam)", () => {
    const session: InterventionSession = {
      ...baseSession,
      state: "intervened",
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 1,
      lastInterventionAt: "2026-07-14T21:02:45Z", // 15s before now < 60s
    };
    expect(decide(rule, session, { ...baseCtx, distractionDetected: true }).reason).toBe("cooldown_active");
  });

  it("session cap reached → none (§8.9 dedup, not infinite notifications)", () => {
    const session: InterventionSession = {
      ...baseSession,
      state: "escalated",
      level: InterventionLevel.DirectIntervention,
      interventionsSent: 3, // == maxInterventionsPerSession
      lastInterventionAt: "2026-07-14T21:00:00Z",
    };
    expect(decide(rule, session, { ...baseCtx, distractionDetected: true }).reason).toBe("session_cap_reached");
  });

  it("quiet hours hold escalation messaging (§14.5)", () => {
    const session: InterventionSession = {
      ...baseSession,
      state: "intervened",
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 1,
      lastInterventionAt: "2026-07-14T21:02:00Z",
    };
    expect(decide(rule, session, { ...baseCtx, distractionDetected: true, quietHours: true }).reason).toBe("quiet_hours");
  });

  it("window ends mid-session → terminate", () => {
    const d = decide(rule, { ...baseSession, state: "escalated" }, { ...baseCtx, inWindow: false });
    expect(d.kind).toBe("terminate");
    expect(d.nextState).toBe("terminated");
  });
});

// ── §42.20 — every decision must explain itself ──────────────────────────────

describe("decide — explainability (§42.20)", () => {
  it("every decision carries a non-empty machine reason", () => {
    const scenarios: DecisionContext[] = [
      baseCtx,
      { ...baseCtx, inWindow: false },
      { ...baseCtx, distractionDetected: true },
      { ...baseCtx, coachPaused: true },
    ];
    for (const ctx of scenarios) {
      const d = decide(rule, { ...baseSession, state: "window_open" }, ctx);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});
