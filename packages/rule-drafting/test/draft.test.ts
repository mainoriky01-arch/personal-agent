import { describe, it, expect } from "vitest";
import { InterventionLevel } from "@pa/shared-types";
import { draftRuleFromIntent, summarize } from "../src/draft.js";
import { validateIntent, applySafetyBounds, clamp } from "../src/validate.js";
import { INTENSITY_POLICY, SAFETY_BOUNDS } from "../src/policy.js";
import type { Intent } from "../src/types.js";

// A fully-specified intent: "Lun-Ven 21:00, 30 min lettura, Instagram distrae, firm+restrizione"
const fullIntent: Intent = {
  goal: "leggere",
  substituteBehavior: "lettura",
  motivation: "non arrivare a fine anno senza aver letto nulla",
  days: [1, 2, 3, 4, 5],
  startMinuteOfDay: 1260, // 21:00
  durationMinutes: 30,
  interferingApps: ["instagram"],
  intensity: "firm",
  wantsRestriction: true,
};

describe("draftRuleFromIntent — complete path (§12 esempio)", () => {
  it("produces a complete, confirmable proposal", () => {
    const draft = draftRuleFromIntent(fullIntent);
    expect(draft.status).toBe("complete");
    if (draft.status !== "complete") return;
    expect(draft.proposal.goal).toBe("leggere");
    expect(draft.proposal.days).toEqual([1, 2, 3, 4, 5]);
    expect(draft.proposal.startMinuteOfDay).toBe(1260);
    expect(draft.proposal.endMinuteOfDay).toBe(1290); // 21:00 + 30
    expect(draft.proposal.durationMinutes).toBe(30);
  });

  it("infers 'substitute' habit type when a substitute behaviour is present (§11.4)", () => {
    const draft = draftRuleFromIntent(fullIntent);
    if (draft.status !== "complete") throw new Error("expected complete");
    expect(draft.proposal.habitType).toBe("substitute");
  });

  it("maps intensity 'firm' to its policy ladder (§14.3)", () => {
    const draft = draftRuleFromIntent(fullIntent);
    if (draft.status !== "complete") throw new Error("expected complete");
    expect(draft.proposal.escalation).toEqual(INTENSITY_POLICY.firm.escalation);
    expect(draft.proposal.escalation).toContain(InterventionLevel.Restriction);
  });

  it("summary is human-readable and includes the window + restriction (§9.3, §10.7)", () => {
    const draft = draftRuleFromIntent(fullIntent);
    if (draft.status !== "complete") throw new Error("expected complete");
    expect(draft.summary).toContain("Lun-Ven");
    expect(draft.summary).toContain("21:00-21:30");
    expect(draft.summary).toContain("restrizione");
  });

  it("NEVER auto-activates: no 'active' flag, only a proposal (§42.3)", () => {
    const draft = draftRuleFromIntent(fullIntent);
    if (draft.status !== "complete") throw new Error("expected complete");
    // The proposal is a plan; activation is the app's job after confirmation.
    expect("enabled" in draft.proposal).toBe(false);
  });
});

describe("draftRuleFromIntent — needs_info path (§12.4)", () => {
  it("asks the fewest questions for a bare intent", () => {
    const draft = draftRuleFromIntent({ goal: "leggere" });
    expect(draft.status).toBe("needs_info");
    if (draft.status !== "needs_info") return;
    const fields = draft.missing.map((m) => m.field);
    expect(fields).toContain("startMinuteOfDay");
    expect(fields).toContain("interferingApps");
    expect(fields).toContain("days");
    // Every missing field carries a ready-to-send Italian question.
    for (const m of draft.missing) expect(m.question.length).toBeGreaterThan(0);
  });

  it("goal question appears when neither goal nor habitType given", () => {
    const draft = draftRuleFromIntent({});
    if (draft.status !== "needs_info") throw new Error("expected needs_info");
    expect(draft.missing.some((m) => m.field === "goal")).toBe(true);
  });
});

describe("draftRuleFromIntent — end/duration resolution", () => {
  it("derives end from start + duration", () => {
    const d = draftRuleFromIntent({ ...fullIntent, endMinuteOfDay: undefined, durationMinutes: 45 });
    if (d.status !== "complete") throw new Error("expected complete");
    expect(d.proposal.endMinuteOfDay).toBe(1305); // 21:00 + 45
  });

  it("derives duration from start + end", () => {
    const d = draftRuleFromIntent({ ...fullIntent, durationMinutes: undefined, endMinuteOfDay: 1320 });
    if (d.status !== "complete") throw new Error("expected complete");
    expect(d.proposal.durationMinutes).toBe(60); // 22:00 - 21:00
  });

  it("handles window wrapping past midnight for duration", () => {
    // 23:30 start, end 00:15 → 45 min
    const d = draftRuleFromIntent({ ...fullIntent, startMinuteOfDay: 1410, durationMinutes: undefined, endMinuteOfDay: 15 });
    if (d.status !== "complete") throw new Error("expected complete");
    expect(d.proposal.durationMinutes).toBe(45);
  });
});

describe("validateIntent (§27.2)", () => {
  it("flags zero-length window", () => {
    const issues = validateIntent({ startMinuteOfDay: 600, endMinuteOfDay: 600 });
    expect(issues.some((i) => i.field === "endMinuteOfDay")).toBe(true);
  });

  it("flags invalid day numbers and duplicates", () => {
    expect(validateIntent({ days: [1, 9] }).some((i) => i.field === "days")).toBe(true);
    expect(validateIntent({ days: [1, 1] }).some((i) => i.field === "days")).toBe(true);
  });

  it("flags out-of-range times", () => {
    expect(validateIntent({ startMinuteOfDay: 2000 }).length).toBeGreaterThan(0);
  });

  it("flags duration exceeding a non-wrapping window", () => {
    const issues = validateIntent({ startMinuteOfDay: 1260, endMinuteOfDay: 1290, durationMinutes: 60 });
    expect(issues.some((i) => i.field === "durationMinutes")).toBe(true);
  });

  it("invalid values route the whole draft to needs_info", () => {
    const draft = draftRuleFromIntent({ ...fullIntent, days: [1, 9] });
    expect(draft.status).toBe("needs_info");
  });
});

describe("safety bounds (§14.5 — limiti non eliminabili)", () => {
  it("clamps helper works", () => {
    expect(clamp(20, 1, 5)).toBe(5);
    expect(clamp(-3, 1, 5)).toBe(1);
    expect(clamp(3, 1, 5)).toBe(3);
  });

  it("cooldown never goes below the floor", () => {
    const b = applySafetyBounds(10, 3, 8);
    expect(b.cooldownSeconds).toBe(SAFETY_BOUNDS.minCooldownSeconds);
  });

  it("per-day interventions never exceed the ceiling", () => {
    const b = applySafetyBounds(60, 99, 999);
    expect(b.maxInterventionsPerDay).toBeLessThanOrEqual(SAFETY_BOUNDS.maxInterventionsPerDayCeiling);
    expect(b.maxInterventionsPerSession).toBeLessThanOrEqual(SAFETY_BOUNDS.maxInterventionsPerSessionCeiling);
  });

  it("every intensity mode maps to a valid bounded policy", () => {
    for (const mode of ["light", "balanced", "firm", "extreme"] as const) {
      const d = draftRuleFromIntent({ ...fullIntent, intensity: mode });
      if (d.status !== "complete") throw new Error(`expected complete for ${mode}`);
      expect(d.proposal.cooldownSeconds).toBeGreaterThanOrEqual(SAFETY_BOUNDS.minCooldownSeconds);
      expect(d.proposal.maxInterventionsPerDay).toBeLessThanOrEqual(SAFETY_BOUNDS.maxInterventionsPerDayCeiling);
      // §14.4 — extreme must NOT include the strict-contract level automatically.
      expect(d.proposal.escalation).not.toContain(InterventionLevel.StrictContract);
    }
  });
});
