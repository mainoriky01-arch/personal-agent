import type { Intent, ValidationIssue } from "./types.js";
import { SAFETY_BOUNDS } from "./policy.js";

/** §27.2 — structural validation of AI-extracted values BEFORE they can become a
 *  rule. Returns issues with values that are present but invalid. Missing values
 *  are handled separately (see missingFields). */
export function validateIntent(intent: Intent): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const inDayRange = (d: number) => Number.isInteger(d) && d >= 0 && d <= 6;
  if (intent.days) {
    if (intent.days.length === 0) issues.push({ field: "days", message: "Nessun giorno selezionato." });
    if (intent.days.some((d) => !inDayRange(d)))
      issues.push({ field: "days", message: "Giorni non validi (attesi 0-6)." });
    if (new Set(intent.days).size !== intent.days.length)
      issues.push({ field: "days", message: "Giorni duplicati." });
  }

  const inMinuteRange = (m: number) => Number.isInteger(m) && m >= 0 && m < 1440;
  if (intent.startMinuteOfDay !== undefined && !inMinuteRange(intent.startMinuteOfDay))
    issues.push({ field: "startMinuteOfDay", message: "Orario di inizio non valido." });
  if (intent.endMinuteOfDay !== undefined && !inMinuteRange(intent.endMinuteOfDay))
    issues.push({ field: "endMinuteOfDay", message: "Orario di fine non valido." });

  // Zero-length window (start == end) is invalid; wrapping past midnight is OK.
  if (
    intent.startMinuteOfDay !== undefined &&
    intent.endMinuteOfDay !== undefined &&
    intent.startMinuteOfDay === intent.endMinuteOfDay
  ) {
    issues.push({ field: "endMinuteOfDay", message: "La finestra ha durata zero (inizio = fine)." });
  }

  if (intent.durationMinutes !== undefined && (intent.durationMinutes <= 0 || intent.durationMinutes > 1440))
    issues.push({ field: "durationMinutes", message: "Durata non valida." });

  if (intent.toleranceMinutes !== undefined && (intent.toleranceMinutes < 0 || intent.toleranceMinutes > 120))
    issues.push({ field: "toleranceMinutes", message: "Tolleranza fuori intervallo (0-120 min)." });

  // Duration must fit inside the window when both known (non-wrapping case).
  if (
    intent.startMinuteOfDay !== undefined &&
    intent.endMinuteOfDay !== undefined &&
    intent.durationMinutes !== undefined &&
    intent.startMinuteOfDay < intent.endMinuteOfDay
  ) {
    const windowLen = intent.endMinuteOfDay - intent.startMinuteOfDay;
    if (intent.durationMinutes > windowLen)
      issues.push({ field: "durationMinutes", message: "La durata supera la finestra." });
  }

  return issues;
}

/** Clamp a value into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** §14.5 — apply non-removable safety ceilings to policy-derived numbers. */
export function applySafetyBounds(cooldownSeconds: number, perSession: number, perDay: number) {
  return {
    cooldownSeconds: Math.max(SAFETY_BOUNDS.minCooldownSeconds, cooldownSeconds),
    maxInterventionsPerSession: clamp(perSession, 1, SAFETY_BOUNDS.maxInterventionsPerSessionCeiling),
    maxInterventionsPerDay: clamp(perDay, 1, SAFETY_BOUNDS.maxInterventionsPerDayCeiling),
  };
}
