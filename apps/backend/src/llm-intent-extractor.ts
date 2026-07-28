import type { Intent } from "@pa/rule-drafting";
import type { IntentExtractor } from "./orchestration.js";

/**
 * Real LLM-backed IntentExtractor (COD-14). Turns free chat text into a
 * structured `Intent` by calling Anthropic's Messages API.
 *
 * Two deliberate constraints from CLAUDE.md are honoured here:
 *  - §1.4 Minimalist dependencies: no SDK is added — the call goes over `fetch`
 *    (built into Node) against the documented Messages API. The transport is an
 *    injected `LlmComplete` so tests never touch the network.
 *  - §1.4 Deterministic hot path: this only feeds `/chat/draft` rule *drafting*.
 *    The engine's `decide()` never calls an LLM.
 *
 * On any failure (network, bad key, unparseable output) the extractor logs and
 * returns an empty `Intent` — the drafting layer then asks the user for the
 * missing info, exactly as the keyword stub's empty result would.
 */

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Injectable transport: (system, user) → the model's raw text output. */
export type LlmComplete = (system: string, user: string) => Promise<string>;

// Intent extraction is a lightweight classification task; a mid-tier model is
// the cost-appropriate default (overridable via ANTHROPIC_MODEL). No date suffix.
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

const SYSTEM_PROMPT = [
  "You extract a focus/habit intent from the user's Italian or English chat message.",
  "Reply with ONLY a compact JSON object, no prose, no markdown fences.",
  "Allowed keys (all optional, omit when unknown):",
  '"goal" (string), "habitType" ("build"|"reduce"|"substitute"|"maintain"),',
  '"substituteBehavior" (string), "motivation" (string),',
  '"days" (array of ints 0=Sun..6=Sat), "startMinuteOfDay" (int 0-1439),',
  '"endMinuteOfDay" (int), "durationMinutes" (int),',
  '"interferingApps" (array of lowercased app names, e.g. ["instagram"]),',
  '"toleranceMinutes" (int), "intensity" ("light"|"balanced"|"firm"|"extreme"),',
  '"wantsRestriction" (boolean), "exceptions" (array of strings).',
  "Never invent values the message does not support.",
].join("\n");

/** Build an `LlmConfig` from env, or null when ANTHROPIC_API_KEY is unset. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv): LlmConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}

/** Real transport: POST /v1/messages via fetch, return concatenated text. */
export function fetchComplete(config: LlmConfig): LlmComplete {
  return async (system, user) => {
    const res = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  };
}

const HABIT_TYPES = new Set(["build", "reduce", "substitute", "maintain"]);
const INTENSITIES = new Set(["light", "balanced", "firm", "extreme"]);

const isIntArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n));
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const asInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

/**
 * Parse the model's raw text into a validated `Intent`. Unknown/ill-typed keys
 * are dropped; anything unparseable yields an empty Intent (never throws). Pure.
 */
export function parseIntent(raw: string): Intent {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (typeof obj !== "object" || obj === null) return {};

  const out: Intent = {};
  if (typeof obj.goal === "string") out.goal = obj.goal;
  if (typeof obj.habitType === "string" && HABIT_TYPES.has(obj.habitType))
    out.habitType = obj.habitType as Intent["habitType"];
  if (typeof obj.substituteBehavior === "string") out.substituteBehavior = obj.substituteBehavior;
  if (typeof obj.motivation === "string") out.motivation = obj.motivation;
  if (isIntArray(obj.days)) out.days = obj.days;
  if (asInt(obj.startMinuteOfDay) !== undefined) out.startMinuteOfDay = obj.startMinuteOfDay as number;
  if (asInt(obj.endMinuteOfDay) !== undefined) out.endMinuteOfDay = obj.endMinuteOfDay as number;
  if (asInt(obj.durationMinutes) !== undefined) out.durationMinutes = obj.durationMinutes as number;
  if (isStrArray(obj.interferingApps)) out.interferingApps = obj.interferingApps;
  if (asInt(obj.toleranceMinutes) !== undefined) out.toleranceMinutes = obj.toleranceMinutes as number;
  if (typeof obj.intensity === "string" && INTENSITIES.has(obj.intensity))
    out.intensity = obj.intensity as Intent["intensity"];
  if (typeof obj.wantsRestriction === "boolean") out.wantsRestriction = obj.wantsRestriction;
  if (isStrArray(obj.exceptions)) out.exceptions = obj.exceptions;
  return out;
}

export class LlmIntentExtractor implements IntentExtractor {
  constructor(
    private readonly complete: LlmComplete,
    private readonly log: (msg: string) => void = (m) => console.error(m), // eslint-disable-line no-console
  ) {}

  async extract(text: string): Promise<Intent> {
    try {
      const raw = await this.complete(SYSTEM_PROMPT, text);
      return parseIntent(raw);
    } catch (e) {
      // Deterministic-safe fallback: an empty intent makes the drafting layer
      // ask the user for the missing info, never crashing the request (AC-4).
      this.log(`[llm-intent] extraction failed: ${(e as Error).message}`);
      return {};
    }
  }
}
