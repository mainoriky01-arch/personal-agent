/**
 * Backend service map — spec §23. These are STUBS documenting the intended
 * service boundaries, not implementations. Each becomes a NestJS module (§22.2)
 * when Fase 3 begins. Listed here so the architecture is legible from day one.
 *
 * The critical separation (spec §42.4-5): the AI Orchestration Service PROPOSES
 * rules and writes copy, but the Intervention Service executes ONLY through
 * @pa/rule-engine's deterministic `decide()`. The LLM never calls decide's inputs
 * into existence — it fills message text after the engine has chosen the action.
 */

export const SERVICES = [
  "AuthenticationService", // §23.1 — Sign in with Apple/Google, sessions, account deletion
  "UserProfileService", // §23.2 — preferences, timezone, coach, intensity
  "HabitService", // §23.3 — habits, commitments, rules, versioning
  "EventService", // §23.4 — receives ONLY necessary events from the phone
  "InterventionService", // §23.5 — wraps @pa/rule-engine decide(); no AI in the hot path
  "AiOrchestrationService", // §23.6 — chat, intent extraction, rule drafting, copy, safety layer
  "MemoryService", // §23.7 — explicit + behavioural memory, consent, provenance
  "MessagingService", // §23.8 — push, Telegram (WhatsApp later), idempotency, retry
  "AnalyticsService", // §23.9 — pseudonymised product events, separated from content
] as const;

export type ServiceName = (typeof SERVICES)[number];
