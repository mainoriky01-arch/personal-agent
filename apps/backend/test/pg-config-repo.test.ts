import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterventionLevel, type Habit, type Commitment, type Rule } from "@pa/shared-types";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";

/**
 * PgConfigRepo (COD-3): real Postgres SQL via PGlite persists habits,
 * commitments, rules and rule_exceptions and survives a process restart
 * (reopen of the same file path). File-backed PGlite is slow to boot, so these
 * carry a generous timeout. Ids are UUIDs — the schema keys every table on UUID.
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const HABIT_ID = "11111111-1111-1111-1111-111111111111";
const COMMIT_ID = "22222222-2222-2222-2222-222222222222";
const RULE_ID = "33333333-3333-3333-3333-333333333333";
const EXC_ID = "44444444-4444-4444-4444-444444444444";
const ABSENT_ID = "99999999-9999-9999-9999-999999999999";

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-cfg-"));
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

const habit: Habit = {
  id: HABIT_ID,
  title: "Lettura serale",
  type: "reduce",
  status: "active",
  motivation: "voglio leggere di più",
};
const commitment: Commitment = {
  id: COMMIT_ID,
  naturalText: "Ogni sera alle 21:00 leggo 30 min",
  days: [1, 2, 3, 4, 5],
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
  interferingApps: ["instagram", "tiktok"],
  thresholdMinutes: 1,
  cooldownSeconds: 30,
  escalation: [InterventionLevel.ContextualNudge, InterventionLevel.Restriction],
  exceptions: [{ id: EXC_ID, date: "2026-07-14", reason: "ferie" }],
  maxInterventionsPerSession: 3,
  maxInterventionsPerDay: 8,
  enabled: true,
};

describe("PgConfigRepo — durable user config (COD-3)", () => {
  it(
    "persists habit/commitment/rule (+exceptions) across reopen; suspend persists (AC-1, AC-4)",
    async () => {
      const path = tmpPath();

      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      const repo1 = new PgConfigRepo(db1);
      await repo1.createHabit(habit);
      await repo1.createCommitment(commitment, HABIT_ID);
      await repo1.createRule(rule);
      await repo1.setRuleEnabled(RULE_ID, false);
      await db1.close();
      await settle();

      // Reopen the SAME path — a fresh process would see exactly this.
      const db2 = await createDb(path);
      const repo2 = new PgConfigRepo(db2);
      const gotHabit = await repo2.getHabit(HABIT_ID);
      const gotCommitment = await repo2.getCommitment(COMMIT_ID);
      const gotRule = await repo2.getRule(RULE_ID);
      await db2.close();

      expect(gotHabit?.title).toBe("Lettura serale");
      expect(gotHabit?.motivation).toBe("voglio leggere di più");

      expect(gotCommitment?.confirmedByUser).toBe(true); // AC-4
      expect(gotCommitment?.days).toEqual([1, 2, 3, 4, 5]);
      expect(gotCommitment?.startMinuteOfDay).toBe(1260);

      expect(gotRule?.interferingApps).toEqual(["instagram", "tiktok"]);
      expect(gotRule?.escalation).toEqual([
        InterventionLevel.ContextualNudge,
        InterventionLevel.Restriction,
      ]);
      expect(gotRule?.exceptions).toHaveLength(1); // AC-4 rule_exceptions persisted
      expect(gotRule?.exceptions[0]?.reason).toBe("ferie");
      expect(gotRule?.exceptions[0]?.date).toBe("2026-07-14");
      expect(gotRule?.enabled).toBe(false); // suspend survived the reopen
    },
    DB_TIMEOUT,
  );

  it(
    "returns null for a well-formed but absent id (get + suspend)",
    async () => {
      const db = await createDb(tmpPath());
      await ensureDefaultUser(db);
      const repo = new PgConfigRepo(db);

      expect(await repo.getHabit(ABSENT_ID)).toBeNull();
      expect(await repo.getRule(ABSENT_ID)).toBeNull();
      expect(await repo.setRuleEnabled(ABSENT_ID, false)).toBeNull();

      await db.close();
    },
    DB_TIMEOUT,
  );
});
