import type {
  Habit,
  Rule,
  Commitment,
  MemoryItem,
  InterventionSession,
  Intervention,
  CoachProfile,
} from "@pa/shared-types";
import type { SessionRepo } from "@pa/intervention-service";

/**
 * In-memory data layer (spec §23 services back this). These implement the same
 * shapes as schema.sql so the API + orchestration are testable without Postgres.
 * The production backend swaps these for pg-backed repos with identical methods.
 */

export class MemoryStore {
  habits = new Map<string, Habit>();
  commitments = new Map<string, Commitment>();
  rules = new Map<string, Rule>();
  memory = new Map<string, MemoryItem>();
  coaches = new Map<string, CoachProfile>(); // keyed by userId
  usageDaily = new Map<string, number>(); // `${ruleId}:${date}` → foreground seconds (COD-9)
}

/** SessionRepo (port from @pa/intervention-service) backed by memory. */
export class InMemorySessionRepo implements SessionRepo {
  private sessions = new Map<string, InterventionSession>();
  private interventions: Intervention[] = [];

  private key(ruleId: string, date: string) {
    return `${ruleId}:${date}`;
  }

  async find(ruleId: string, date: string): Promise<InterventionSession | null> {
    return this.sessions.get(this.key(ruleId, date)) ?? null;
  }

  async save(session: InterventionSession): Promise<void> {
    this.sessions.set(this.key(session.ruleId, session.date), session);
  }

  async countInterventionsToday(ruleId: string, date: string): Promise<number> {
    const s = this.sessions.get(this.key(ruleId, date));
    if (!s) return 0;
    return this.interventions.filter((i) => i.sessionId === s.id).length;
  }

  async appendIntervention(intervention: Intervention): Promise<void> {
    this.interventions.push(intervention);
  }

  // Test/read helpers (not part of the port).
  allInterventions(): Intervention[] {
    return [...this.interventions];
  }
}

/**
 * Config persistence port for user config (§8 habits/commitments/rules). The Api
 * writes/reads config through this, so durable mode can swap the in-memory
 * implementation for a pg-backed one (COD-3) without changing handler logic.
 * Memory/coach/sessions stay on `MemoryStore`/`InMemorySessionRepo` for now.
 */
export interface ConfigRepo {
  createHabit(h: Habit): Promise<Habit>;
  getHabit(id: string): Promise<Habit | null>;
  createCommitment(c: Commitment, habitId: string): Promise<Commitment>;
  getCommitment(id: string): Promise<Commitment | null>;
  createRule(r: Rule): Promise<Rule>;
  getRule(id: string): Promise<Rule | null>;
  setRuleEnabled(id: string, enabled: boolean): Promise<Rule | null>;
  /** Wipe all config for the account (habits → commitments/rules/exceptions,
   * and in durable mode the cascaded sessions/interventions). */
  deleteAll(): Promise<void>;
}

/** In-memory ConfigRepo — the default; wraps a `MemoryStore` so behaviour is
 * identical to the pre-COD-3 direct-store access. */
export class MemoryConfigRepo implements ConfigRepo {
  constructor(private readonly store: MemoryStore) {}

  async createHabit(h: Habit): Promise<Habit> {
    this.store.habits.set(h.id, h);
    return h;
  }
  async getHabit(id: string): Promise<Habit | null> {
    return this.store.habits.get(id) ?? null;
  }
  async createCommitment(c: Commitment, _habitId: string): Promise<Commitment> {
    this.store.commitments.set(c.id, c);
    return c;
  }
  async getCommitment(id: string): Promise<Commitment | null> {
    return this.store.commitments.get(id) ?? null;
  }
  async createRule(r: Rule): Promise<Rule> {
    this.store.rules.set(r.id, r);
    return r;
  }
  async getRule(id: string): Promise<Rule | null> {
    return this.store.rules.get(id) ?? null;
  }
  async setRuleEnabled(id: string, enabled: boolean): Promise<Rule | null> {
    const r = this.store.rules.get(id);
    if (!r) return null;
    const updated = { ...r, enabled };
    this.store.rules.set(id, updated);
    return updated;
  }
  async deleteAll(): Promise<void> {
    this.store.habits.clear();
    this.store.commitments.clear();
    this.store.rules.clear();
  }
}

/**
 * Memory persistence port (§18 MemoryItem). Durable in pg mode (COD-4),
 * in-memory by default. `listActive` hides soft-deleted items.
 */
export interface MemoryRepo {
  add(m: MemoryItem): Promise<MemoryItem>;
  listActive(): Promise<MemoryItem[]>;
  /** Soft-delete (status → 'deleted'); returns false when the id is unknown. */
  softDelete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

/** In-memory MemoryRepo — the default; wraps `MemoryStore.memory`. */
export class MemoryMemoryRepo implements MemoryRepo {
  constructor(private readonly store: MemoryStore) {}

  async add(m: MemoryItem): Promise<MemoryItem> {
    this.store.memory.set(m.id, m);
    return m;
  }
  async listActive(): Promise<MemoryItem[]> {
    return [...this.store.memory.values()].filter((m) => m.status !== "deleted");
  }
  async softDelete(id: string): Promise<boolean> {
    const m = this.store.memory.get(id);
    if (!m) return false;
    this.store.memory.set(id, { ...m, status: "deleted" });
    return true;
  }
  async deleteAll(): Promise<void> {
    this.store.memory.clear();
  }
}

/**
 * Coach profile persistence port (§14 CoachProfile). Durable in pg mode (COD-4),
 * in-memory by default. `get` returns the account's profile, or null → caller
 * falls back to defaults.
 */
export interface CoachRepo {
  get(): Promise<CoachProfile | null>;
  set(c: CoachProfile): Promise<void>;
  deleteAll(): Promise<void>;
}

/** In-memory CoachRepo — the default; wraps `MemoryStore.coaches`. */
export class MemoryCoachRepo implements CoachRepo {
  constructor(private readonly store: MemoryStore) {}

  async get(): Promise<CoachProfile | null> {
    return [...this.store.coaches.values()][0] ?? null;
  }
  async set(c: CoachProfile): Promise<void> {
    this.store.coaches.set("local", c);
  }
  async deleteAll(): Promise<void> {
    this.store.coaches.clear();
  }
}

/**
 * Cumulative daily foreground accounting for the daily-budget criterion (COD-9).
 * `addForeground` adds the reported foreground seconds to the (rule, local day)
 * counter and returns the new running total. Durable in pg mode (survives
 * restart), in-memory by default. The date is part of the key, so a new local
 * day starts a fresh counter (AC-3).
 */
export interface UsageRepo {
  addForeground(ruleId: string, date: string, seconds: number): Promise<number>;
  deleteAll(): Promise<void>;
}

/** In-memory UsageRepo — the default; wraps `MemoryStore.usageDaily`. */
export class MemoryUsageRepo implements UsageRepo {
  constructor(private readonly store: MemoryStore) {}

  private key(ruleId: string, date: string) {
    return `${ruleId}:${date}`;
  }
  async addForeground(ruleId: string, date: string, seconds: number): Promise<number> {
    const k = this.key(ruleId, date);
    const total = (this.store.usageDaily.get(k) ?? 0) + seconds;
    this.store.usageDaily.set(k, total);
    return total;
  }
  async deleteAll(): Promise<void> {
    this.store.usageDaily.clear();
  }
}
