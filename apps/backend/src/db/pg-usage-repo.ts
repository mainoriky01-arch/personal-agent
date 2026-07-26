import type { UsageRepo } from "../repos.js";
import type { Db } from "./db.js";
import { DEFAULT_USER_ID } from "./default-user.js";

/**
 * Postgres-backed UsageRepo (COD-9): the cumulative daily foreground counter
 * per (user, rule, local day) behind the daily-budget criterion. Same port as
 * `MemoryUsageRepo`. The `date` column keys the row, so a new local day starts
 * from zero and the total survives restart (durable mode).
 */
export class PgUsageRepo implements UsageRepo {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER_ID,
  ) {}

  async addForeground(ruleId: string, date: string, seconds: number): Promise<number> {
    const { rows } = await this.db.query<{ foreground_seconds: number }>(
      `INSERT INTO usage_daily (user_id, rule_id, date, foreground_seconds)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, rule_id, date) DO UPDATE SET
         foreground_seconds = usage_daily.foreground_seconds + EXCLUDED.foreground_seconds
       RETURNING foreground_seconds`,
      [this.userId, ruleId, date, seconds],
    );
    return rows[0]!.foreground_seconds;
  }

  async deleteAll(): Promise<void> {
    await this.db.query(`DELETE FROM usage_daily WHERE user_id = $1`, [this.userId]);
  }
}
