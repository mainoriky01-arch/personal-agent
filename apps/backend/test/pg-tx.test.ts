import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterventionLevel, type Habit, type Commitment, type Rule } from "@pa/shared-types";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";
import { PgMemoryRepo } from "../src/db/pg-memory-repo.js";
import { PgCoachRepo } from "../src/db/pg-coach-repo.js";

/**
 * COD-5: durable writes that span multiple statements are atomic. File-backed
 * PGlite is slow to boot, so these carry a generous timeout. Ids are UUIDs.
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const HABIT_ID = "11111111-1111-1111-1111-111111111111";
const COMMIT_ID = "22222222-2222-2222-2222-222222222222";
const RULE_ID = "33333333-3333-3333-3333-333333333333";
const EXC_ID = "44444444-4444-4444-4444-444444444444";
const MEM_ID = "55555555-5555-5555-5555-555555555555";

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-tx-"));
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
const baseRule: Rule = {
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

describe("COD-5 — atomic durable writes", () => {
  it(
    "createRule rolls back the rule when an exception insert fails (AC-1, AC-2)",
    async () => {
      const db = await createDb(tmpPath());
      await ensureDefaultUser(db);
      const config = new PgConfigRepo(db);
      await config.createHabit(habit);
      await config.createCommitment(commitment, HABIT_ID);

      // Two exceptions sharing the same id → the second INSERT violates the PK,
      // so the whole createRule transaction must roll back (no orphan rule).
      const badRule: Rule = {
        ...baseRule,
        exceptions: [
          { id: EXC_ID, date: null as unknown as undefined, reason: "a" },
          { id: EXC_ID, date: null as unknown as undefined, reason: "b" },
        ],
      };
      await expect(config.createRule(badRule)).rejects.toBeTruthy();

      expect(await config.getRule(RULE_ID)).toBeNull(); // rolled back — no orphan
      await db.close();
    },
    DB_TIMEOUT,
  );

  it(
    "deleteAccount wipes config + memory + coach atomically in durable mode (AC-3)",
    async () => {
      const db = await createDb(tmpPath());
      await ensureDefaultUser(db);
      const config = new PgConfigRepo(db);
      const memory = new PgMemoryRepo(db);
      const coach = new PgCoachRepo(db);

      await config.createHabit(habit);
      await config.createCommitment(commitment, HABIT_ID);
      await config.createRule(baseRule);
      await memory.add({
        id: MEM_ID,
        content: "x",
        category: "goal",
        source: "user_stated",
        confidence: 1,
        proactiveUseAllowed: true,
        status: "active",
      });
      await coach.set({
        tone: "direct",
        intensity: "firm",
        maxMessageLength: 200,
        humor: false,
        bannedWords: [],
        quietHours: [],
      });

      const api = new Api(
        new MemoryStore(),
        new AiOrchestrationService(new FakeExtractor()),
        undefined,
        undefined,
        config,
        memory,
        coach,
        db,
      );
      const res = await api.deleteAccount("default");
      expect(res.data!.deleted).toBe(true);

      const { rows } = await db.query<{ h: number; m: number; co: number }>(
        `SELECT (SELECT count(*) FROM habits)::int AS h,
                (SELECT count(*) FROM memory_items)::int AS m,
                (SELECT count(*) FROM coach_profiles)::int AS co`,
      );
      await db.close();

      expect(rows[0]!.h).toBe(0);
      expect(rows[0]!.m).toBe(0);
      expect(rows[0]!.co).toBe(0);
    },
    DB_TIMEOUT,
  );
});
