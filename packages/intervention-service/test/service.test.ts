import { describe, it, expect, beforeEach } from "vitest";
import {
  InterventionLevel,
  type Rule,
  type InterventionSession,
  type Intervention,
  type CoachProfile,
} from "@pa/shared-types";
import { InterventionService } from "../src/service.js";
import type { SessionRepo, Clock, Deliverer, IdGen, TickSignal } from "../src/ports.js";

// ── In-memory fakes (no DB, no network) ──────────────────────────────────────

class FakeRepo implements SessionRepo {
  sessions = new Map<string, InterventionSession>();
  interventions: Intervention[] = [];
  key(ruleId: string, date: string) {
    return `${ruleId}:${date}`;
  }
  async find(ruleId: string, date: string) {
    return this.sessions.get(this.key(ruleId, date)) ?? null;
  }
  async save(session: InterventionSession) {
    this.sessions.set(this.key(session.ruleId, session.date), session);
  }
  async countInterventionsToday(ruleId: string, date: string) {
    return this.interventions.filter((i) => {
      const s = this.sessions.get(this.key(ruleId, date));
      return s ? i.sessionId === s.id : false;
    }).length;
  }
  async appendIntervention(i: Intervention) {
    this.interventions.push(i);
  }
}

class FixedClock implements Clock {
  constructor(public t: string) {}
  nowIso() {
    return this.t;
  }
}

class FakeDeliverer implements Deliverer {
  delivered: Array<{ channel: string; text: string }> = [];
  async deliver(input: { channel: any; text: string; sessionId: string }) {
    this.delivered.push({ channel: input.channel, text: input.text });
    return { deliveryId: `del_${this.delivered.length}` };
  }
}

class SeqIds implements IdGen {
  private n = 0;
  next(prefix: string) {
    return `${prefix}_${++this.n}`;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
  maxInterventionsPerDay: 10,
  enabled: true,
};

const coach: CoachProfile = {
  tone: "direct",
  intensity: "firm",
  maxMessageLength: 300,
  humor: false,
  bannedWords: [],
  quietHours: [],
};

function baseSig(overrides: Partial<TickSignal> = {}): TickSignal {
  return {
    rule,
    coach,
    minuteOfDay: 1263,
    dayOfWeek: 1,
    date: "2026-07-14",
    inWindow: true,
    distractionDetected: false,
    habitCompleted: false,
    exceptionActive: false,
    coachPaused: false,
    quietHours: false,
    emergencyRequested: false,
    goal: "leggere",
    motivation: "non arrivare a fine anno senza aver letto nulla",
    detectedApp: "Instagram",
    windowLabel: "21:00-21:30",
    minutesElapsed: 3,
    channel: "push",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("InterventionService — end-to-end cycle (spec §43)", () => {
  let repo: FakeRepo;
  let clock: FixedClock;
  let deliverer: FakeDeliverer;
  let svc: InterventionService;

  beforeEach(() => {
    repo = new FakeRepo();
    clock = new FixedClock("2026-07-14T20:55:00Z");
    deliverer = new FakeDeliverer();
    svc = new InterventionService(repo, clock, deliverer, new SeqIds());
  });

  it("pre-warns before the window and persists the session", async () => {
    const r = await svc.handleTick(baseSig({ inWindow: false }));
    expect(r.decisionKind).toBe("prewarn");
    expect(r.session.state).toBe("prewarned");
    expect(deliverer.delivered).toHaveLength(1);
    // Session is persisted for the next tick.
    expect(await repo.find("r1", "2026-07-14")).not.toBeNull();
  });

  it("first distraction triggers a delivered, safe intervention", async () => {
    // Move into the window first.
    clock.t = "2026-07-14T21:00:00Z";
    await svc.handleTick(baseSig({ distractionDetected: false }));
    // Now a distraction is detected.
    clock.t = "2026-07-14T21:03:00Z";
    const r = await svc.handleTick(baseSig({ distractionDetected: true }));
    expect(r.decisionKind).toBe("intervene");
    expect(r.intervention).toBeDefined();
    expect(r.session.interventionsSent).toBe(1);
    expect(deliverer.delivered.at(-1)!.text.length).toBeGreaterThan(0);
  });

  it("escalates on the next tick once cooldown elapsed", async () => {
    clock.t = "2026-07-14T21:00:00Z";
    await svc.handleTick(baseSig());
    clock.t = "2026-07-14T21:03:00Z";
    await svc.handleTick(baseSig({ distractionDetected: true })); // nudge
    clock.t = "2026-07-14T21:04:30Z"; // 90s later > 60s cooldown
    const r = await svc.handleTick(baseSig({ distractionDetected: true }));
    expect(r.decisionKind).toBe("escalate");
    expect(r.session.level).toBe(InterventionLevel.DirectIntervention);
    expect(r.session.interventionsSent).toBe(2);
  });

  it("respects cooldown: no duplicate delivery inside the window", async () => {
    clock.t = "2026-07-14T21:00:00Z";
    await svc.handleTick(baseSig());
    clock.t = "2026-07-14T21:03:00Z";
    await svc.handleTick(baseSig({ distractionDetected: true })); // nudge delivered
    const before = deliverer.delivered.length;
    clock.t = "2026-07-14T21:03:20Z"; // only 20s later < 60s
    const r = await svc.handleTick(baseSig({ distractionDetected: true }));
    expect(r.decisionKind).toBe("none");
    expect(deliverer.delivered.length).toBe(before); // nothing new delivered
  });

  it("habit completion closes the session with outcome=completed", async () => {
    clock.t = "2026-07-14T21:20:00Z";
    const r = await svc.handleTick(baseSig({ habitCompleted: true }));
    expect(r.decisionKind).toBe("complete");
    expect(r.session.outcome).toBe("completed");
    expect(deliverer.delivered).toHaveLength(0); // completion delivers no nag
  });

  it("emergency request short-circuits and records the outcome", async () => {
    clock.t = "2026-07-14T21:10:00Z";
    const r = await svc.handleTick(baseSig({ emergencyRequested: true, distractionDetected: true }));
    expect(r.decisionKind).toBe("emergency");
    expect(r.session.outcome).toBe("emergency_unlock");
  });

  it("coach paused delivers nothing (§14.5)", async () => {
    clock.t = "2026-07-14T21:03:00Z";
    // open window session first
    await svc.handleTick(baseSig({ coachPaused: false, distractionDetected: false, inWindow: true }));
    const r = await svc.handleTick(baseSig({ coachPaused: true, distractionDetected: true }));
    expect(r.decisionKind).toBe("none");
    expect(r.reason).toBe("coach_paused");
  });

  it("uses AI copy when provided and safe", async () => {
    const svcAi = new InterventionService(
      repo,
      clock,
      deliverer,
      new SeqIds(),
      async () => "Hai aperto Instagram nel tuo tempo per leggere. Chiudi e inizia.",
    );
    clock.t = "2026-07-14T21:00:00Z";
    await svcAi.handleTick(baseSig());
    clock.t = "2026-07-14T21:03:00Z";
    const r = await svcAi.handleTick(baseSig({ distractionDetected: true }));
    expect(r.messageSource).toBe("ai");
  });

  it("rejects unsafe AI copy and still delivers a safe message (fail closed)", async () => {
    const svcAi = new InterventionService(
      repo,
      clock,
      deliverer,
      new SeqIds(),
      async () => "Sei un fallito e fallirai anche stasera.",
    );
    clock.t = "2026-07-14T21:00:00Z";
    await svcAi.handleTick(baseSig());
    clock.t = "2026-07-14T21:03:00Z";
    const r = await svcAi.handleTick(baseSig({ distractionDetected: true }));
    expect(r.messageSource).not.toBe("ai");
    expect(r.intervention).toBeDefined();
    // Delivered text must be safe (no degrading language).
    expect(deliverer.delivered.at(-1)!.text).not.toContain("fallito");
  });
});
