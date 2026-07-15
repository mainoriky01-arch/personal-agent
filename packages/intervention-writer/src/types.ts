import type {
  InterventionLevel,
  InterventionAction,
  Channel,
  CoachProfile,
} from "@pa/shared-types";

/**
 * Intervention Writer types (spec §19 generazione messaggi, §27.1 Intervention
 * Writer + Safety Layer, §27.5 sicurezza comunicativa).
 *
 * The message that reaches the user is built from structured context and ALWAYS
 * passes through the Safety Layer. The LLM may draft copy, but any output —
 * human, template, or AI — is validated here before delivery (§27.3).
 */

/** Everything needed to compose a message (spec §19 bullet list). */
export interface MessageContext {
  goal: string; // "leggere"
  substituteBehavior?: string; // "iniziare il timer di lettura"
  motivation?: string; // §18 "perché conta"
  detectedApp?: string; // "Instagram"
  windowLabel?: string; // "21:00-21:30"
  minutesElapsed?: number; // minutes past the window start
  level: InterventionLevel;
  action: InterventionAction;
  channel: Channel;
  coach: CoachProfile;
  /** Recent history hint for personal messages (§19 "storia recente"). */
  recentStreak?: number;
}

/** A finished, safety-checked message ready to deliver. */
export interface ComposedMessage {
  text: string;
  level: InterventionLevel;
  action: InterventionAction;
  channel: Channel;
  /** Where the copy came from — for telemetry and debugging (§27.4). */
  source: "template" | "ai" | "fallback";
  /** True if the Safety Layer had to replace/repair the input. */
  wasSanitized: boolean;
}

/** Result of a Safety Layer check (spec §27.5). */
export interface SafetyResult {
  safe: boolean;
  violations: SafetyViolation[];
}

export interface SafetyViolation {
  kind:
    | "diagnosis" // §4.2 / §27.5 — never act as a therapist/doctor
    | "threat" // §7.5 minacce
    | "blackmail" // §27.5 ricatti
    | "degrading" // §7.5 umiliare/insultare
    | "fake_human" // §27.5 messaggi che sembrano da persone reali
    | "invented_consequence" // §7.5 inventare conseguenze
    | "banned_word" // §18 parole da evitare (coach profile)
    | "too_long"; // §19 lunghezza massima
  detail: string;
}
