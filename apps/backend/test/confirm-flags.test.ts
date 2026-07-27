import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterventionLevel } from "@pa/shared-types";
import type { Intent, RuleProposal } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgConfigRepo } from "../src/db/pg-config-repo.js";

/**
 * COD-13 — /rules/confirm maps the optional `barrage` and `dailyBudgetMinutes`
 * flags onto the created rule (and validates the budget), so the client can
 * configure barrage / daily-budget rules through the API.
 */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

const baseProposal: RuleProposal = {
  goal: "leggere",
  habitType: "reduce",
  days: [1, 2, 3, 4, 5],
  startMinuteOfDay: 1260,
  endMinuteOfDay: 1290,
  durationMinutes: 30,
  interferingApps: ["instagram"],
  thresholdMinutes: 2,
  intensity: "firm",
  cooldownSeconds: 60,
  escalation: [InterventionLevel.ContextualNudge],
  maxInterventionsPerSession: 3,
  maxInterventionsPerDay: 8,
  exceptions: [],
};

const memApi = () => new Api(new MemoryStore(), new AiOrchestrationService(new FakeExtractor()));

describe("POST /rules/confirm — barrage + dailyBudgetMinutes (COD-13)", () => {
  it("maps both flags onto the created rule (AC-2)", async () => {
    const api = memApi();
    const habit = await api.createHabit({ title: "Meno IG", type: "reduce" });
    const rule = await api.confirmRule(habit.data!.id, {
      ...baseProposal,
      barrage: true,
      dailyBudgetMinutes: 30,
    });
    expect(rule.status).toBe(201);
    expect(rule.data!.barrage).toBe(true);
    expect(rule.data!.dailyBudgetMinutes).toBe(30);
  });

  it("omitted flags → barrage false, budget undefined, behavior unchanged (AC-1)", async () => {
    const api = memApi();
    const habit = await api.createHabit({ title: "Meno IG", type: "reduce" });
    const rule = await api.confirmRule(habit.data!.id, baseProposal);
    expect(rule.status).toBe(201);
    expect(rule.data!.barrage).toBe(false);
    expect(rule.data!.dailyBudgetMinutes).toBeUndefined();
  });

  it("rejects a non-positive-integer dailyBudgetMinutes with 400 (AC-3)", async () => {
    const api = memApi();
    const habit = await api.createHabit({ title: "Meno IG", type: "reduce" });
    const hid = habit.data!.id;
    for (const bad of [0, -5, 1.5, "x" as unknown as number]) {
      const r = await api.confirmRule(hid, { ...baseProposal, dailyBudgetMinutes: bad });
      expect(r.status).toBe(400);
      expect(r.error).toBe("dailyBudgetMinutes_invalid");
    }
  });

  it("does not write a rule when the budget is invalid (AC-3)", async () => {
    const store = new MemoryStore();
    const api = new Api(store, new AiOrchestrationService(new FakeExtractor()));
    const habit = await api.createHabit({ title: "Meno IG", type: "reduce" });
    await api.confirmRule(habit.data!.id, { ...baseProposal, dailyBudgetMinutes: 0 });
    expect(store.rules.size).toBe(0);
    expect(store.commitments.size).toBe(0); // validated before any write
  });
});

const dirs: string[] = [];
const settle = () => new Promise((r) => setTimeout(r, 100));
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-confirm-"));
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

describe("POST /rules/confirm — durable flag round-trip (COD-13)", () => {
  it(
    "barrage + dailyBudgetMinutes survive reopen via confirmRule (AC-4)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      const api1 = new Api(
        new MemoryStore(),
        new AiOrchestrationService(new FakeExtractor()),
        undefined,
        undefined,
        new PgConfigRepo(db1),
        undefined,
        undefined,
        db1,
      );
      const habit = await api1.createHabit({ title: "Meno IG", type: "reduce" });
      const rule = await api1.confirmRule(habit.data!.id, {
        ...baseProposal,
        barrage: true,
        dailyBudgetMinutes: 45,
      });
      const ruleId = rule.data!.id;
      await db1.close();
      await settle();

      const db2 = await createDb(path);
      const got = await new PgConfigRepo(db2).getRule(ruleId);
      await db2.close();

      expect(got!.barrage).toBe(true);
      expect(got!.dailyBudgetMinutes).toBe(45);
    },
    30_000,
  );
});
