import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser, DEFAULT_USER_ID } from "../src/db/default-user.js";

/**
 * Durable DB foundation (COD-2): createDb persists across reopen (proving both
 * durability and idempotent schema bootstrap) and the default user seed is
 * idempotent. File-backed PGlite is slow to boot, so these tests carry an
 * explicit generous timeout.
 */

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));

const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-db-"));
  dirs.push(d);
  return join(d, "pglite");
}

// Clean up once, after PGlite has fully released its handles, so teardown never
// races the WASM filesystem flush.
afterAll(async () => {
  await settle();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort: temp dirs live under os.tmpdir(), harmless if left behind
    }
  }
});

describe("durable DB foundation (COD-2)", () => {
  it(
    "persists a row across reopen; schema bootstrap is idempotent (AC-1, AC-5)",
    async () => {
      const path = tmpPath();

      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      await db1.close();
      await settle();

      // Reopen the SAME path: schema re-applies without error (idempotent),
      // and the previously written row is still there (durable).
      const db2 = await createDb(path);
      const { rows } = await db2.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1",
        [DEFAULT_USER_ID],
      );
      await db2.close();

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(DEFAULT_USER_ID);
    },
    DB_TIMEOUT,
  );

  it(
    "default user seed is idempotent — one row, stable id (AC-3)",
    async () => {
      const db = await createDb(tmpPath());
      const id1 = await ensureDefaultUser(db);
      const id2 = await ensureDefaultUser(db);
      const { rows } = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM users",
      );
      await db.close();

      expect(id1).toBe(DEFAULT_USER_ID);
      expect(id2).toBe(DEFAULT_USER_ID);
      expect(Number(rows[0].n)).toBe(1);
    },
    DB_TIMEOUT,
  );
});
