import type { Intent, RuleDraft } from "@pa/rule-drafting";
import { draftRuleFromIntent } from "@pa/rule-drafting";
import type { MessageContext } from "@pa/intervention-writer";
import { composeMessage } from "@pa/intervention-writer";

/**
 * AI Orchestration Service (spec §23.6). Coordinates the LLM-facing work:
 *   - intent extraction from chat text
 *   - rule drafting (delegated to the deterministic @pa/rule-drafting)
 *   - intervention message copy (delegated to @pa/intervention-writer, which
 *     runs the Safety Layer)
 *
 * The LLM itself is an injected PORT (`IntentExtractor` / `CopyWriter`). This
 * keeps the orchestrator deterministic and testable, and enforces spec §27.3:
 * the AI proposes, the deterministic layers validate + gate, the user confirms.
 */

/** LLM port: turn free chat text into a structured Intent (spec §12.2). */
export interface IntentExtractor {
  extract(text: string): Promise<Intent>;
}

/** LLM port: optional copy for an intervention. Untrusted — still safety-gated. */
export interface CopyWriter {
  write(ctx: MessageContext): Promise<string | undefined>;
}

export class AiOrchestrationService {
  constructor(
    private readonly extractor: IntentExtractor,
    private readonly copywriter?: CopyWriter,
  ) {}

  /**
   * Chat → rule draft. Never activates anything (§42.3): returns a draft the
   * user must confirm, or the questions to ask if info is missing.
   */
  async draftFromChat(text: string): Promise<RuleDraft> {
    const intent = await this.extractor.extract(text);
    return draftRuleFromIntent(intent);
  }

  /** Compose an intervention message, preferring safe AI copy when available. */
  async writeIntervention(ctx: MessageContext) {
    const aiDraft = this.copywriter ? await this.copywriter.write(ctx) : undefined;
    return composeMessage(ctx, aiDraft);
  }
}
