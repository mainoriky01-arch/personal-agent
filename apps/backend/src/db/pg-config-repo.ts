import {
  type Habit,
  type HabitType,
  type Commitment,
  type Rule,
  type RuleException,
  type IntensityMode,
  type InterventionLevel,
} from "@pa/shared-types";
import type { ConfigRepo } from "../repos.js";
import type { Db } from "./db.js";
import { DEFAULT_USER_ID } from "./default-user.js";

/**
 * Postgres-backed ConfigRepo (COD-3). Persists habits, commitments, rules and
 * rule_exceptions with real SQL against schema.sql, scoped to the pre-auth
 * default user (COD-2). Same port as `MemoryConfigRepo`, so the Api handlers are
 * unchanged apart from being awaited. Exercised via PGlite in tests, a `pg.Pool`
 * in production.
 */

interface HabitRow {
  id: string;
  title: string;
  type: string;
  description: string | null;
  motivation: string | null;
  status: string;
  substitute_behavior: string | null;
}

interface CommitmentRow {
  id: string;
  natural_text: string;
  days: number[];
  start_minute: number;
  end_minute: number;
  duration_minutes: number;
  version: number;
  confirmed_by_user: boolean;
}

interface RuleRow {
  id: string;
  habit_id: string;
  commitment_id: string;
  intensity: string;
  interfering_apps: string[];
  threshold_minutes: number;
  cooldown_seconds: number;
  escalation: number[];
  max_interventions_session: number;
  max_interventions_day: number;
  enabled: boolean;
}

interface ExceptionRow {
  id: string;
  date: string | null;
  reason: string;
}

export class PgConfigRepo implements ConfigRepo {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER_ID,
  ) {}

  async createHabit(h: Habit): Promise<Habit> {
    await this.db.query(
      `INSERT INTO habits
         (id, user_id, title, type, description, motivation, status, substitute_behavior)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [h.id, this.userId, h.title, h.type, h.description ?? null, h.motivation ?? null, h.status, h.substituteBehavior ?? null],
    );
    return h;
  }

  async getHabit(id: string): Promise<Habit | null> {
    const { rows } = await this.db.query<HabitRow>(
      `SELECT id, title, type, description, motivation, status, substitute_behavior
       FROM habits WHERE id = $1 AND user_id = $2`,
      [id, this.userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      type: r.type as HabitType,
      description: r.description ?? undefined,
      motivation: r.motivation ?? undefined,
      status: r.status as Habit["status"],
      substituteBehavior: r.substitute_behavior ?? undefined,
    };
  }

  async createCommitment(c: Commitment, habitId: string): Promise<Commitment> {
    await this.db.query(
      `INSERT INTO commitments
         (id, habit_id, natural_text, days, start_minute, end_minute, duration_minutes, version, confirmed_by_user)
       VALUES ($1,$2,$3,$4::int[],$5,$6,$7,$8,$9)`,
      [c.id, habitId, c.naturalText, c.days, c.startMinuteOfDay, c.endMinuteOfDay, c.durationMinutes, c.version, c.confirmedByUser],
    );
    return c;
  }

  async getCommitment(id: string): Promise<Commitment | null> {
    const { rows } = await this.db.query<CommitmentRow>(
      `SELECT id, natural_text, days, start_minute, end_minute, duration_minutes, version, confirmed_by_user
       FROM commitments WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      naturalText: r.natural_text,
      days: r.days.map(Number),
      startMinuteOfDay: r.start_minute,
      endMinuteOfDay: r.end_minute,
      durationMinutes: r.duration_minutes,
      version: r.version,
      confirmedByUser: r.confirmed_by_user,
    };
  }

  async createRule(r: Rule): Promise<Rule> {
    await this.db.query(
      `INSERT INTO rules
         (id, habit_id, commitment_id, intensity, interfering_apps, threshold_minutes,
          cooldown_seconds, escalation, max_interventions_session, max_interventions_day, enabled)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8::int[],$9,$10,$11)`,
      [
        r.id, r.habitId, r.commitmentId, r.intensity, r.interferingApps, r.thresholdMinutes,
        r.cooldownSeconds, r.escalation, r.maxInterventionsPerSession, r.maxInterventionsPerDay, r.enabled,
      ],
    );
    for (const e of r.exceptions) {
      await this.db.query(
        `INSERT INTO rule_exceptions (id, rule_id, date, reason) VALUES ($1,$2,$3,$4)`,
        [e.id, r.id, e.date ?? null, e.reason],
      );
    }
    return r;
  }

  async getRule(id: string): Promise<Rule | null> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT id, habit_id, commitment_id, intensity, interfering_apps, threshold_minutes,
              cooldown_seconds, escalation, max_interventions_session, max_interventions_day, enabled
       FROM rules WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    const { rows: exRows } = await this.db.query<ExceptionRow>(
      `SELECT id, date::text, reason FROM rule_exceptions WHERE rule_id = $1`,
      [id],
    );
    const exceptions: RuleException[] = exRows.map((e) => ({
      id: e.id,
      date: e.date ?? undefined,
      reason: e.reason,
    }));
    return {
      id: r.id,
      habitId: r.habit_id,
      commitmentId: r.commitment_id,
      intensity: r.intensity as IntensityMode,
      interferingApps: r.interfering_apps,
      thresholdMinutes: r.threshold_minutes,
      cooldownSeconds: r.cooldown_seconds,
      escalation: r.escalation.map(Number) as InterventionLevel[],
      exceptions,
      maxInterventionsPerSession: r.max_interventions_session,
      maxInterventionsPerDay: r.max_interventions_day,
      enabled: r.enabled,
    };
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<Rule | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE rules SET enabled = $2 WHERE id = $1 RETURNING id`,
      [id, enabled],
    );
    if (!rows[0]) return null;
    return this.getRule(id);
  }

  async deleteAll(): Promise<void> {
    // Deleting the user's habits cascades (schema FKs ON DELETE CASCADE) to
    // commitments, rules, rule_exceptions, intervention_sessions and interventions.
    await this.db.query(`DELETE FROM habits WHERE user_id = $1`, [this.userId]);
  }
}
