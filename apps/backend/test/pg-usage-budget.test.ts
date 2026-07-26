import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterventionLevel, type Habit, type Commitment, type Rule } from "@pa/shared-types";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";
import { PgUsageRepo } from "../src/db/pg-usage-repo.js";

/**
 * COD-9 — durable daily budget: the cumulative counter survives restart and is
 * per-local-day, and `rule.dailyBudgetMinutes` round-trips through the rules
 * table. File-backed PGlite is slow to boot, so these carry a generous timeout.
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const HABIT_ID = "11111111-1111-1111-1111-111111111111";
const COMMIT_ID = "22222222-2222-2222-2222-222222222222";
const RULE_ID = "33333333-3333-3333-3333-333333333333";

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-budget-"));
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
  dailyBudgetMinutes: 30,
  enabled: true,
};

describe("COD-9 — durable daily budget", () => {
  it(
    "dailyBudgetMinutes round-trips; the daily counter accumulates and survives reopen; a new day starts fresh (AC-1, AC-3)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      const config1 = new PgConfigRepo(db1);
      await config1.createHabit(habit);
      await config1.createCommitment(commitment, HABIT_ID);
      await config1.createRule(rule);

      // The optional budget field persists on the rule.
      expect((await config1.getRule(RULE_ID))!.dailyBudgetMinutes).toBe(30);

      const usage1 = new PgUsageRepo(db1);
      expect(await usage1.addForeground(RULE_ID, "2026-07-14", 1000)).toBe(1000);
      expect(await usage1.addForeground(RULE_ID, "2026-07-14", 1000)).toBe(2000);
      await db1.close();
      await settle();

      // Reopen: the running total for that day survived the restart.
      const db2 = await createDb(path);
      const usage2 = new PgUsageRepo(db2);
      expect(await usage2.addForeground(RULE_ID, "2026-07-14", 0)).toBe(2000);
      // A different local day is a separate counter (starts fresh).
      expect(await usage2.addForeground(RULE_ID, "2026-07-15", 500)).toBe(500);
      await db2.close();
    },
    DB_TIMEOUT,
  );
});
