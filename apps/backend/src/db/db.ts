import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Database boot (spec §22.3). Uses PGlite — real Postgres compiled to WASM,
 * running in-process. The SAME schema.sql and SAME SQL statements run for tests
 * (ephemeral in-memory) and for durable dev/prod (file-backed); only the
 * PGlite data location differs.
 *
 * For a multi-instance production deployment, swap PGlite for a `pg.Pool` — the
 * `Db` interface below is intentionally the minimal shape both support
 * (`query(sql, params)`).
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

/**
 * Wrap a PGlite instance in the minimal `Db` shape and apply the schema.
 * Bootstrap is idempotent: schema.sql is entirely `CREATE ... IF NOT EXISTS`,
 * so re-running it against an existing database is a no-op.
 */
async function bootstrap(pg: PGlite): Promise<Db & { close: () => Promise<void> }> {
  await pg.exec(loadSchemaSql());
  return {
    query: (sql, params) => pg.query(sql, params) as Promise<{ rows: any[] }>,
    close: () => pg.close(),
  };
}

/** Create an ephemeral in-process Postgres (PGlite) with the schema applied. */
export async function createTestDb(): Promise<Db & { close: () => Promise<void> }> {
  return bootstrap(new PGlite());
}

/**
 * Create a durable, file-backed Postgres (PGlite) with the schema applied.
 * Data written at `path` survives process restarts; reopening the same `path`
 * restores it. This is the production/dev storage until a `pg.Pool` swap.
 */
export async function createDb(path: string): Promise<Db & { close: () => Promise<void> }> {
  return bootstrap(new PGlite(path));
}
