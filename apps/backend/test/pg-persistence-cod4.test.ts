import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InterventionLevel,
  type Habit,
  type Commitment,
  type Rule,
  type MemoryItem,
  type CoachProfile,
  type InterventionSession,
  type Intervention,
} from "@pa/shared-types";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";
import { PgMemoryRepo } from "../src/db/pg-memory-repo.js";
import { PgCoachRepo } from "../src/db/pg-coach-repo.js";
import { PgSessionRepo } from "../src/db/pg-session-repo.js";

/**
 * COD-4: memory, coach and the intervention session path persist in pg, and
 * deleteAccount wipes the account's durable data. File-backed PGlite is slow to
 * boot, so these carry a generous timeout. Ids are UUIDs (schema uses UUID PKs).
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const HABIT_ID = "11111111-1111-1111-1111-111111111111";
const COMMIT_ID = "22222222-2222-2222-2222-222222222222";
const RULE_ID = "33333333-3333-3333-3333-333333333333";
const MEM_ID = "55555555-5555-5555-5555-555555555555";
const SESSION_ID = "66666666-6666-6666-6666-666666666666";
const INTV_ID = "77777777-7777-7777-7777-777777777777";
const ABSENT_ID = "99999999-9999-9999-9999-999999999999";

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-cod4-"));
  dirs.push(d);
  return join(d, "pglite");
}

afterAll(async () => {
  await settle();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

const memItem: MemoryItem = {
  id: MEM_ID,
  content: "Voglio leggere di più",
  category: "goal",
  source: "user_stated",
  confidence: 1,
  proactiveUseAllowed: true,
  status: "active",
};

const coachProfile: CoachProfile = {
  tone: "severe",
  intensity: "extreme",
  maxMessageLength: 120,
  humor: true,
  bannedWords: ["stupido"],
  quietHours: [{ startHour: 22, endHour: 7 }],
};

describe("COD-4 — durable memory / coach / intervention path", () => {
  it(
    "memory persists, lists active only, and soft-deletes across reopen (AC-2)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      await new PgMemoryRepo(db1).add(memItem);
      await db1.close();
      await settle();

      const db2 = await createDb(path);
      const repo = new PgMemoryRepo(db2);
      expect(await repo.listActive()).toHaveLength(1); // survived reopen
      expect(await repo.softDelete(MEM_ID)).toBe(true);
      expect(await repo.listActive()).toHaveLength(0); // soft-deleted hidden
      expect(await repo.softDelete(ABSENT_ID)).toBe(false);
      await db2.close();
    },
    DB_TIMEOUT,
  );

  it(
    "coach profile persists and reloads across reopen; get is null when absent (AC-3)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      expect(await new PgCoachRepo(db1).get()).toBeNull(); // absent → null
      await new PgCoachRepo(db1).set(coachProfile);
      await db1.close();
      await settle();

      const db2 = await createDb(path);
      const got = await new PgCoachRepo(db2).get();
      await db2.close();

      expect(got?.tone).toBe("severe");
      expect(got?.maxMessageLength).toBe(120);
      expect(got?.humor).toBe(true);
      expect(got?.bannedWords).toEqual(["stupido"]);
      expect(got?.quietHours).toEqual([{ startHour: 22, endHour: 7 }]);
    },
    DB_TIMEOUT,
  );

  it(
    "deleteAccount wipes config (cascading sessions/interventions), memory and coach (AC-4)",
    async () => {
      const db = await createDb(tmpPath());
      await ensureDefaultUser(db);
      const config = new PgConfigRepo(db);
      const memory = new PgMemoryRepo(db);
      const coach = new PgCoachRepo(db);
      const sessions = new PgSessionRepo(db);

      const habit: Habit = { id: HABIT_ID, title: "H", type: "reduce", status: "active" };
      const commitment: Commitment = {
        id: COMMIT_ID,
        naturalText: "sera",
        days: [1, 2, 3],
        startMinuteOfDay: 1260,
        endMinuteOfDay: 1290,
        durationMinutes: 30,
        version: 1,
        confirmedByUser: true,
      };
      const rule: Rule = {
        id: RULE_ID,
        habitId: HABIT_ID,
        commitmentId: COMMIT_ID,
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
      const session: InterventionSession = {
        id: SESSION_ID,
        ruleId: RULE_ID,
        date: "2026-07-14",
        state: "intervened",
        level: InterventionLevel.ContextualNudge,
        interventionsSent: 1,
      };
      const intervention: Intervention = {
        id: INTV_ID,
        sessionId: SESSION_ID,
        action: "nudge",
        channel: "push",
        message: "hi",
        sentAt: "2026-07-14T21:03:00Z",
        level: InterventionLevel.ContextualNudge,
      };

      await config.createHabit(habit);
      await config.createCommitment(commitment, HABIT_ID);
      await config.createRule(rule);
      await memory.add(memItem);
      await coach.set(coachProfile);
      await sessions.save(session);
      await sessions.appendIntervention(intervention);

      // What Api.deleteAccount does in durable mode.
      await config.deleteAll();
      await memory.deleteAll();
      await coach.deleteAll();

      const { rows } = await db.query<{
        h: number; c: number; r: number; m: number; co: number; s: number; i: number;
      }>(
        `SELECT (SELECT count(*) FROM habits)::int AS h,
                (SELECT count(*) FROM commitments)::int AS c,
                (SELECT count(*) FROM rules)::int AS r,
                (SELECT count(*) FROM memory_items)::int AS m,
                (SELECT count(*) FROM coach_profiles)::int AS co,
                (SELECT count(*) FROM intervention_sessions)::int AS s,
                (SELECT count(*) FROM interventions)::int AS i`,
      );
      await db.close();

      const c = rows[0]!;
      expect(c.h).toBe(0);
      expect(c.c).toBe(0);
      expect(c.r).toBe(0);
      expect(c.m).toBe(0);
      expect(c.co).toBe(0);
      expect(c.s).toBe(0); // sessions cascaded from rules
      expect(c.i).toBe(0); // interventions cascaded from sessions
    },
    DB_TIMEOUT,
  );
});
