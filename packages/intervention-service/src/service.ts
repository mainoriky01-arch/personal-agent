import {
  InterventionLevel,
  type InterventionSession,
  type Intervention,
} from "@pa/shared-types";
import { decide, actionForLevel, type DecisionContext } from "@pa/rule-engine";
import { composeMessage, type MessageContext } from "@pa/intervention-writer";
import type { SessionRepo, Clock, Deliverer, IdGen, TickSignal } from "./ports.js";

/**
 * InterventionService (spec §23.5) — the orchestrator that turns an OS signal
 * into a delivered, safety-checked intervention, and persists the session state.
 *
 * Flow per tick:
 *   1. load/create the session
 *   2. ask the deterministic engine what to do (decide())
 *   3. if it's an actionable intervention → compose a safe message (composeMessage)
 *      and deliver it via the channel
 *   4. persist the new session state + append the intervention record
 *
 * NO AI in the hot path. NO raw Date(). All side-effects go through injected
 * ports, so this whole class is unit-testable with in-memory fakes.
 */

export interface TickResult {
  decisionKind: string;
  reason: string;
  session: InterventionSession;
  /** Present only when a message was actually delivered. */
  intervention?: Intervention;
  messageSource?: "template" | "ai" | "fallback";
}

const ACTIONABLE = new Set(["prewarn", "intervene", "escalate"]);

export class InterventionService {
  constructor(
    private readonly repo: SessionRepo,
    private readonly clock: Clock,
    private readonly deliverer: Deliverer,
    private readonly ids: IdGen,
    /**
     * Optional AI copy provider — untrusted, still passes the safety gate.
     * Async (COD-15): a real LLM copywriter is awaited here. Per CLAUDE.md §1.7
     * the backend is not the real-time brain (enforcement is on-device), so this
     * secondary push path may await a network call. The deterministic hot path is
     * `decide()`, which never calls an LLM.
     */
    private readonly aiDraft?: (ctx: MessageContext) => Promise<string | undefined>,
  ) {}

  async handleTick(sig: TickSignal): Promise<TickResult> {
    const nowIso = this.clock.nowIso();

    // 1. Load or create the session.
    let session =
      (await this.repo.find(sig.rule.id, sig.date)) ??
      this.newSession(sig);

    // 1b. Ack suspend/resume (COD-12). A live ack suppresses delivery for the
    // current foreground stay; a "return" — the reported streak dropping vs the
    // last report, i.e. the app was reopened — clears the ack so the barrage
    // resumes. We always record the latest streak for the next comparison.
    if (sig.foregroundSeconds !== undefined) {
      const prev = session.lastForegroundSeconds;
      const isReturn = prev !== undefined && sig.foregroundSeconds < prev;
      if (session.acknowledged && isReturn) session = { ...session, acknowledged: false };
      session = { ...session, lastForegroundSeconds: sig.foregroundSeconds };
      if (session.acknowledged) {
        // Suppressed for this stay — persist the updated streak, deliver nothing.
        await this.repo.save(session);
        return { decisionKind: "none", reason: "acknowledged", session };
      }
    }

    // 2. Deterministic decision.
    const interventionsToday = await this.repo.countInterventionsToday(sig.rule.id, sig.date);
    const ctx: DecisionContext = {
      nowIso,
      inWindow: sig.inWindow,
      activeDay: sig.rule.enabled, // day-activeness is resolved upstream; enabled gate here
      distractionDetected: sig.distractionDetected,
      habitCompleted: sig.habitCompleted,
      interventionsToday,
      exceptionActive: sig.exceptionActive,
      coachPaused: sig.coachPaused,
      quietHours: sig.quietHours,
      emergencyRequested: sig.emergencyRequested,
    };
    const decision = decide(sig.rule, session, ctx);

    // 3. Apply state transition.
    session = {
      ...session,
      state: decision.nextState,
      level: decision.level,
    };

    let intervention: Intervention | undefined;
    let messageSource: TickResult["messageSource"];

    // 4. If actionable, compose + deliver.
    if (ACTIONABLE.has(decision.kind)) {
      const action = decision.action ?? actionForLevel(decision.level);
      const msgCtx: MessageContext = {
        goal: sig.goal,
        motivation: sig.motivation,
        detectedApp: sig.detectedApp,
        windowLabel: sig.windowLabel,
        minutesElapsed: sig.minutesElapsed,
        level: decision.level,
        action,
        channel: sig.channel,
        coach: sig.coach,
      };
      const composed = composeMessage(msgCtx, await this.aiDraft?.(msgCtx));
      messageSource = composed.source;

      const { deliveryId } = await this.deliverer.deliver({
        channel: sig.channel,
        text: composed.text,
        sessionId: session.id,
      });

      intervention = {
        id: this.ids.next("int"),
        sessionId: session.id,
        action,
        channel: sig.channel,
        message: composed.text,
        sentAt: nowIso,
        level: decision.level,
      };
      await this.repo.appendIntervention(intervention);

      session = {
        ...session,
        interventionsSent: session.interventionsSent + 1,
        lastInterventionAt: nowIso,
      };
      // deliveryId is available for messaging telemetry (§23.8); not persisted here.
      void deliveryId;
    }

    // Terminal outcomes → record on the session.
    if (decision.kind === "complete") session = { ...session, outcome: "completed" };
    if (decision.kind === "skip") session = { ...session, outcome: "skipped" };
    if (decision.kind === "emergency") session = { ...session, outcome: "emergency_unlock" };

    await this.repo.save(session);

    return {
      decisionKind: decision.kind,
      reason: decision.reason,
      session,
      intervention,
      messageSource,
    };
  }

  /**
   * Acknowledge the barrage for a (rule, day) session (COD-12): mark it so
   * subsequent in-window ticks of the current stay deliver nothing. The ack is
   * lifted automatically on the next return (handled in handleTick). Creates a
   * minimal session if none exists yet. Rule existence is validated upstream.
   */
  async acknowledge(ruleId: string, date: string): Promise<void> {
    const existing = await this.repo.find(ruleId, date);
    const session: InterventionSession = existing ?? {
      id: this.ids.next("sess"),
      ruleId,
      date,
      state: "scheduled",
      level: InterventionLevel.ObserveOnly,
      interventionsSent: 0,
    };
    await this.repo.save({ ...session, acknowledged: true });
  }

  private newSession(sig: TickSignal): InterventionSession {
    return {
      id: this.ids.next("sess"),
      ruleId: sig.rule.id,
      date: sig.date,
      state: "scheduled",
      level: InterventionLevel.ObserveOnly,
      interventionsSent: 0,
    };
  }
}
