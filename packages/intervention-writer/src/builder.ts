import { InterventionLevel } from "@pa/shared-types";
import type { MessageContext, ComposedMessage } from "./types.js";
import { checkSafety } from "./safety.js";
import { fallbackMessage, interpolate } from "./fallback.js";

/**
 * Message builder (spec §19). Composes a message from structured context, then
 * runs it through the Safety Layer. FAIL CLOSED: if the candidate is unsafe or
 * over-length, we deliver the pre-generated fallback instead (§19.1).
 *
 * `aiDraft` is optional — when the AI Orchestration Service has produced copy,
 * pass it here; it is treated as UNTRUSTED and must pass the same safety gate.
 * When absent, we use the built-in tone templates.
 */

/** Tone-flavoured templates per level (spec §19 examples: gentile/diretto/personale/severo). */
const TONE_TEMPLATES: Record<string, Partial<Record<InterventionLevel, string>>> = {
  gentle: {
    [InterventionLevel.ContextualNudge]:
      "Sono le {window}. Avevi scelto questo momento per {goal}. Ti va di iniziare adesso?",
    [InterventionLevel.DirectIntervention]:
      "Hai aperto {app} durante il tuo tempo per {goal}. Vuoi tornare a quello che avevi deciso?",
  },
  direct: {
    [InterventionLevel.ContextualNudge]:
      "Avevi riservato questo momento a {goal}. Hai aperto {app}. Inizia ora?",
    [InterventionLevel.DirectIntervention]:
      "Hai aperto {app} durante l'orario che avevi riservato a {goal}. Chiudilo e inizia.",
  },
  rational: {
    [InterventionLevel.DirectIntervention]:
      "Sono passati {minutes} minuti su {app}. Il tuo obiettivo era {goal}. Chiudi e riparti.",
  },
};

/** Personal, motivation-anchored copy when a motivation is known (§19). */
function personalLine(ctx: MessageContext): string | undefined {
  if (!ctx.motivation) return undefined;
  return interpolate(
    "Avevi detto: \"{motivation}\". Questo è il momento in cui quella scelta diventa reale. Inizia con {goal}.",
    { motivation: ctx.motivation, goal: ctx.goal },
  );
}

function templateFor(ctx: MessageContext): string {
  const byTone = TONE_TEMPLATES[ctx.coach.tone];
  const candidate = byTone?.[ctx.level];
  if (candidate) {
    return interpolate(candidate, {
      goal: ctx.goal,
      app: ctx.detectedApp ?? "un'app che ti distrae",
      minutes: String(ctx.minutesElapsed ?? 0),
      window: ctx.windowLabel ?? "",
    });
  }
  // A personal line is a good default for direct-level messages.
  if (ctx.level === InterventionLevel.DirectIntervention) {
    const personal = personalLine(ctx);
    if (personal) return personal;
  }
  return fallbackMessage(ctx);
}

/**
 * Compose the final, safety-checked message.
 * @param ctx Structured context.
 * @param aiDraft Optional untrusted AI-generated copy to prefer if it passes safety.
 */
export function composeMessage(ctx: MessageContext, aiDraft?: string): ComposedMessage {
  const base = {
    level: ctx.level,
    action: ctx.action,
    channel: ctx.channel,
  };

  // 1. Prefer AI copy if provided AND safe.
  if (aiDraft && aiDraft.trim()) {
    const check = checkSafety(aiDraft, ctx.coach);
    if (check.safe) {
      return { ...base, text: aiDraft.trim(), source: "ai", wasSanitized: false };
    }
    // AI copy failed → fall through to template (fail closed).
  }

  // 2. Try the tone template.
  const template = templateFor(ctx);
  const templateCheck = checkSafety(template, ctx.coach);
  if (templateCheck.safe) {
    const usedAi = Boolean(aiDraft && aiDraft.trim());
    return { ...base, text: template, source: "template", wasSanitized: usedAi };
  }

  // 3. Last resort: the guaranteed-safe fallback. If even that trips length,
  //    hard-truncate — this must never fail.
  let fb = fallbackMessage(ctx);
  if (ctx.coach.maxMessageLength > 0 && fb.length > ctx.coach.maxMessageLength) {
    fb = fb.slice(0, ctx.coach.maxMessageLength);
  }
  return { ...base, text: fb, source: "fallback", wasSanitized: true };
}
