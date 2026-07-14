import type {
  HabitType,
  IntensityMode,
  InterventionLevel,
  Rule,
  RuleException,
} from "@pa/shared-types";

/**
 * Rule Drafting types (spec §12 flow, §27.1 Rule Drafting Agent, §27.2 output
 * strutturati validabili).
 *
 * PIPELINE (spec §27.3 "nessuna esecuzione diretta"):
 *   user text
 *     → AI extracts an `Intent` (structured, possibly incomplete)   ← LLM lives here
 *     → draftRuleFromIntent() validates + normalizes                 ← THIS package (deterministic)
 *     → RuleDraft (either `complete` with a Rule, or `needs_info`)
 *     → user confirms (§42.3)                                        ← app UI
 *     → rule-engine executes                                         ← @pa/rule-engine
 *
 * The AI never emits a live Rule. It emits an Intent. This package is the gate.
 */

/** What the AI extracts from natural language. All fields optional: the whole
 *  point of §12.3-4 is that the agent asks the FEWEST questions to fill gaps. */
export interface Intent {
  /** e.g. "read", "instagram limit" — free text label of the goal. */
  goal?: string;
  habitType?: HabitType;
  substituteBehavior?: string; // §5 — the desired replacement behaviour
  motivation?: string; // §18 — "perché conta"
  days?: number[]; // 0=Sun..6=Sat
  startMinuteOfDay?: number; // 21:00 → 1260
  endMinuteOfDay?: number; // 21:30 → 1290
  durationMinutes?: number;
  interferingApps?: string[]; // ["instagram","tiktok"]
  toleranceMinutes?: number; // §12 "tolleranza"
  intensity?: IntensityMode;
  wantsRestriction?: boolean; // "limitamelo, devo essere obbligato"
  exceptions?: string[]; // free-text reasons
}

/** A single missing piece the agent must ask about (§12.4). */
export interface MissingField {
  field: keyof Intent;
  /** Ready-to-send question in Italian (§10 conversational onboarding). */
  question: string;
}

/** A validation problem with an otherwise-present value (§27.2). */
export interface ValidationIssue {
  field: string;
  message: string;
}

/** Result of drafting. Either we have enough to build a (still-unconfirmed) Rule,
 *  or we need to ask the user more. NEVER auto-activates (§42.3). */
export type RuleDraft =
  | {
      status: "complete";
      /** The proposed rule + commitment fields, pending user confirmation. */
      proposal: RuleProposal;
      /** Human-readable summary to show before "Attiva questa promessa" (§10.7). */
      summary: string;
    }
  | {
      status: "needs_info";
      missing: MissingField[];
      issues: ValidationIssue[];
      /** Partial proposal built so far (for progressive UI). */
      partial: Partial<RuleProposal>;
    };

/** The confirmable proposal — mirrors Rule + the human Commitment text. */
export interface RuleProposal {
  goal: string;
  habitType: HabitType;
  substituteBehavior?: string;
  motivation?: string;
  days: number[];
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  durationMinutes: number;
  interferingApps: string[];
  thresholdMinutes: number;
  intensity: IntensityMode;
  cooldownSeconds: number;
  escalation: InterventionLevel[];
  maxInterventionsPerSession: number;
  maxInterventionsPerDay: number;
  exceptions: RuleException[];
}
