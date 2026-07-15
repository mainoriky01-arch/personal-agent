import { describe, it, expect } from "vitest";
import type { Intent } from "@pa/rule-drafting";
import type { MessageContext } from "@pa/intervention-writer";
import { InterventionLevel, type CoachProfile } from "@pa/shared-types";
import {
  AiOrchestrationService,
  type IntentExtractor,
  type CopyWriter,
} from "../src/orchestration.js";

class FakeExtractor implements IntentExtractor {
  constructor(private intent: Intent) {}
  async extract() {
    return this.intent;
  }
}

const coach: CoachProfile = {
  tone: "direct",
  intensity: "firm",
  maxMessageLength: 300,
  humor: false,
  bannedWords: [],
  quietHours: [],
};

const msgCtx: MessageContext = {
  goal: "leggere",
  detectedApp: "Instagram",
  level: InterventionLevel.DirectIntervention,
  action: "direct_message",
  channel: "push",
  coach,
};

describe("AiOrchestrationService (§23.6)", () => {
  it("incomplete chat → needs_info draft with questions (§12.4)", async () => {
    const ai = new AiOrchestrationService(new FakeExtractor({ goal: "leggere" }));
    const draft = await ai.draftFromChat("vorrei leggere");
    expect(draft.status).toBe("needs_info");
    if (draft.status !== "needs_info") return;
    expect(draft.missing.length).toBeGreaterThan(0);
  });

  it("prefers safe AI copy for interventions", async () => {
    const writer: CopyWriter = {
      async write() {
        return "Hai aperto Instagram nel tempo per leggere. Chiudi e inizia.";
      },
    };
    const ai = new AiOrchestrationService(new FakeExtractor({}), writer);
    const out = await ai.writeIntervention(msgCtx);
    expect(out.source).toBe("ai");
  });

  it("rejects unsafe AI copy (fail closed §27.5)", async () => {
    const writer: CopyWriter = {
      async write() {
        return "Sei un fallito e fallirai anche oggi.";
      },
    };
    const ai = new AiOrchestrationService(new FakeExtractor({}), writer);
    const out = await ai.writeIntervention(msgCtx);
    expect(out.source).not.toBe("ai");
  });
});
