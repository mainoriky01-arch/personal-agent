import { randomUUID } from "node:crypto";
import {
  type Habit,
  type Rule,
  type Commitment,
  type MemoryItem,
  type CoachProfile,
  type Intervention,
} from "@pa/shared-types";
import type { RuleProposal } from "@pa/rule-drafting";
import { isWithinWindow } from "@pa/rule-engine";
import type {
  InterventionService,
  TickSignal,
  Clock,
} from "@pa/intervention-service";
import {
  MemoryConfigRepo,
  MemoryMemoryRepo,
  MemoryCoachRepo,
  type MemoryStore,
  type ConfigRepo,
  type MemoryRepo,
  type CoachRepo,
} from "./repos.js";
import type { AiOrchestrationService } from "./orchestration.js";

/**
 * API handlers (spec §25). Pure functions over a MemoryStore + services, so they
 * are transport-agnostic: a NestJS/Express controller just deserialises the HTTP
 * request and calls these. Every write is idempotent-friendly (caller supplies
 * ids where relevant) per §25.
 */

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** Result of a `POST /usage` tick (§23.4 EventService → §23.5 Intervention). */
export interface UsageResult {
  /** Engine decision kind (none / intervene / escalate / …). */
  decisionKind: string;
  /** Machine-readable reason for the decision (§42.20). */
  reason: string;
  /** True when an alarm was actually delivered on this tick. */
  delivered: boolean;
  /** The delivered intervention record, when `delivered` is true. */
  intervention?: Intervention;
}

const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const err = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

// Ids are UUIDs: the durable schema (schema.sql) keys every table on UUID, so
// generated ids must be valid UUIDs to persist in pg mode (and stay opaque in
// memory mode). The prefix argument is kept only for call-site readability.
const genId = (_prefix: string) => randomUUID();

/** Fallback coach when the user has no stored profile (§14 defaults). */
const DEFAULT_COACH: CoachProfile = {
  tone: "direct",
  intensity: "firm",
  maxMessageLength: 200,
  humor: false,
  bannedWords: [],
  quietHours: [],
};

const systemClock: Clock = { nowIso: () => new Date().toISOString() };

export class Api {
  /** Config/memory/coach persistence. Durable in production (pg repos),
   * in-memory by default so existing callers are unchanged. */
  private readonly config: ConfigRepo;
  private readonly memory: MemoryRepo;
  private readonly coach: CoachRepo;

  constructor(
    private readonly store: MemoryStore,
    private readonly ai: AiOrchestrationService,
    /** Wired in production/main.ts; when absent, `POST /usage` is unavailable. */
    private readonly intervention?: InterventionService,
    private readonly clock: Clock = systemClock,
    /** Durable repos (COD-3/COD-4); each defaults to an in-memory repo over `store`. */
    config?: ConfigRepo,
    memory?: MemoryRepo,
    coach?: CoachRepo,
  ) {
    this.config = config ?? new MemoryConfigRepo(store);
    this.memory = memory ?? new MemoryMemoryRepo(store);
    this.coach = coach ?? new MemoryCoachRepo(store);
  }

  // §25 — POST /chat/draft : chat text → confirmable rule draft (never activates)
  async draftRule(text: string) {
    if (!text?.trim()) return err(400, "empty_text");
    const draft = await this.ai.draftFromChat(text);
    return ok(draft);
  }

  // §23.4/§25 — POST /usage : a raw screen-time report from the phone drives the
  // deterministic engine and, past the rule's threshold in-window, fires a push
  // alarm. The phone is a dumb sensor; every decision lives in the engine (COD-1).
  async ingestUsage(input: {
    ruleId?: unknown;
    appId?: unknown;
    foregroundSeconds?: unknown;
    atIso?: unknown;
  }): Promise<ApiResult<UsageResult>> {
    // ── Validate the raw report (AC-1) ──────────────────────────────
    const ruleId = typeof input.ruleId === "string" ? input.ruleId.trim() : "";
    const appId = typeof input.appId === "string" ? input.appId.trim() : "";
    const foregroundSeconds = input.foregroundSeconds;
    if (!ruleId) return err(400, "ruleId_required");
    if (!appId) return err(400, "appId_required");
    if (
      typeof foregroundSeconds !== "number" ||
      !Number.isFinite(foregroundSeconds) ||
      foregroundSeconds < 0
    ) {
      return err(400, "foregroundSeconds_invalid");
    }
    const atIso = typeof input.atIso === "string" ? input.atIso : undefined;

    if (!this.intervention) return err(503, "intervention_service_unavailable");

    const rule = await this.config.getRule(ruleId);
    if (!rule) return err(404, "rule_not_found");

    // ── Resolve "now" and the local window position ─────────────────
    // atIso is the phone's report time; window position is derived from it. For
    // the in-memory backend we resolve minute-of-day/day-of-week in UTC — real
    // per-user timezone resolution is UserProfileService's job (§23.2).
    const now = atIso ?? this.clock.nowIso();
    const at = new Date(now);
    if (Number.isNaN(at.getTime())) return err(400, "atIso_invalid");
    const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
    const dayOfWeek = at.getUTCDay();
    const date = at.toISOString().slice(0, 10);

    const commitment = await this.config.getCommitment(rule.commitmentId);
    const inTimeWindow = commitment
      ? isWithinWindow(minuteOfDay, commitment.startMinuteOfDay, commitment.endMinuteOfDay)
      : false;
    const activeDay = commitment ? commitment.days.includes(dayOfWeek) : false;
    const inWindow = inTimeWindow && activeDay;

    // Outside the committed window (wrong time or non-active day) the usage
    // endpoint does nothing: it only drives in-window distraction alarms, never
    // pre-window reminders (those are a separate scheduler path). (AC-5)
    if (!inWindow) {
      return ok({ decisionKind: "none", reason: "out_of_window", delivered: false });
    }

    // ── Threshold decision — the backend is the only brain (AC-2, AC-3) ──
    // foregroundSeconds is the CURRENT continuous foreground streak reported by
    // the phone (it resets to zero on each fresh open); we compare that streak
    // against the rule's threshold and never accumulate anything server-side.
    const isTargetApp = rule.interferingApps.includes(appId);
    const distractionDetected = isTargetApp && foregroundSeconds >= rule.thresholdMinutes * 60;

    const habit = await this.config.getHabit(rule.habitId);
    const coach = (await this.coach.get()) ?? DEFAULT_COACH;

    const sig: TickSignal = {
      rule,
      coach,
      minuteOfDay,
      dayOfWeek,
      date,
      inWindow: true,
      distractionDetected,
      habitCompleted: false,
      exceptionActive: rule.exceptions.some((e) => e.date === date),
      coachPaused: false,
      quietHours: false, // TODO(§14.5): resolve quiet-hours bands via UserProfileService — out of COD-1 scope
      emergencyRequested: false,
      goal: habit?.title ?? "",
      motivation: habit?.motivation,
      detectedApp: appId,
      minutesElapsed: Math.floor(foregroundSeconds / 60),
      channel: "push",
    };

    const result = await this.intervention.handleTick(sig);
    return ok({
      decisionKind: result.decisionKind,
      reason: result.reason,
      delivered: Boolean(result.intervention),
      intervention: result.intervention,
    });
  }

  // §25 — POST /habits : create a habit
  async createHabit(
    input: Omit<Habit, "id" | "status"> & { status?: Habit["status"] },
  ): Promise<ApiResult<Habit>> {
    if (!input.title?.trim()) return err(400, "title_required");
    const habit: Habit = { id: genId("habit"), status: input.status ?? "active", ...input };
    await this.config.createHabit(habit);
    return ok(habit, 201);
  }

  // §25 — POST /rules/confirm : turn a confirmed proposal into an active rule (§42.3)
  async confirmRule(habitId: string, proposal: RuleProposal): Promise<ApiResult<Rule>> {
    const habit = await this.config.getHabit(habitId);
    if (!habit) return err(404, "habit_not_found");

    const commitment: Commitment = {
      id: genId("commit"),
      naturalText: proposal.goal,
      days: proposal.days,
      startMinuteOfDay: proposal.startMinuteOfDay,
      endMinuteOfDay: proposal.endMinuteOfDay,
      durationMinutes: proposal.durationMinutes,
      version: 1,
      confirmedByUser: true, // this endpoint IS the user confirmation (§42.3)
    };
    await this.config.createCommitment(commitment, habitId);

    const rule: Rule = {
      id: genId("rule"),
      habitId,
      commitmentId: commitment.id,
      intensity: proposal.intensity,
      interferingApps: proposal.interferingApps,
      thresholdMinutes: proposal.thresholdMinutes,
      cooldownSeconds: proposal.cooldownSeconds,
      escalation: proposal.escalation,
      exceptions: proposal.exceptions, // persisted as rule_exceptions (AC-4)
      maxInterventionsPerSession: proposal.maxInterventionsPerSession,
      maxInterventionsPerDay: proposal.maxInterventionsPerDay,
      enabled: true,
    };
    await this.config.createRule(rule);
    return ok(rule, 201);
  }

  // §25 — PATCH /rules/:id/suspend
  async suspendRule(ruleId: string): Promise<ApiResult<Rule>> {
    const updated = await this.config.setRuleEnabled(ruleId, false);
    if (!updated) return err(404, "rule_not_found");
    return ok(updated);
  }

  // §25 — GET /memory
  async listMemory(_userId: string): Promise<ApiResult<MemoryItem[]>> {
    return ok(await this.memory.listActive());
  }

  // §25 — POST /memory
  async addMemory(
    item: Omit<MemoryItem, "id" | "status"> & { status?: MemoryItem["status"] },
  ): Promise<ApiResult<MemoryItem>> {
    if (!item.content?.trim()) return err(400, "content_required");
    const mem: MemoryItem = { id: genId("mem"), status: item.status ?? "active", ...item };
    await this.memory.add(mem);
    return ok(mem, 201);
  }

  // §25 — DELETE /memory/:id  (user control §18.4)
  async deleteMemory(id: string): Promise<ApiResult<{ id: string }>> {
    const removed = await this.memory.softDelete(id);
    if (!removed) return err(404, "memory_not_found");
    return ok({ id });
  }

  // §25 — DELETE /account  (§26.1 cancellazione account + dati). In durable mode
  // this wipes the user's pg data (habits cascade to commitments/rules/exceptions
  // and sessions/interventions), memory items and coach profile (AC-4).
  async deleteAccount(_userId: string): Promise<ApiResult<{ deleted: boolean }>> {
    await this.config.deleteAll();
    await this.memory.deleteAll();
    await this.coach.deleteAll();
    return ok({ deleted: true });
  }
}
