import type { CoachProfile, IntensityMode } from "@pa/shared-types";
import type { CoachRepo } from "../repos.js";
import type { Db } from "./db.js";
import { DEFAULT_USER_ID } from "./default-user.js";

/**
 * Postgres-backed CoachRepo (COD-4): persists the coach profile (§14) for the
 * pre-auth default user (COD-2). Same port as `MemoryCoachRepo`.
 */

interface CoachRow {
  tone: string;
  intensity: string;
  max_message_len: number;
  humor: boolean;
  banned_words: string[];
  quiet_hours: Array<{ startHour: number; endHour: number }>;
}

export class PgCoachRepo implements CoachRepo {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER_ID,
  ) {}

  async get(): Promise<CoachProfile | null> {
    const { rows } = await this.db.query<CoachRow>(
      `SELECT tone, intensity, max_message_len, humor, banned_words, quiet_hours
       FROM coach_profiles WHERE user_id = $1`,
      [this.userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      tone: r.tone as CoachProfile["tone"],
      intensity: r.intensity as IntensityMode,
      maxMessageLength: r.max_message_len,
      humor: r.humor,
      bannedWords: r.banned_words,
      quietHours: r.quiet_hours,
    };
  }

  async set(c: CoachProfile): Promise<void> {
    await this.db.query(
      `INSERT INTO coach_profiles
         (user_id, tone, intensity, max_message_len, humor, banned_words, quiet_hours)
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         tone = EXCLUDED.tone,
         intensity = EXCLUDED.intensity,
         max_message_len = EXCLUDED.max_message_len,
         humor = EXCLUDED.humor,
         banned_words = EXCLUDED.banned_words,
         quiet_hours = EXCLUDED.quiet_hours`,
      [this.userId, c.tone, c.intensity, c.maxMessageLength, c.humor, c.bannedWords, JSON.stringify(c.quietHours)],
    );
  }

  async deleteAll(): Promise<void> {
    await this.db.query(`DELETE FROM coach_profiles WHERE user_id = $1`, [this.userId]);
  }
}
