import { describe, it, expect, vi } from "vitest";
import {
  InterventionLevel,
  type CoachProfile,
} from "@pa/shared-types";
import { composeMessage, type MessageContext } from "@pa/intervention-writer";
import { LlmCopyWriter, copyPrompt } from "../src/llm-copywriter.js";
import type { LlmComplete } from "../src/llm-intent-extractor.js";

/**
 * COD-15 — the LLM CopyWriter: draft mapping, error fallback, and the Safety
 * Layer gate. Hermetic: the transport is injected, so no network runs. The gate
 * is exercised via `composeMessage` — exactly what InterventionService calls.
 */

const coach: CoachProfile = {
  tone: "gentle",
  intensity: "balanced",
  maxMessageLength: 200,
  humor: false,
  bannedWords: [],
  quietHours: [],
};

const ctx: MessageContext = {
  goal: "leggere",
  motivation: "voglio finire il libro",
  detectedApp: "Instagram",
  windowLabel: "21:00-21:30",
  minutesElapsed: 3,
  level: InterventionLevel.DirectIntervention,
  action: "direct_message",
  channel: "push",
  coach,
};

describe("LLM copywriter (COD-15)", () => {
  it("returns the trimmed model draft on success (AC-2)", async () => {
    const complete: LlmComplete = async () => "  Torna al tuo libro: bastano due minuti per iniziare.  ";
    const text = await new LlmCopyWriter(complete).write(ctx);
    expect(text).toBe("Torna al tuo libro: bastano due minuti per iniziare.");
  });

  it("returns undefined for empty output (→ template fallback)", async () => {
    const complete: LlmComplete = async () => "   ";
    expect(await new LlmCopyWriter(complete).write(ctx)).toBeUndefined();
  });

  it("swallows transport errors and returns undefined, logging once (AC-5)", async () => {
    const complete: LlmComplete = async () => {
      throw new Error("anthropic_http_500");
    };
    const log = vi.fn();
    expect(await new LlmCopyWriter(complete, log).write(ctx)).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("never throws on network failure — the tick stays alive (AC-5)", async () => {
    const complete: LlmComplete = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(new LlmCopyWriter(complete, () => {}).write(ctx)).resolves.toBeUndefined();
  });

  describe("Safety Layer gate via composeMessage (AC-3)", () => {
    it("a safe LLM draft is delivered as source 'ai'", async () => {
      const complete: LlmComplete = async () =>
        "Avevi scelto questo momento per leggere. Ti va di ricominciare adesso?";
      const draft = await new LlmCopyWriter(complete).write(ctx);
      const msg = composeMessage(ctx, draft);
      expect(msg.source).toBe("ai");
      expect(msg.text).toBe(draft);
    });

    it("an unsafe LLM draft never reaches the user — falls back to a safe message", async () => {
      const complete: LlmComplete = async () => "Sei un fallito e fallirai anche stasera.";
      const draft = await new LlmCopyWriter(complete).write(ctx);
      const msg = composeMessage(ctx, draft);
      expect(msg.source).not.toBe("ai");
      expect(msg.text).not.toContain("fallito");
    });

    it("a transport error → undefined draft → safe template (no 'ai' source)", async () => {
      const complete: LlmComplete = async () => {
        throw new Error("timeout");
      };
      const draft = await new LlmCopyWriter(complete, () => {}).write(ctx);
      expect(draft).toBeUndefined();
      const msg = composeMessage(ctx, draft);
      expect(msg.source).not.toBe("ai");
      expect(msg.text.length).toBeGreaterThan(0);
    });
  });

  it("copyPrompt includes the goal and detected app, omits absent fields", () => {
    const p = copyPrompt(ctx);
    expect(p).toContain("leggere");
    expect(p).toContain("Instagram");
    const bare = copyPrompt({ ...ctx, motivation: undefined, detectedApp: undefined });
    expect(bare).not.toContain("Instagram");
    expect(bare).not.toContain("motivazione");
  });
});
