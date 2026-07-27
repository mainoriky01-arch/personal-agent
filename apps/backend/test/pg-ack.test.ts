import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterventionLevel, type Habit, type Commitment, type Rule } from "@pa/shared-types";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";
import { PgSessionRepo } from "../src/db/pg-session-repo.js";

/**
 * COD-12 — the barrage ack (and the last-foreground-seconds it rides on) is
 * durable: it survives a restart on the (rule, day) session.
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const HABIT_ID = "11111111-1111-1111-1111-111111111111";
const COMMIT_ID = "22222222-2222-2222-2222-222222222222";
const RULE_ID = "33333333-3333-3333-3333-333333333333";
const SESSION_ID = "44444444-4444-4444-4444-444444444444";
const DATE = "2026-07-14";

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-ack-"));
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
  barrage: true,
  enabled: true,
};

describe("COD-12 — durable barrage ack", () => {
  it(
    "acknowledged + lastForegroundSeconds persist across reopen (AC-3)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      const config = new PgConfigRepo(db1);
      await config.createHabit(habit);
      await config.createCommitment(commitment, HABIT_ID);
      await config.createRule(rule);

      const repo1 = new PgSessionRepo(db1);
      await repo1.save({
        id: SESSION_ID,
        ruleId: RULE_ID,
        date: DATE,
        state: "intervened",
        level: InterventionLevel.ContextualNudge,
        interventionsSent: 1,
        acknowledged: true,
        lastForegroundSeconds: 130,
      });
      await db1.close();
      await settle();

      const db2 = await createDb(path);
      const repo2 = new PgSessionRepo(db2);
      const got = await repo2.find(RULE_ID, DATE);
      await db2.close();

      expect(got!.acknowledged).toBe(true);
      expect(got!.lastForegroundSeconds).toBe(130);
    },
    DB_TIMEOUT,
  );
});
