import { InterventionLevel, type IntensityMode } from "@pa/shared-types";

/**
 * Deterministic policy defaults per intensity mode (spec §14).
 * The AI does NOT invent escalation ladders or cooldowns — it picks an intensity
 * label and this table maps it to safe, bounded parameters (§14.5 "limiti
 * obbligatori ... configurabili entro un intervallo sicuro, non eliminabili").
 */
export interface IntensityPolicy {
  escalation: InterventionLevel[];
  cooldownSeconds: number;
  maxInterventionsPerSession: number;
  maxInterventionsPerDay: number;
  defaultToleranceMinutes: number;
}

export const INTENSITY_POLICY: Record<IntensityMode, IntensityPolicy> = {
  // §14.1 Leggera — un preavviso, un richiamo, nessuna restrizione, ampio cooldown.
  light: {
    escalation: [InterventionLevel.GentleReminder, InterventionLevel.ContextualNudge],
    cooldownSeconds: 300,
    maxInterventionsPerSession: 2,
    maxInterventionsPerDay: 4,
    defaultToleranceMinutes: 5,
  },
  // §14.2 Equilibrata — preavviso, richiamo, secondo intervento, frizione facoltativa.
  balanced: {
    escalation: [
      InterventionLevel.GentleReminder,
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Friction,
    ],
    cooldownSeconds: 120,
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 8,
    defaultToleranceMinutes: 3,
  },
  // §14.3 Ferma — preavviso, richiamo, restrizione, domanda all'uscita.
  firm: {
    escalation: [
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Restriction,
    ],
    cooldownSeconds: 60,
    maxInterventionsPerSession: 3,
    maxInterventionsPerDay: 10,
    defaultToleranceMinutes: 2,
  },
  // §14.4 Estrema — escalation composta, MAI notifiche ogni 20s. Restriction è il
  // massimo automatico; StrictContract (§13.7) resta escluso perché non deve
  // essere attivato automaticamente.
  extreme: {
    escalation: [
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Friction,
      InterventionLevel.Restriction,
    ],
    cooldownSeconds: 45,
    maxInterventionsPerSession: 4,
    maxInterventionsPerDay: 12,
    defaultToleranceMinutes: 1,
  },
};

/** §14.5 hard bounds — the engine/validator clamp to these; never removable. */
export const SAFETY_BOUNDS = {
  minCooldownSeconds: 30,
  maxInterventionsPerDayCeiling: 15,
  maxInterventionsPerSessionCeiling: 5,
} as const;
