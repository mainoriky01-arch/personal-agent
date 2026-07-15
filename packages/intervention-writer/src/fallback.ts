import { InterventionLevel } from "@pa/shared-types";
import type { MessageContext } from "./types.js";

/**
 * Local fallback messages (spec §19.1 — OBBLIGATORI). Pre-generated, on-device,
 * never depend on a live AI call. Every escalation level has a safe default so
 * the product works offline / when the model is unavailable (§7.4, §28).
 *
 * These are also the safe destination when the Safety Layer rejects AI copy:
 * fail closed → deliver a template, never the suspect text.
 */

/** Simple {placeholder} interpolation — no logic, no eval. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/** Fallback copy per level. Kept short, factual, and non-degrading. */
const FALLBACK_BY_LEVEL: Record<InterventionLevel, string> = {
  [InterventionLevel.ObserveOnly]: "",
  [InterventionLevel.GentleReminder]:
    "Tra poco inizia il tuo momento per {goal}. Ti va di prepararti?",
  [InterventionLevel.ContextualNudge]:
    "Avevi scelto questo momento per {goal}. Hai aperto {app}. Vuoi iniziare adesso?",
  [InterventionLevel.DirectIntervention]:
    "Sono passati {minutes} minuti su {app}. Non era questo che avevi deciso. Chiudi e inizia con {goal}.",
  [InterventionLevel.Friction]:
    "Fermati un attimo. Avevi riservato questo tempo a {goal}. Vuoi davvero continuare su {app}?",
  [InterventionLevel.Restriction]:
    "Questo è il momento che avevi riservato a {goal}. {app} è in pausa. Inizia, oppure sblocca consapevolmente.",
  [InterventionLevel.StrictContract]:
    "Avevi preso un impegno con te stesso su {goal}. Rispettalo adesso.",
};

export function fallbackMessage(ctx: MessageContext): string {
  const template =
    FALLBACK_BY_LEVEL[ctx.level] ?? FALLBACK_BY_LEVEL[InterventionLevel.ContextualNudge] ?? "";
  return interpolate(template, {
    goal: ctx.goal,
    app: ctx.detectedApp ?? "un'app che ti distrae",
    minutes: String(ctx.minutesElapsed ?? 0),
    window: ctx.windowLabel ?? "",
  }).trim();
}
