import { InterventionLevel, type HabitType, type RuleException } from "@pa/shared-types";
import type {
  Intent,
  MissingField,
  RuleDraft,
  RuleProposal,
} from "./types.js";
import { INTENSITY_POLICY } from "./policy.js";
import { validateIntent, applySafetyBounds } from "./validate.js";

/** Format minute-of-day as HH:MM. */
function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const DAY_LABELS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  // Detect Mon-Fri.
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return "Lun-Ven";
  if (sorted.length === 7) return "Tutti i giorni";
  return sorted.map((d) => DAY_LABELS[d]).join(", ");
}

/** §12.4 — the ordered questions the agent asks for missing pieces. Only the
 *  fields that are TRULY required to build a rule are considered blocking. */
function missingFields(intent: Intent): MissingField[] {
  const missing: MissingField[] = [];
  if (!intent.goal && !intent.habitType)
    missing.push({ field: "goal", question: "Qual è il comportamento che vuoi cambiare per primo?" });
  if (intent.startMinuteOfDay === undefined)
    missing.push({ field: "startMinuteOfDay", question: "A che ora vuoi iniziare?" });
  if (intent.durationMinutes === undefined && intent.endMinuteOfDay === undefined)
    missing.push({ field: "durationMinutes", question: "Quanti minuti vuoi dedicarci?" });
  if (!intent.interferingApps || intent.interferingApps.length === 0)
    missing.push({ field: "interferingApps", question: "Quali app ti distraggono in quel momento?" });
  if (!intent.days || intent.days.length === 0)
    missing.push({ field: "days", question: "In quali giorni? (es. da lunedì a venerdì)" });
  return missing;
}

function inferHabitType(intent: Intent): HabitType {
  if (intent.habitType) return intent.habitType;
  // If there's a substitute behaviour, it's a substitution rule (§11.4).
  if (intent.substituteBehavior) return "substitute";
  return "build";
}

/**
 * Core: turn an AI-extracted Intent into a confirmable RuleDraft.
 * Deterministic. Never activates anything (§42.3). If information is missing or
 * invalid, returns `needs_info` with the questions to ask.
 */
export function draftRuleFromIntent(intent: Intent): RuleDraft {
  const missing = missingFields(intent);
  const issues = validateIntent(intent);

  // Resolve end time from duration when only one is given (non-wrapping).
  let start = intent.startMinuteOfDay;
  let end = intent.endMinuteOfDay;
  let duration = intent.durationMinutes;
  if (start !== undefined) {
    if (end === undefined && duration !== undefined) end = (start + duration) % 1440;
    if (duration === undefined && end !== undefined) {
      duration = end > start ? end - start : 1440 - start + end;
    }
  }

  if (missing.length > 0 || issues.length > 0) {
    return {
      status: "needs_info",
      missing,
      issues,
      partial: {
        goal: intent.goal,
        days: intent.days,
        startMinuteOfDay: start,
        endMinuteOfDay: end,
        durationMinutes: duration,
        interferingApps: intent.interferingApps,
      },
    };
  }

  // All required present + valid. Build the proposal.
  const intensity = intent.intensity ?? "balanced";
  // INTENSITY_POLICY has an entry for every IntensityMode; the fallback keeps
  // TypeScript's noUncheckedIndexedAccess happy without a non-null assertion.
  const policy = INTENSITY_POLICY[intensity] ?? INTENSITY_POLICY.balanced;
  const tolerance = intent.toleranceMinutes ?? policy.defaultToleranceMinutes;
  const bounds = applySafetyBounds(
    policy.cooldownSeconds,
    policy.maxInterventionsPerSession,
    policy.maxInterventionsPerDay,
  );

  const exceptions: RuleException[] = (intent.exceptions ?? []).map((reason, i) => ({
    id: `exc_${i}`,
    reason,
  }));

  // Non-null assertions are safe: missingFields guaranteed these are present.
  const proposal: RuleProposal = {
    goal: intent.goal!,
    habitType: inferHabitType(intent),
    substituteBehavior: intent.substituteBehavior,
    motivation: intent.motivation,
    days: intent.days!,
    startMinuteOfDay: start!,
    endMinuteOfDay: end!,
    durationMinutes: duration!,
    interferingApps: intent.interferingApps!,
    thresholdMinutes: tolerance,
    intensity,
    cooldownSeconds: bounds.cooldownSeconds,
    escalation: policy.escalation,
    maxInterventionsPerSession: bounds.maxInterventionsPerSession,
    maxInterventionsPerDay: bounds.maxInterventionsPerDay,
    exceptions,
  };

  return { status: "complete", proposal, summary: summarize(proposal) };
}

/** §10.7 / §9.3 — human-readable summary shown before "Attiva questa promessa". */
export function summarize(p: RuleProposal): string {
  const window = `${fmt(p.startMinuteOfDay)}-${fmt(p.endMinuteOfDay)}`;
  const apps = p.interferingApps.join(", ");
  const restr = p.escalation.includes(InterventionLevel.Restriction) ? " e applica la restrizione" : "";
  const base =
    `${formatDays(p.days)}, tra le ${window}, voglio ${p.goal} (${p.durationMinutes} min). ` +
    `Se uso ${apps}, ricordami il mio obiettivo${restr}.`;
  const mode = ` Intensità: ${p.intensity}. Tolleranza: ${p.thresholdMinutes} min.`;
  return base + mode;
}
