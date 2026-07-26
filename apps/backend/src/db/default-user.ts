import type { Db } from "./db.js";

/**
 * Pre-auth default user (COD-2). The production schema is user-scoped
 * (`habits.user_id` etc. are NOT NULL with FKs to `users`), but the app has no
 * authentication yet. Until real Sign in with Apple lands, a single local user
 * with a stable id anchors all persisted rows. This is a bridge, not a login.
 */

export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_USER_EMAIL = "local@personal-agent.local";

/**
 * Idempotently ensure the default local user exists; returns its stable id.
 * Safe to call on every boot: `ON CONFLICT (id) DO NOTHING` never duplicates.
 */
export async function ensureDefaultUser(db: Db): Promise<string> {
  await db.query(
    `INSERT INTO users (id, email, language, timezone, status, plan)
     VALUES ($1, $2, 'it', 'Europe/Rome', 'active', 'free')
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_USER_ID, DEFAULT_USER_EMAIL],
  );
  return DEFAULT_USER_ID;
}
