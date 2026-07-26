import {
  InterventionLevel,
  type Rule,
  type InterventionSession,
  type SessionState,
  type InterventionAction,
} from "@pa/shared-types";
import { cooldownElapsed } from "./time.js";

/**
 * The deterministic intervention engine (spec §13-15, §42.4-5).
 *
 * DESIGN: `decide()` is a PURE function. Given a rule, the current session, and
 * a context snapshot, it returns the next Decision. It performs NO I/O, reads NO
 * global clock (now is passed in), and NEVER calls an LLM. This is the "motore
 * deterministico" the spec mandates: the AI proposes rules and writes message
 * copy, but execution lives here and is fully testable.
 */

export interface DecisionContext {
  nowIso: string;
  /** Is the phone currently inside the commitment window? */
  inWindow: boolean;
  /** Is today an active day for the commitment? */
  activeDay: boolean;
  /** Has the distraction threshold been crossed (from the OS monitor)? */
  distractionDetected: boolean;
  /** Did the user complete the habit this session? */
  habitCompleted: boolean;
  /** Total interventions already sent today across all sessions of this rule. */
  interventionsToday: number;
  /** Is an exception (§8.5) active for today? */
  exceptionActive: boolean;
  /** Has the user hit "Basta per oggi" / paused the coach? (§7.6, §14.5) */
  coachPaused: boolean;
  /** Is the current time inside a configured quiet-hours band? (§14.5) */
  quietHours: boolean;
  /** Did the user request the emergency exit? (§7.6) */
  emergencyRequested: boolean;
}

export type DecisionKind =
  | "none" // do nothing (gated / not applicable)
  | "prewarn" // §15 step 2 — send the pre-window reminder
  | "intervene" // send an intervention at the given level
  | "escalate" // move one rung up the ladder and send
  | "complete" // habit done — close the session
  | "skip" // user consciously skipped
  | "emergency" // emergency unlock path
  | "terminate"; // window ended / session over

export interface Decision {
  kind: DecisionKind;
  /** Next session state to persist. */
  nextState: SessionState;
  /** Level to act at (when kind is intervene/escalate). */
  level: InterventionLevel;
  /** Concrete action the executor should perform. */
  action?: InterventionAction;
  /** Machine-readable reason — spec §29 "ogni notifica deve avere un motivo"
   *  and §42.20 "ogni funzione deve poter spiegare perché è intervenuta". */
  reason: string;
}

const NOOP = (state: SessionState, reason: string): Decision => ({
  kind: "none",
  nextState: state,
  level: InterventionLevel.ObserveOnly,
  reason,
});

/** Map an escalation level to the concrete action performed at that level. */
export function actionForLevel(level: InterventionLevel): InterventionAction {
  switch (level) {
    case InterventionLevel.ObserveOnly:
      return "reminder";
    case InterventionLevel.GentleReminder:
      return "reminder";
    case InterventionLevel.ContextualNudge:
      return "nudge";
    case InterventionLevel.DirectIntervention:
      return "direct_message";
    case InterventionLevel.Friction:
      return "friction";
    case InterventionLevel.Restriction:
      return "restrict";
    case InterventionLevel.StrictContract:
      return "restrict";
    default:
      return "reminder";
  }
}

/** Next level up the rule's own escalation ladder (never past its max). */
export function nextLevel(rule: Rule, current: InterventionLevel): InterventionLevel {
  const ladder = rule.escalation;
  const idx = ladder.indexOf(current);
  if (idx === -1) return ladder[0] ?? InterventionLevel.GentleReminder;
  const next = ladder[Math.min(idx + 1, ladder.length - 1)];
  return next ?? current;
}

/**
 * Core decision. Order of guards matters: hard stops (§29 "non inviare se...")
 * are evaluated before any escalation logic.
 */
export function decide(
  rule: Rule,
  session: InterventionSession,
  ctx: DecisionContext,
): Decision {
  // ── Hard stops (§29) ──────────────────────────────────────────────
  if (!rule.enabled) return NOOP(session.state, "rule_disabled");
  if (ctx.emergencyRequested)
    return { kind: "emergency", nextState: "emergency", level: session.level, reason: "emergency_exit_requested" };
  if (ctx.coachPaused) return NOOP(session.state, "coach_paused");
  if (ctx.exceptionActive) return NOOP(session.state, "exception_active");
  if (ctx.habitCompleted)
    return { kind: "complete", nextState: "completed", level: session.level, reason: "habit_completed" };

  // Window ended → terminate any live session.
  if (!ctx.inWindow && (session.state === "window_open" || session.state === "distraction_detected" || session.state === "escalated" || session.state === "restricted")) {
    return { kind: "terminate", nextState: "terminated", level: session.level, reason: "window_ended" };
  }
  if (!ctx.activeDay) return NOOP(session.state, "not_active_day");

  // ── Daily anti-spam budget (§14.5) ────────────────────────────────
  if (ctx.interventionsToday >= rule.maxInterventionsPerDay)
    return NOOP(session.state, "daily_budget_exhausted");

  // ── Scheduling: pre-warn before the window (§15 step 2) ───────────
  if (session.state === "scheduled" && !ctx.inWindow) {
    return { kind: "prewarn", nextState: "prewarned", level: InterventionLevel.GentleReminder, action: "reminder", reason: "prewindow_reminder" };
  }

  // Window open with no distraction yet — observe, do not intervene.
  if (ctx.inWindow && !ctx.distractionDetected && (session.state === "scheduled" || session.state === "prewarned")) {
    return { kind: "none", nextState: "window_open", level: InterventionLevel.ObserveOnly, reason: "window_open_observing" };
  }

  // ── Distraction handling (§13.2+ / §15 steps 4-9) ─────────────────
  if (ctx.inWindow && ctx.distractionDetected) {
    // Quiet hours suppress NEW proactive messages (§14.5) but the shield/restriction
    // path may still apply. For simplicity here we gate messaging only.
    // First contact: the distraction may already be present the first time we
    // see the window (scheduled/prewarned) — e.g. a single above-threshold usage
    // signal — or right after opening it (window_open). Either way we intervene
    // immediately (§13.2); there is no mandatory observe-only warm-up tick.
    if (session.state === "scheduled" || session.state === "prewarned" || session.state === "window_open") {
      const first = rule.escalation[0] ?? InterventionLevel.ContextualNudge;
      return { kind: "intervene", nextState: "intervened", level: first, action: actionForLevel(first), reason: "first_distraction_contact" };
    }

    if (session.state === "intervened" || session.state === "ignored" || session.state === "escalated") {
      // Session per-event cap (§8.9 — "non considerare ogni notifica come nuovo evento").
      if (session.interventionsSent >= rule.maxInterventionsPerSession)
        return NOOP("escalated", "session_cap_reached");

      // Cooldown gate before escalating (§14.5).
      if (!cooldownElapsed(session.lastInterventionAt, rule.cooldownSeconds, ctx.nowIso))
        return NOOP(session.state, "cooldown_active");

      // Quiet hours: hold escalation messaging.
      if (ctx.quietHours) return NOOP(session.state, "quiet_hours");

      const up = nextLevel(rule, session.level);
      return { kind: "escalate", nextState: "escalated", level: up, action: actionForLevel(up), reason: "escalation_after_ignore" };
    }
  }

  return NOOP(session.state, "no_condition_met");
}
