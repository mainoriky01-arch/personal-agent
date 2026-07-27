import {
  InterventionLevel,
  type InterventionSession,
  type Intervention,
  type SessionState,
  type OutcomeType,
  type InterventionAction,
  type Channel,
} from "@pa/shared-types";
import type { SessionRepo } from "@pa/intervention-service";
import type { Db } from "./db.js";

/**
 * Postgres-backed SessionRepo (spec §23.5 persistence). Real SQL against the
 * schema in schema.sql, exercised via PGlite in tests and a pg.Pool in prod.
 * Same port as the in-memory version, so the InterventionService is unchanged.
 */

interface SessionRow {
  id: string;
  rule_id: string;
  date: string;
  state: string;
  level: number;
  interventions_sent: number;
  last_intervention_at: string | null;
  outcome: string | null;
  acknowledged: boolean;
  last_foreground_seconds: number | null;
}

function rowToSession(r: SessionRow): InterventionSession {
  return {
    id: r.id,
    ruleId: r.rule_id,
    date: typeof r.date === "string" ? r.date.slice(0, 10) : r.date,
    state: r.state as SessionState,
    level: r.level as InterventionLevel,
    interventionsSent: r.interventions_sent,
    lastInterventionAt: r.last_intervention_at ?? undefined,
    outcome: (r.outcome ?? undefined) as OutcomeType | undefined,
    acknowledged: r.acknowledged,
    lastForegroundSeconds: r.last_foreground_seconds ?? undefined,
  };
}

export class PgSessionRepo implements SessionRepo {
  constructor(private readonly db: Db) {}

  async find(ruleId: string, date: string): Promise<InterventionSession | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT id, rule_id, date::text, state, level, interventions_sent,
              last_intervention_at::text, outcome, acknowledged, last_foreground_seconds
       FROM intervention_sessions WHERE rule_id = $1 AND date = $2`,
      [ruleId, date],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async save(session: InterventionSession): Promise<void> {
    // Idempotent upsert keyed on (rule_id, date) — §8.9 one live session/day.
    await this.db.query(
      `INSERT INTO intervention_sessions
         (id, rule_id, date, state, level, interventions_sent, last_intervention_at, outcome,
          acknowledged, last_foreground_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (rule_id, date) DO UPDATE SET
         state = EXCLUDED.state,
         level = EXCLUDED.level,
         interventions_sent = EXCLUDED.interventions_sent,
         last_intervention_at = EXCLUDED.last_intervention_at,
         outcome = EXCLUDED.outcome,
         acknowledged = EXCLUDED.acknowledged,
         last_foreground_seconds = EXCLUDED.last_foreground_seconds`,
      [
        session.id,
        session.ruleId,
        session.date,
        session.state,
        session.level,
        session.interventionsSent,
        session.lastInterventionAt ?? null,
        session.outcome ?? null,
        session.acknowledged ?? false,
        session.lastForegroundSeconds ?? null,
      ],
    );
  }

  async countInterventionsToday(ruleId: string, date: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM interventions i
       JOIN intervention_sessions s ON s.id = i.session_id
       WHERE s.rule_id = $1 AND s.date = $2`,
      [ruleId, date],
    );
    return rows[0] ? Number(rows[0].n) : 0;
  }

  async appendIntervention(i: Intervention): Promise<void> {
    await this.db.query(
      `INSERT INTO interventions
         (id, session_id, action, channel, message, sent_at, level)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [i.id, i.sessionId, i.action, i.channel, i.message, i.sentAt, i.level],
    );
  }
}
