import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Api } from "./api.js";

/** Transport options (COD-16, COD-18). */
export interface ServerOptions {
  /** Shared bearer token. When set, every route except `GET /health` requires
   * `Authorization: Bearer <token>`; absent/empty → open (dev/test default). */
  authToken?: string;
  /** When true, emit one structured log line per request (method/path/status/
   * durationMs) to stdout. Absent/false → silent (the dev/test default). */
  log?: boolean;
}

/**
 * Constant-time bearer check (COD-16). Returns true only when `header` is exactly
 * `Bearer <expected>`. A missing header, wrong scheme, or length mismatch is
 * rejected without throwing (`timingSafeEqual` requires equal-length buffers, so
 * the length guard runs first).
 */
function bearerMatches(expected: string, header: string | undefined): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/**
 * HTTP server (spec §25 API, §22.2 backend). Node stdlib only — no framework —
 * to honour the "no unnecessary dependencies" principle. In production this
 * would be NestJS/Express, but the route handlers already live in `Api` as pure
 * functions, so the transport is a thin shell.
 *
 * Routes are a minimal slice of §25 to prove the wiring end-to-end:
 *   GET  /health
 *   POST /chat/draft          { text }
 *   POST /habits              { title, type, ... }
 *   POST /rules/confirm       { habitId, proposal }
 *   POST /usage               { ruleId, appId, foregroundSeconds, atIso? }
 *   GET  /memory
 *   POST /memory              { content, category, ... }
 *   DELETE /memory/:id
 */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

export function createApiServer(api: Api, options: ServerOptions = {}): Server {
  const authToken = options.authToken?.trim() || undefined;
  const log = options.log === true;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Per-request structured log (COD-18): one line on response completion with
      // method/path/status/durationMs only — never body or headers (NG-2). Opt-in
      // via options.log, so the dev/test default stays silent.
      if (log) {
        const start = Date.now();
        res.on("finish", () => {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({ method, path, status: res.statusCode, durationMs: Date.now() - start }),
          );
        });
      }

      const isHealth = method === "GET" && path === "/health";

      // Auth gate (COD-16): when a token is configured, every route except the
      // health check requires a matching bearer token. Unset token → open, so
      // the dev/test default and the current client are unaffected. The check
      // sits in the transport; the `Api` handlers stay pure (§25).
      if (authToken && !isHealth && !bearerMatches(authToken, req.headers.authorization)) {
        return send(res, 401, { ok: false, error: "unauthorized" });
      }

      if (isHealth) {
        // Readiness (COD-18): report storage mode and, in durable mode, that the
        // DB answers a trivial query. Stays auth-exempt (COD-16).
        const h = await api.health();
        return send(res, h.httpStatus, h.body);
      }

      if (method === "POST" && path === "/chat/draft") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.draftRule(body.text ?? "");
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/habits") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.createHabit(body);
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/rules/confirm") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.confirmRule(body.habitId, body.proposal);
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/usage/ack") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.ackUsage(body);
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/usage") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.ingestUsage(body);
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/seatbelt/trigger") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = api.triggerSeatbelt(body);
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/seatbelt/resolved") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = api.resolveSeatbelt(body);
        return send(res, r.status, r);
      }

      if (method === "GET" && path === "/memory") {
        const r = await api.listMemory(url.searchParams.get("userId") ?? "");
        return send(res, r.status, r);
      }

      if (method === "POST" && path === "/memory") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.addMemory(body);
        return send(res, r.status, r);
      }

      if (method === "DELETE" && path.startsWith("/memory/")) {
        const id = path.slice("/memory/".length);
        const r = await api.deleteMemory(id);
        return send(res, r.status, r);
      }

      if (method === "PATCH" && path.startsWith("/rules/") && path.endsWith("/suspend")) {
        const id = path.slice("/rules/".length, -"/suspend".length);
        const r = await api.suspendRule(id);
        return send(res, r.status, r);
      }

      if (method === "GET" && path === "/coach") {
        const r = await api.getCoach();
        return send(res, r.status, r);
      }

      if (method === "PUT" && path === "/coach") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await api.setCoach(body);
        return send(res, r.status, r);
      }

      return send(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      return send(res, 500, { ok: false, error: (e as Error).message });
    }
  });
}
