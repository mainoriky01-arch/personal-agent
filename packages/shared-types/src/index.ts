/**
 * Domain model — Personal Agent.
 * Direct TypeScript mapping of the entities in spec §8 (terminology) and §24
 * (minimal data model). These types are the shared contract across the app,
 * backend, and rule-engine (spec §42.4 "motore deterministico").
 */

// ── Enums / unions ────────────────────────────────────────────────────────

/** §11 — habit categories. */
export type HabitType =
  | "eliminate" // §11.1 abitudine da eliminare
  | "reduce" // §11.2 da ridurre
  | "build" // §11.3 da costruire
  | "substitute" // §11.4 sostitutiva
  | "routine" // §11.5 routine
  | "situational" // §11.6 regola situazionale
  | "temporary"; // §11.7 impegno temporaneo

/** §14 — how insistent the agent may be. */
export type IntensityMode = "light" | "balanced" | "firm" | "extreme";

/** §13 — intervention escalation levels 0..6. */
export enum InterventionLevel {
  ObserveOnly = 0, // §13.1 solo osservazione
  GentleReminder = 1, // §13.2 promemoria gentile
  ContextualNudge = 2, // §13.3 richiamo contestuale
  DirectIntervention = 3, // §13.4 intervento diretto
  Friction = 4, // §13.5 frizione
  Restriction = 5, // §13.6 restrizione
  StrictContract = 6, // §13.7 contratto severo (mai automatico)
}

/** §15 — intervention session state machine states. */
export type SessionState =
  | "scheduled" // 1 programmato
  | "prewarned" // 2 preavviso inviato
  | "window_open" // 3 finestra iniziata
  | "distraction_detected" // 4 comportamento interferente rilevato
  | "intervened" // 5 primo intervento inviato
  | "user_responded" // 6 utente ha risposto
  | "ignored" // 7 utente ha ignorato
  | "escalated" // 8 escalation
  | "restricted" // 9 restrizione applicata
  | "habit_started" // 10 abitudine iniziata
  | "completed" // 11 completata
  | "skipped" // 12 saltata
  | "emergency" // 13 emergenza
  | "terminated"; // 14 terminata

/** §8.7 — outcome of an intervention. */
export type OutcomeType =
  | "completed"
  | "accepted"
  | "postponed"
  | "ignored"
  | "skipped"
  | "emergency_unlock"
  | "false_positive"
  | "rule_suspended";

/** §13 / §8.6 — action a single intervention performs. */
export type InterventionAction =
  | "reminder"
  | "nudge"
  | "direct_message"
  | "friction"
  | "confirm_request"
  | "start_timer"
  | "restrict"
  | "reflection_question";

/** §20 — delivery channel. */
export type Channel = "in_app" | "push" | "telegram";

// ── Core entities (§24) ─────────────────────────────────────────────────────

/** §24 User */
export interface User {
  id: string;
  email: string;
  language: string;
  timezone: string; // IANA, e.g. "Europe/Rome"
  createdAt: string; // ISO
  status: "active" | "suspended" | "deleted";
  plan: "free" | "pro";
}

/** §24 CoachProfile / §14 intensity + §7.5 limits */
export interface CoachProfile {
  tone: "gentle" | "balanced" | "direct" | "severe" | "ironic" | "rational" | "competitive";
  intensity: IntensityMode;
  maxMessageLength: number;
  humor: boolean;
  bannedWords: string[]; // §18 preferenze: parole da evitare
  quietHours: Array<{ startHour: number; endHour: number }>; // §14.5
}

/** §8.2 Promessa — the human-language commitment. */
export interface Commitment {
  id: string;
  naturalText: string; // "Dal lunedì al venerdì alle 21:00 leggo 30 min"
  days: number[]; // 0=Sun..6=Sat
  startMinuteOfDay: number; // e.g. 21:00 -> 1260
  endMinuteOfDay: number; // e.g. 21:30 -> 1290 (may wrap past midnight)
  durationMinutes: number;
  version: number;
  confirmedByUser: boolean; // §7.2 / §42.3 — never active without this
}

/** §8.1 Habit */
export interface Habit {
  id: string;
  title: string;
  type: HabitType;
  description?: string;
  motivation?: string; // §18 "perché conta" — used in messages (§19)
  status: "active" | "paused" | "archived";
  substituteBehavior?: string; // §5 comportamento sostitutivo desiderato
}

/** §8.3 Rule — technical translation of a Commitment. */
export interface Rule {
  id: string;
  habitId: string;
  commitmentId: string;
  intensity: IntensityMode;
  /** App/category identifiers considered "distraction" during the window. */
  interferingApps: string[];
  /** §13 tolerance before escalation begins. */
  thresholdMinutes: number;
  /** §14.5 seconds between escalations — anti-spam. */
  cooldownSeconds: number;
  /** Ordered escalation ladder actually allowed for this rule. */
  escalation: InterventionLevel[];
  exceptions: RuleException[];
  /** §14.5 hard limits (never fully removable). */
  maxInterventionsPerSession: number;
  maxInterventionsPerDay: number;
  /**
   * Optional cumulative daily cap (minutes of foreground use of the interfering
   * apps, per local day). When set, exceeding it also triggers a distraction —
   * on top of the continuous-streak threshold. Absent → streak-only behavior.
   */
  dailyBudgetMinutes?: number;
  enabled: boolean;
}

/** §8.5 Condition inputs → captured as exceptions/flags. */
export interface RuleException {
  id: string;
  /** ISO date (single-day) or null for a recurring reason. */
  date?: string;
  reason: string;
}

/** §8.9 Sessione di intervento */
export interface InterventionSession {
  id: string;
  ruleId: string;
  date: string; // ISO date of the window
  state: SessionState;
  level: InterventionLevel;
  interventionsSent: number;
  lastInterventionAt?: string; // ISO — for cooldown math
  outcome?: OutcomeType;
}

/** §24 Intervention */
export interface Intervention {
  id: string;
  sessionId: string;
  action: InterventionAction;
  channel: Channel;
  message: string;
  sentAt: string; // ISO
  level: InterventionLevel;
}

/** §18 MemoryItem */
export interface MemoryItem {
  id: string;
  content: string;
  category:
    | "profile"
    | "goal"
    | "motivation"
    | "difficulty"
    | "intervention_pref"
    | "observation"
    | "temporary"
    | "explicit_rule";
  source: "user_stated" | "confirmed_rule" | "system_observation" | "ai_inference" | "approved_summary";
  confidence: number; // 0..1 — inferences must be distinguishable from facts (§18.3)
  expiresAt?: string; // ISO — temporary memories (§18.1)
  proactiveUseAllowed: boolean; // §18.2
  status: "active" | "archived" | "deleted";
}
