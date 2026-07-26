import { describe, it, expect, beforeEach } from "vitest";
import { InterventionLevel } from "@pa/shared-types";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";

// Fake LLM: returns a fixed, complete intent (deterministic test).
class FakeExtractor implements IntentExtractor {
  constructor(private intent: Intent) {}
  async extract(): Promise<Intent> {
    return this.intent;
  }
}

const completeIntent: Intent = {
  goal: "leggere",
  substituteBehavior: "lettura",
  motivation: "non arrivare a fine anno senza aver letto nulla",
  days: [1, 2, 3, 4, 5],
  startMinuteOfDay: 1260,
  durationMinutes: 30,
  interferingApps: ["instagram"],
  intensity: "firm",
};

describe("Backend API — full chat → confirm → active rule flow (§25, §42.3)", () => {
  let store: MemoryStore;
  let api: Api;

  beforeEach(() => {
    store = new MemoryStore();
    const ai = new AiOrchestrationService(new FakeExtractor(completeIntent));
    api = new Api(store, ai);
  });

  it("draftRule returns a complete, confirmable draft (never active)", async () => {
    const res = await api.draftRule("voglio leggere alle 21, sii severo");
    expect(res.ok).toBe(true);
    expect(res.data!.status).toBe("complete");
  });

  it("rejects empty chat text", async () => {
    const res = await api.draftRule("");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it("createHabit then confirmRule produces an enabled rule", async () => {
    const habit = await api.createHabit({
      title: "Lettura serale",
      type: "substitute",
      motivation: completeIntent.motivation,
      substituteBehavior: "lettura",
    });
    expect(habit.ok).toBe(true);

    const draft = await api.draftRule("voglio leggere alle 21");
    if (draft.data!.status !== "complete") throw new Error("expected complete draft");

    const rule = await api.confirmRule(habit.data!.id, draft.data!.proposal);
    expect(rule.ok).toBe(true);
    expect(rule.data!.enabled).toBe(true);
    expect(rule.data!.escalation).toContain(InterventionLevel.Restriction);

    // The commitment created is marked confirmed (§42.3).
    const commitment = store.commitments.get(rule.data!.commitmentId);
    expect(commitment!.confirmedByUser).toBe(true);
  });

  it("confirmRule on a missing habit → 404", async () => {
    const fakeProposal = {
      goal: "x",
      habitType: "build" as const,
      days: [1],
      startMinuteOfDay: 600,
      endMinuteOfDay: 630,
      durationMinutes: 30,
      interferingApps: [],
      thresholdMinutes: 2,
      intensity: "firm" as const,
      cooldownSeconds: 60,
      escalation: [InterventionLevel.ContextualNudge],
      maxInterventionsPerSession: 3,
      maxInterventionsPerDay: 8,
      exceptions: [],
    };
    const res = await api.confirmRule("nope", fakeProposal);
    expect(res.status).toBe(404);
  });

  it("suspendRule disables an active rule", async () => {
    const habit = await api.createHabit({ title: "H", type: "build" });
    const draft = await api.draftRule("x");
    if (draft.data!.status !== "complete") throw new Error("expected complete");
    const rule = await api.confirmRule(habit.data!.id, draft.data!.proposal);
    const res = await api.suspendRule(rule.data!.id);
    expect(res.data!.enabled).toBe(false);
  });
});

describe("Backend API — memory CRUD (§18.4)", () => {
  let store: MemoryStore;
  let api: Api;

  beforeEach(() => {
    store = new MemoryStore();
    api = new Api(store, new AiOrchestrationService(new FakeExtractor(completeIntent)));
  });

  it("add, list, and soft-delete memory", () => {
    const added = api.addMemory({
      content: "Voglio leggere di più",
      category: "goal",
      source: "user_stated",
      confidence: 1,
      proactiveUseAllowed: true,
    });
    expect(added.ok).toBe(true);

    expect(api.listMemory("u1").data).toHaveLength(1);

    api.deleteMemory(added.data!.id);
    expect(api.listMemory("u1").data).toHaveLength(0); // soft-deleted hidden
  });

  it("rejects empty memory content", () => {
    const res = api.addMemory({
      content: "",
      category: "goal",
      source: "user_stated",
      confidence: 1,
      proactiveUseAllowed: true,
    });
    expect(res.status).toBe(400);
  });

  it("deleteAccount wipes all user data (§26.1)", async () => {
    await api.createHabit({ title: "H", type: "build" });
    api.addMemory({
      content: "x",
      category: "goal",
      source: "user_stated",
      confidence: 1,
      proactiveUseAllowed: true,
    });
    const res = api.deleteAccount("u1");
    expect(res.data!.deleted).toBe(true);
    expect(store.habits.size).toBe(0);
    expect(store.memory.size).toBe(0);
  });
});
