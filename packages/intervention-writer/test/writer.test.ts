import { describe, it, expect } from "vitest";
import { InterventionLevel, type CoachProfile } from "@pa/shared-types";
import { checkSafety } from "../src/safety.js";
import { composeMessage } from "../src/builder.js";
import { fallbackMessage, interpolate } from "../src/fallback.js";
import type { MessageContext } from "../src/types.js";

const coach: CoachProfile = {
  tone: "direct",
  intensity: "firm",
  maxMessageLength: 300,
  humor: false,
  bannedWords: ["stupido"],
  quietHours: [],
};

const ctx: MessageContext = {
  goal: "leggere",
  motivation: "non arrivare a fine anno senza aver letto nulla",
  detectedApp: "Instagram",
  windowLabel: "21:00-21:30",
  minutesElapsed: 12,
  level: InterventionLevel.DirectIntervention,
  action: "direct_message",
  channel: "push",
  coach,
};

// ── Safety Layer (§27.5) — the prohibitions that MUST be blocked ─────────────

describe("checkSafety — hard prohibitions (§27.5, §7.5)", () => {
  it("blocks the spec's forbidden example 'Sei debole e fallirai anche oggi'", () => {
    const r = checkSafety("Sei debole e fallirai anche oggi.", coach);
    expect(r.safe).toBe(false);
    expect(r.violations.some((v) => v.kind === "degrading")).toBe(true);
  });

  it("blocks a clinical diagnosis", () => {
    expect(checkSafety("Sei depresso, dovresti vedere uno psicologo.", coach).safe).toBe(false);
  });

  it("blocks threats / invented consequences", () => {
    expect(checkSafety("Se non inizi ora ti bloccherò per sempre.", coach).safe).toBe(false);
    expect(checkSafety("Ci saranno conseguenze gravi.", coach).safe).toBe(false);
  });

  it("blocks fake human emotions", () => {
    expect(checkSafety("Sono davvero triste per te, mi hai fatto soffrire.", coach).safe).toBe(false);
  });

  it("blocks user-configured banned words (§18)", () => {
    const r = checkSafety("Non essere stupido, inizia.", coach);
    expect(r.safe).toBe(false);
    expect(r.violations.some((v) => v.kind === "banned_word")).toBe(true);
  });

  it("flags over-length messages (§19)", () => {
    const long = "a".repeat(400);
    expect(checkSafety(long, coach).violations.some((v) => v.kind === "too_long")).toBe(true);
  });

  it("ALLOWS the spec's acceptable-but-firm example", () => {
    const ok =
      "Non hai bisogno di altri cinque minuti. Esci adesso e inizia a leggere.";
    expect(checkSafety(ok, coach).safe).toBe(true);
  });

  it("allows a normal contextual nudge", () => {
    expect(checkSafety("Avevi scelto questo momento per leggere. Inizia ora?", coach).safe).toBe(true);
  });
});

// ── Builder — fail-closed behaviour (§19.1) ──────────────────────────────────

describe("composeMessage — AI copy path", () => {
  it("uses AI copy when it is safe", () => {
    const out = composeMessage(ctx, "Hai aperto Instagram durante il tuo tempo per leggere. Chiudi e inizia.");
    expect(out.source).toBe("ai");
    expect(out.wasSanitized).toBe(false);
  });

  it("REJECTS unsafe AI copy and falls back (fail closed)", () => {
    const out = composeMessage(ctx, "Sei un fallito e fallirai anche stasera.");
    expect(out.source).not.toBe("ai");
    expect(out.wasSanitized).toBe(true);
    // The delivered text must itself be safe.
    expect(checkSafety(out.text, coach).safe).toBe(true);
  });
});

describe("composeMessage — template + fallback", () => {
  it("uses a tone template when no AI copy is given", () => {
    const out = composeMessage(ctx);
    expect(["template", "fallback"]).toContain(out.source);
    expect(out.text.length).toBeGreaterThan(0);
    expect(checkSafety(out.text, coach).safe).toBe(true);
  });

  it("every escalation level yields a safe, non-empty message", () => {
    for (const level of [
      InterventionLevel.GentleReminder,
      InterventionLevel.ContextualNudge,
      InterventionLevel.DirectIntervention,
      InterventionLevel.Friction,
      InterventionLevel.Restriction,
    ]) {
      const out = composeMessage({ ...ctx, level });
      expect(out.text.length).toBeGreaterThan(0);
      expect(checkSafety(out.text, coach).safe).toBe(true);
    }
  });

  it("delivered message never exceeds coach maxMessageLength", () => {
    const shortCoach: CoachProfile = { ...coach, maxMessageLength: 40 };
    const out = composeMessage({ ...ctx, coach: shortCoach });
    expect(out.text.length).toBeLessThanOrEqual(40);
  });
});

// ── Fallback (§19.1) ─────────────────────────────────────────────────────────

describe("fallback + interpolate", () => {
  it("interpolate fills placeholders and drops unknowns", () => {
    expect(interpolate("ciao {name}, {missing}", { name: "Rico" })).toBe("ciao Rico, ");
  });

  it("fallback includes goal and app", () => {
    const fb = fallbackMessage(ctx);
    expect(fb).toContain("leggere");
    expect(fb).toContain("Instagram");
  });

  it("ObserveOnly level produces an empty fallback (no message)", () => {
    expect(fallbackMessage({ ...ctx, level: InterventionLevel.ObserveOnly })).toBe("");
  });
});
