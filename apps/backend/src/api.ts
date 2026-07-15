import {
  type Habit,
  type Rule,
  type Commitment,
  type MemoryItem,
} from "@pa/shared-types";
import type { RuleProposal } from "@pa/rule-drafting";
import type { MemoryStore } from "./repos.js";
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

const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const err = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

let seq = 0;
const genId = (p: string) => `${p}_${++seq}`;

export class Api {
  constructor(
    private readonly store: MemoryStore,
    private readonly ai: AiOrchestrationService,
  ) {}

  // §25 — POST /chat/draft : chat text → confirmable rule draft (never activates)
  async draftRule(text: string) {
    if (!text?.trim()) return err(400, "empty_text");
    const draft = await this.ai.draftFromChat(text);
    return ok(draft);
  }

  // §25 — POST /habits : create a habit
  createHabit(input: Omit<Habit, "id" | "status"> & { status?: Habit["status"] }): ApiResult<Habit> {
    if (!input.title?.trim()) return err(400, "title_required");
    const habit: Habit = { id: genId("habit"), status: input.status ?? "active", ...input };
    this.store.habits.set(habit.id, habit);
    return ok(habit, 201);
  }

  // §25 — POST /rules/confirm : turn a confirmed proposal into an active rule (§42.3)
  confirmRule(habitId: string, proposal: RuleProposal): ApiResult<Rule> {
    const habit = this.store.habits.get(habitId);
    if (!habit) return err(404, "habit_not_found");

    const commitment: Commitment = {
      id: genId("commit"),
      naturalText: proposal.goal,
      days: proposal.days,
      startMinuteOfDay: proposal.startMinuteOfDay,
      endMinuteOfDay: proposal.endMinuteOfDay,
      durationMinutes: proposal.durationMinutes,
      version: 1,
      confirmedByUser: true, // this endpoint IS the user confirmation
    };
    this.store.commitments.set(commitment.id, commitment);

    const rule: Rule = {
      id: genId("rule"),
      habitId,
      commitmentId: commitment.id,
      intensity: proposal.intensity,
      interferingApps: proposal.interferingApps,
      thresholdMinutes: proposal.thresholdMinutes,
      cooldownSeconds: proposal.cooldownSeconds,
      escalation: proposal.escalation,
      exceptions: proposal.exceptions,
      maxInterventionsPerSession: proposal.maxInterventionsPerSession,
      maxInterventionsPerDay: proposal.maxInterventionsPerDay,
      enabled: true,
    };
    this.store.rules.set(rule.id, rule);
    return ok(rule, 201);
  }

  // §25 — PATCH /rules/:id/suspend
  suspendRule(ruleId: string): ApiResult<Rule> {
    const rule = this.store.rules.get(ruleId);
    if (!rule) return err(404, "rule_not_found");
    const updated = { ...rule, enabled: false };
    this.store.rules.set(ruleId, updated);
    return ok(updated);
  }

  // §25 — GET /memory
  listMemory(userId: string): ApiResult<MemoryItem[]> {
    const items = [...this.store.memory.values()].filter(
      (m) => m.status !== "deleted",
    );
    return ok(items);
  }

  // §25 — POST /memory
  addMemory(item: Omit<MemoryItem, "id" | "status"> & { status?: MemoryItem["status"] }): ApiResult<MemoryItem> {
    if (!item.content?.trim()) return err(400, "content_required");
    const mem: MemoryItem = { id: genId("mem"), status: item.status ?? "active", ...item };
    this.store.memory.set(mem.id, mem);
    return ok(mem, 201);
  }

  // §25 — DELETE /memory/:id  (user control §18.4)
  deleteMemory(id: string): ApiResult<{ id: string }> {
    const mem = this.store.memory.get(id);
    if (!mem) return err(404, "memory_not_found");
    this.store.memory.set(id, { ...mem, status: "deleted" });
    return ok({ id });
  }

  // §25 — DELETE /account  (§26.1 cancellazione account + dati)
  deleteAccount(userId: string): ApiResult<{ deleted: boolean }> {
    this.store.habits.clear();
    this.store.commitments.clear();
    this.store.rules.clear();
    this.store.memory.clear();
    this.store.coaches.delete(userId);
    return ok({ deleted: true });
  }
}
