import type {
  Rule,
  InterventionSession,
  InterventionLevel,
} from "@pa/shared-types";

/**
 * Time & window helpers — spec §39.1 lists "time zone / ora legale / eccezioni /
 * orario attraversa mezzanotte" as mandatory unit-test surface. Kept pure:
 * every function takes its inputs explicitly, no `new Date()` inside, so tests
 * are deterministic.
 */

/** Minutes since local midnight for a given Date, in a fixed offset model.
 *  For real TZ/DST correctness the backend passes minute-of-day already resolved;
 *  here we operate on the caller-provided minute-of-day to stay pure. */
export function isWithinWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) {
    // Normal same-day window, e.g. 1260..1290.
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  // Window wraps past midnight, e.g. 23:30 (1410) .. 00:30 (30).
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** §8.5 — is today an active day for this commitment? */
export function isActiveDay(dayOfWeek: number, activeDays: number[]): boolean {
  return activeDays.includes(dayOfWeek);
}

/** §14.5 / §29 — cooldown gate. Returns true if enough time has elapsed. */
export function cooldownElapsed(
  lastInterventionAtIso: string | undefined,
  cooldownSeconds: number,
  nowIso: string,
): boolean {
  if (!lastInterventionAtIso) return true;
  const last = Date.parse(lastInterventionAtIso);
  const now = Date.parse(nowIso);
  return now - last >= cooldownSeconds * 1000;
}
