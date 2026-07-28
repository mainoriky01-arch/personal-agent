import { describe, it, expect, vi } from "vitest";
import {
  LlmIntentExtractor,
  llmConfigFromEnv,
  parseIntent,
  type LlmComplete,
} from "../src/llm-intent-extractor.js";

/**
 * COD-14 — the LLM IntentExtractor's parsing, env-selection, and error handling,
 * all hermetic: the transport is injected, so no network runs.
 */

describe("LLM intent extractor (COD-14)", () => {
  it("maps a well-formed JSON reply to a validated Intent (AC-1, AC-4)", async () => {
    const reply = JSON.stringify({
      goal: "leggere",
      habitType: "reduce",
      days: [1, 2, 3, 4, 5],
      startMinuteOfDay: 1260,
      interferingApps: ["instagram"],
      intensity: "firm",
      wantsRestriction: true,
    });
    const complete: LlmComplete = async () => reply;
    const intent = await new LlmIntentExtractor(complete).extract("voglio leggere alle 21");
    expect(intent).toEqual({
      goal: "leggere",
      habitType: "reduce",
      days: [1, 2, 3, 4, 5],
      startMinuteOfDay: 1260,
      interferingApps: ["instagram"],
      intensity: "firm",
      wantsRestriction: true,
    });
  });

  it("tolerates prose/markdown around the JSON and drops ill-typed keys (AC-4)", () => {
    const raw = 'Sure! Here you go:\n```json\n{"goal":"x","days":"notarray","intensity":"nope","durationMinutes":30}\n```';
    expect(parseIntent(raw)).toEqual({ goal: "x", durationMinutes: 30 });
  });

  it("returns an empty Intent for unparseable output (AC-4)", () => {
    expect(parseIntent("no json here")).toEqual({});
    expect(parseIntent("{ not valid json ")).toEqual({});
  });

  it("swallows transport errors and returns an empty Intent, logging once (AC-4)", async () => {
    const complete: LlmComplete = async () => {
      throw new Error("anthropic_http_401");
    };
    const log = vi.fn();
    const intent = await new LlmIntentExtractor(complete, log).extract("hi");
    expect(intent).toEqual({});
    expect(log).toHaveBeenCalledOnce();
  });

  it("never throws on network failure — the request stays alive (AC-4)", async () => {
    const complete: LlmComplete = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(new LlmIntentExtractor(complete, () => {}).extract("x")).resolves.toEqual({});
  });

  describe("env selection (AC-2)", () => {
    it("returns null when ANTHROPIC_API_KEY is unset → stub is used", () => {
      expect(llmConfigFromEnv({})).toBeNull();
      expect(llmConfigFromEnv({ ANTHROPIC_API_KEY: "  " })).toBeNull();
    });

    it("returns a config when the key is present, with model/base defaults", () => {
      const c = llmConfigFromEnv({ ANTHROPIC_API_KEY: "sk-test" })!;
      expect(c).not.toBeNull();
      expect(c.model).toBe("claude-sonnet-5");
      expect(c.baseUrl).toBe("https://api.anthropic.com");
    });

    it("honours ANTHROPIC_MODEL / ANTHROPIC_BASE_URL overrides", () => {
      const c = llmConfigFromEnv({
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_MODEL: "claude-opus-5",
        ANTHROPIC_BASE_URL: "https://proxy.example",
      })!;
      expect(c.model).toBe("claude-opus-5");
      expect(c.baseUrl).toBe("https://proxy.example");
    });
  });
});
