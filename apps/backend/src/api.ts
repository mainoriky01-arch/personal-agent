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
import type { Db } from "./db/db.js";

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

const COACH_TONES = ["gentle", "balanced", "direct", "severe", "ironic", "rational", "competitive"] as const;
const COACH_INTENSITIES = ["light", "balanced", "firm", "extreme"] as const;

/** Validate a raw PUT /coach body into a CoachProfile, or return a reason. */
function validateCoach(input: unknown): { profile: CoachProfile } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "coach_required" };
  const i = input as Record<string, unknown>;
  if (!COACH_TONES.includes(i.tone as (typeof COACH_TONES)[number])) return { error: "tone_invalid" };
  if (!COACH_INTENSITIES.includes(i.intensity as (typeof COACH_INTENSITIES)[number])) return { error: "intensity_invalid" };
  if (typeof i.maxMessageLength !== "number" || !Number.isFinite(i.maxMessageLength) || i.maxMessageLength <= 0) {
    return { error: "maxMessageLength_invalid" };
  }
  if (typeof i.humor !== "boolean") return { error: "humor_invalid" };
  if (!Array.isArray(i.bannedWords) || !i.bannedWords.every((w) => typeof w === "string")) {
    return { error: "bannedWords_invalid" };
  }
  if (
    !Array.isArray(i.quietHours) ||
    !i.quietHours.every(
      (q) =>
        typeof q === "object" && q !== null &&
        typeof (q as { startHour?: unknown }).startHour === "number" &&
        typeof (q as { endHour?: unknown }).endHour === "number",
    )
  ) {
    return { error: "quietHours_invalid" };
  }
  return {
    profile: {
      tone: i.tone as CoachProfile["tone"],
      intensity: i.intensity as CoachProfile["intensity"],
      maxMessageLength: i.maxMessageLength,
      humor: i.humor,
      bannedWords: i.bannedWords as string[],
      quietHours: i.quietHours as CoachProfile["quietHours"],
    },
  };
}

const systemClock: Clock = { nowIso: () => new Date().toISOString() };

const DEFAULT_TIMEZONE = "Europe/Rome";
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Resolve the window position (minute-of-day, day-of-week, local ISO date) of an
 * instant in a given IANA timezone. Uses `Intl.DateTimeFormat` (no heavy tz
 * library, DST handled by the runtime) — §23.2.
 */
function localWindowPosition(iso: string, timeZone: string): {
  minuteOfDay: number;
  dayOfWeek: number;
  date: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const val = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(val("hour")) % 24; // Intl can emit "24" at local midnight
  return {
    minuteOfDay: hour * 60 + Number(val("minute")),
    dayOfWeek: WEEKDAY[val("weekday")] ?? 0,
    date: `${val("year")}-${val("month")}-${val("day")}`,
  };
}

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
    /** Shared durable Db (COD-5) — enables atomic cross-repo writes like the
     * account wipe. Absent in memory mode. */
    private readonly db?: Db,
    /** IANA timezone the /usage window is resolved in (COD-7). Durable mode
     * passes the user's `users.timezone`; defaults to Europe/Rome. */
    private readonly timezone: string = DEFAULT_TIMEZONE,
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
    // atIso is the phone's report time; the window position is derived from it in
    // the user's timezone (§23.2).
    const now = atIso ?? this.clock.nowIso();
    if (Number.isNaN(new Date(now).getTime())) return err(400, "atIso_invalid");
    // Window position is resolved in the user's timezone, not UTC (COD-7).
    const { minuteOfDay, dayOfWeek, date } = localWindowPosition(now, this.timezone);

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

  // §25/§14 — GET /coach : the account's coach profile, or defaults when unset
  async getCoach(): Promise<ApiResult<CoachProfile>> {
    return ok((await this.coach.get()) ?? DEFAULT_COACH);
  }

  // §25/§14 — PUT /coach : validate and persist the coach profile
  async setCoach(input: unknown): Promise<ApiResult<CoachProfile>> {
    const v = validateCoach(input);
    if ("error" in v) return err(400, v.error);
    await this.coach.set(v.profile);
    return ok(v.profile);
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
    const wipe = async () => {
      await this.config.deleteAll();
      await this.memory.deleteAll();
      await this.coach.deleteAll();
    };
    // Durable mode: all three wipes in one transaction so the account deletion is
    // all-or-nothing (COD-5 AC-3). In-memory mode just runs them.
    if (this.db) await this.db.tx(wipe);
    else await wipe();
    return ok({ deleted: true });
  }
}
