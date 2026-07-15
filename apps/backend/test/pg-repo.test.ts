import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InterventionLevel, type Rule } from "@pa/shared-types";
import { InterventionService, type Clock, type Deliverer, type IdGen, type TickSignal } from "@pa/intervention-service";
import { createTestDb, type Db } from "../src/db/db.js";
import { PgSessionRepo } from "../src/db/pg-session-repo.js";
import type { CoachProfile } from "@pa/shared-types";

let db: Db & { close: () => Promise<void> };

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

// A rule row must exist for FK constraints (interventions → sessions → rules).
async function seedRule(rule: Rule) {
  await db.query(
    `INSERT INTO users (id, email) VALUES ($1,$2)`,
    ["11111111-1111-1111-1111-111111111111", "rico@example.com"],
  );
  await db.query(
    `INSERT INTO habits (id, user_id, title, type) VALUES ($1,$2,$3,$4)`,
    ["22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111", "Lettura", "substitute"],
  );
  await db.query(
    `INSERT INTO commitments (id, habit_id, natural_text, days, start_minute, end_minute, duration_minutes, confirmed_by_user)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    ["33333333-3333-3333-3333-333333333333", "22222222-2222-2222-2222-222222222222", "leggere", [1,2,3,4,5], 1260, 1290, 30],
  );
  await db.query(
    `INSERT INTO rules (id, habit_id, commitment_id, escalation) VALUES ($1,$2,$3,$4)`,
    [rule.id, "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", rule.escalation],
  );
}

const rule: Rule = {
  id: "44444444-4444-4444-4444-444444444444",
  habitId: "22222222-2222-2222-2222-222222222222",
  commitmentId: "33333333-3333-3333-3333-333333333333",
  intensity: "firm",
  interferingApps: ["instagram"],
  thresholdMinutes: 2,
  cooldownSeconds: 60,
  escalation: [InterventionLevel.ContextualNudge, InterventionLevel.DirectIntervention, InterventionLevel.Restriction],
  exceptions: [],
  maxInterventionsPerSession: 3,
  maxInterventionsPerDay: 10,
  enabled: true,
};

describe("PgSessionRepo — real Postgres SQL via PGlite", () => {
  it("save + find round-trips a session", async () => {
    await seedRule(rule);
    const repo = new PgSessionRepo(db);
    await repo.save({
      id: "55555555-5555-5555-5555-555555555555",
      ruleId: rule.id,
      date: "2026-07-14",
      state: "window_open",
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 0,
    });
    const found = await repo.find(rule.id, "2026-07-14");
    expect(found).not.toBeNull();
    expect(found!.state).toBe("window_open");
    expect(found!.level).toBe(InterventionLevel.ContextualNudge);
  });

  it("save is idempotent upsert on (rule_id, date)", async () => {
    await seedRule(rule);
    const repo = new PgSessionRepo(db);
    const base = {
      id: "55555555-5555-5555-5555-555555555555",
      ruleId: rule.id,
      date: "2026-07-14",
      state: "window_open" as const,
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 0,
    };
    await repo.save(base);
    await repo.save({ ...base, state: "escalated", interventionsSent: 2 });
    const found = await repo.find(rule.id, "2026-07-14");
    expect(found!.state).toBe("escalated");
    expect(found!.interventionsSent).toBe(2);
  });

  it("counts interventions for the day", async () => {
    await seedRule(rule);
    const repo = new PgSessionRepo(db);
    await repo.save({
      id: "55555555-5555-5555-5555-555555555555",
      ruleId: rule.id,
      date: "2026-07-14",
      state: "intervened",
      level: InterventionLevel.ContextualNudge,
      interventionsSent: 1,
    });
    await repo.appendIntervention({
      id: "66666666-6666-6666-6666-666666666666",
      sessionId: "55555555-5555-5555-5555-555555555555",
      action: "nudge",
      channel: "push",
      message: "test",
      sentAt: "2026-07-14T21:03:00Z",
      level: InterventionLevel.ContextualNudge,
    });
    expect(await repo.countInterventionsToday(rule.id, "2026-07-14")).toBe(1);
  });
});

// The InterventionService (from the packages layer) must work UNCHANGED against
// the real pg repo — proving the port abstraction holds across in-memory and SQL.
describe("InterventionService + PgSessionRepo (real persistence)", () => {
  class FixedClock implements Clock {
    constructor(public t: string) {}
    nowIso() { return this.t; }
  }
  class FakeDeliverer implements Deliverer {
    sent: string[] = [];
    async deliver(i: { channel: any; text: string; sessionId: string }) {
      this.sent.push(i.text);
      return { deliveryId: `d${this.sent.length}` };
    }
  }
  let n = 0;
  const ids: IdGen = {
    next: () => {
      // Real UUIDs — the Postgres schema uses UUID columns (integration-accurate).
      n++;
      const hex = n.toString(16).padStart(12, "0");
      return `77777777-7777-7777-7777-${hex}`;
    },
  };

  const coach: CoachProfile = {
    tone: "direct", intensity: "firm", maxMessageLength: 300, humor: false, bannedWords: [], quietHours: [],
  };

  function sig(over: Partial<TickSignal> = {}): TickSignal {
    return {
      rule, coach, minuteOfDay: 1263, dayOfWeek: 1, date: "2026-07-14",
      inWindow: true, distractionDetected: false, habitCompleted: false,
      exceptionActive: false, coachPaused: false, quietHours: false, emergencyRequested: false,
      goal: "leggere", detectedApp: "Instagram", windowLabel: "21:00-21:30", minutesElapsed: 3,
      channel: "push", ...over,
    };
  }

  it("delivers an intervention and persists it in Postgres", async () => {
    await seedRule(rule);
    const repo = new PgSessionRepo(db);
    const clock = new FixedClock("2026-07-14T21:00:00Z");
    const deliverer = new FakeDeliverer();
    const svc = new InterventionService(repo, clock, deliverer, ids);

    await svc.handleTick(sig()); // window opens
    clock.t = "2026-07-14T21:03:00Z";
    const r = await svc.handleTick(sig({ distractionDetected: true }));

    expect(r.decisionKind).toBe("intervene");
    expect(deliverer.sent.length).toBe(1);
    // Verify persistence: the intervention is really in the DB.
    expect(await repo.countInterventionsToday(rule.id, "2026-07-14")).toBe(1);
  });
});
