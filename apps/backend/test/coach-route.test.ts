import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoachProfile } from "@pa/shared-types";
import type { Intent } from "@pa/rule-drafting";
import { MemoryStore } from "../src/repos.js";
import { AiOrchestrationService, type IntentExtractor } from "../src/orchestration.js";
import { Api } from "../src/api.js";
import { createDb } from "../src/db/db.js";
import { ensureDefaultUser } from "../src/db/default-user.js";
import { PgCoachRepo } from "../src/db/pg-coach-repo.js";

/** GET/PUT /coach handlers (COD-6). */

class FakeExtractor implements IntentExtractor {
  async extract(): Promise<Intent> {
    return {};
  }
}

const ai = () => new AiOrchestrationService(new FakeExtractor());
const memApi = () => new Api(new MemoryStore(), ai());

const validCoach: CoachProfile = {
  tone: "severe",
  intensity: "extreme",
  maxMessageLength: 120,
  humor: true,
  bannedWords: ["stupido"],
  quietHours: [{ startHour: 22, endHour: 7 }],
};

const DB_TIMEOUT = 30_000;
const settle = () => new Promise((r) => setTimeout(r, 100));
const dirs: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "pa-coach-"));
  dirs.push(d);
  return join(d, "pglite");
}
afterAll(async () => {
  await settle();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("Coach profile route (COD-6)", () => {
  it("GET /coach returns defaults when unset (AC-1)", async () => {
    const r = await memApi().getCoach();
    expect(r.status).toBe(200);
    expect(r.data!.intensity).toBe("firm"); // DEFAULT_COACH
  });

  it("PUT then GET round-trips a valid profile (AC-2)", async () => {
    const a = memApi();
    const put = await a.setCoach(validCoach);
    expect(put.status).toBe(200);
    expect(put.data!.tone).toBe("severe");
    const got = await a.getCoach();
    expect(got.data!.tone).toBe("severe");
    expect(got.data!.quietHours).toEqual([{ startHour: 22, endHour: 7 }]);
  });

  it("PUT rejects invalid bodies with 400 (AC-2)", async () => {
    const a = memApi();
    expect((await a.setCoach(null)).status).toBe(400);
    expect((await a.setCoach({ ...validCoach, intensity: "nope" })).status).toBe(400);
    expect((await a.setCoach({ ...validCoach, maxMessageLength: 0 })).status).toBe(400);
    expect((await a.setCoach({ ...validCoach, tone: "weird" })).status).toBe(400);
    expect((await a.setCoach({ ...validCoach, humor: "yes" })).status).toBe(400);
  });

  it(
    "persists via CoachRepo across reopen in durable mode (AC-3)",
    async () => {
      const path = tmpPath();
      const db1 = await createDb(path);
      await ensureDefaultUser(db1);
      const a1 = new Api(new MemoryStore(), ai(), undefined, undefined, undefined, undefined, new PgCoachRepo(db1));
      await a1.setCoach(validCoach);
      await db1.close();
      await settle();

      const db2 = await createDb(path);
      const a2 = new Api(new MemoryStore(), ai(), undefined, undefined, undefined, undefined, new PgCoachRepo(db2));
      const got = await a2.getCoach();
      await db2.close();

      expect(got.data!.tone).toBe("severe");
      expect(got.data!.maxMessageLength).toBe(120);
    },
    DB_TIMEOUT,
  );
});
