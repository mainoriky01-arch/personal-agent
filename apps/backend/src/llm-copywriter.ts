import type { MessageContext } from "@pa/intervention-writer";
import type { CopyWriter } from "./orchestration.js";
import type { LlmComplete } from "./llm-intent-extractor.js";

/**
 * Real LLM-backed CopyWriter (COD-15). Drafts intervention copy by calling
 * Anthropic's Messages API over the injectable `LlmComplete` transport reused
 * from COD-14 (raw `fetch`, no SDK — CLAUDE.md §1.4).
 *
 * The draft is UNTRUSTED: `InterventionService` still runs every output through
 * the Safety Layer (`composeMessage` → `checkSafety`) before delivery, and any
 * failure here resolves `undefined` so composition falls back to the safe
 * template. The engine's deterministic hot path (`decide()`) never calls this —
 * copy is filled only after the engine has already chosen to intervene.
 */

// The system prompt PRIMES the model for safe copy; the Safety Layer is still the
// hard gate. It mirrors the prohibitions encoded in `@pa/intervention-writer`.
export const COPY_SYSTEM_PROMPT = [
  "Sei il coach di un'app per il focus. Scrivi UN solo messaggio breve, in italiano,",
  "che inviti gentilmente la persona a tornare al suo obiettivo. Regole tassative:",
  "- incoraggiante e rispettoso, mai giudicante o colpevolizzante;",
  "- NIENTE diagnosi cliniche, minacce, conseguenze inventate, insulti o umiliazioni;",
  "- non fingere emozioni umane né un rapporto personale reale;",
  "- una o due frasi, concise;",
  "- rispondi con il SOLO testo del messaggio: niente virgolette, niente prefissi, niente markdown.",
].join("\n");

const TONE_LABEL: Record<string, string> = {
  gentle: "gentile e caloroso",
  balanced: "equilibrato",
  direct: "diretto e sintetico",
  severe: "fermo ma rispettoso",
  ironic: "leggermente ironico ma rispettoso",
  rational: "razionale, basato sui fatti",
  competitive: "sfidante ma incoraggiante",
};

/** Build the user turn from the structured MessageContext. Pure. */
export function copyPrompt(ctx: MessageContext): string {
  const lines: Array<string | undefined> = [
    `Obiettivo della persona: ${ctx.goal}.`,
    ctx.motivation ? `Sua motivazione: "${ctx.motivation}".` : undefined,
    ctx.detectedApp ? `Si è distratta con: ${ctx.detectedApp}.` : undefined,
    ctx.windowLabel ? `Fascia oraria dedicata: ${ctx.windowLabel}.` : undefined,
    ctx.minutesElapsed !== undefined ? `Minuti trascorsi nella fascia: ${ctx.minutesElapsed}.` : undefined,
    `Tono richiesto: ${TONE_LABEL[ctx.coach.tone] ?? ctx.coach.tone}.`,
    ctx.coach.maxMessageLength > 0 ? `Lunghezza massima: ${ctx.coach.maxMessageLength} caratteri.` : undefined,
  ];
  return lines.filter((l): l is string => Boolean(l)).join("\n");
}

export class LlmCopyWriter implements CopyWriter {
  constructor(
    private readonly complete: LlmComplete,
    private readonly log: (msg: string) => void = (m) => console.error(m), // eslint-disable-line no-console
  ) {}

  async write(ctx: MessageContext): Promise<string | undefined> {
    try {
      const raw = await this.complete(COPY_SYSTEM_PROMPT, copyPrompt(ctx));
      const text = raw.trim();
      return text.length > 0 ? text : undefined;
    } catch (e) {
      // Safe fallback: undefined → composeMessage uses the template (AC-3/AC-5).
      // Never throws, so the intervention tick stays alive.
      this.log(`[llm-copy] draft failed: ${(e as Error).message}`);
      return undefined;
    }
  }
}
