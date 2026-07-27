import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Api } from "./api.js";

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

export function createApiServer(api: Api): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { status: "ok" });
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
