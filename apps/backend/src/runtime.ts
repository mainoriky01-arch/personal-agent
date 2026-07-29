import type { Server } from "node:http";

/**
 * Build an idempotent graceful shutdown for a running API server (COD-17).
 *
 * Calling the returned function stops the HTTP server — dropping idle keep-alive
 * sockets so `close` isn't held open by them while in-flight requests finish —
 * and then, in durable mode, closes the `Db`. It is safe to call more than once:
 * the first call's promise is cached and returned on every later call, so a
 * SIGTERM racing a SIGINT can never double-close.
 *
 * Extracted here (not inline in `main.ts`) so it can be exercised by tests
 * without importing the entrypoint, which would boot a real server on import.
 */
export function createShutdown(
  server: Server,
  closeDb?: () => Promise<void>,
): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => {
    if (started) return started;
    started = (async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Drop idle keep-alive connections so `server.close` can complete.
        server.closeIdleConnections?.();
      });
      if (closeDb) await closeDb();
    })();
    return started;
  };
}
