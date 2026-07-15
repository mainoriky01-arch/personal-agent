import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Database boot (spec §22.3). Uses PGlite — real Postgres compiled to WASM,
 * running in-process. The SAME schema.sql and SAME SQL statements run here and
 * against a production Postgres server; only the connection differs. This makes
 * the repositories genuinely integration-tested, not mocked.
 *
 * For production, swap `new PGlite()` for a `pg.Pool` — the Db interface below
 * is intentionally the minimal shape both support (`query(sql, params)`).
 */

export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the canonical schema.sql shipped with the backend. */
export function loadSchemaSql(): string {
  return readFileSync(join(__dirname, "schema.sql"), "utf8");
}

/** Create an in-process Postgres (PGlite) with the schema applied. */
export async function createTestDb(): Promise<Db & { close: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(loadSchemaSql());
  return {
    query: (sql, params) => pg.query(sql, params) as Promise<{ rows: any[] }>,
    close: () => pg.close(),
  };
}
