import type {
  Rule,
  InterventionSession,
  Intervention,
  CoachProfile,
  Channel,
} from "@pa/shared-types";

/**
 * Ports (hexagonal architecture). The InterventionService depends only on these
 * interfaces, never on a concrete DB or network client. The backend (§23) wires
 * real implementations (Postgres, APNs/FCM, Telegram); tests wire in-memory fakes.
 * This is what lets the orchestrator be unit-tested end-to-end with no I/O.
 */

/** Persistence for sessions (spec §24 InterventionSession). */
export interface SessionRepo {
  /** Find the live session for a rule on a given date, if any. */
  find(ruleId: string, date: string): Promise<InterventionSession | null>;
  save(session: InterventionSession): Promise<void>;
  /** Count interventions already recorded today for a rule (§14.5 daily budget). */
  countInterventionsToday(ruleId: string, date: string): Promise<number>;
  appendIntervention(intervention: Intervention): Promise<void>;
}

/** Injected clock so time is deterministic in tests (never `new Date()` inside). */
export interface Clock {
  nowIso(): string;
}

/** Delivery abstraction (spec §20 channels). Returns a delivery id or throws. */
export interface Deliverer {
  deliver(input: {
    channel: Channel;
    text: string;
    sessionId: string;
  }): Promise<{ deliveryId: string }>;
}

/** A minimal id generator (so tests can make ids deterministic). */
export interface IdGen {
  next(prefix: string): string;
}

/** Signals coming from the phone / OS monitor for one evaluation tick (§23.4). */
export interface TickSignal {
  rule: Rule;
  coach: CoachProfile;
  /** Local minute-of-day resolved by the caller (TZ/DST already applied). */
  minuteOfDay: number;
  /** Local day of week (0=Sun..6=Sat). */
  dayOfWeek: number;
  /** ISO date of the window (session key). */
  date: string;
  inWindow: boolean;
  distractionDetected: boolean;
  habitCompleted: boolean;
  exceptionActive: boolean;
  coachPaused: boolean;
  quietHours: boolean;
  emergencyRequested: boolean;
  /** Context for message composition. */
  goal: string;
  motivation?: string;
  detectedApp?: string;
  windowLabel?: string;
  minutesElapsed?: number;
  channel: Channel;
}
