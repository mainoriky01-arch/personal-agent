import type { CoachProfile } from "@pa/shared-types";
import type { SafetyResult, SafetyViolation } from "./types.js";

/**
 * Safety Layer (spec §27.5, §7.5). Deterministic content guard applied to EVERY
 * outgoing message regardless of source (human template, AI, or fallback).
 *
 * It cannot catch everything a hostile LLM might produce, but it enforces the
 * spec's hard prohibitions with explicit, testable rules. The design principle:
 * FAIL CLOSED — if a message trips any rule, the caller must fall back to a safe
 * pre-generated template rather than deliver the suspect text.
 */

/** Phrases that imply a clinical/therapeutic diagnosis (§4.2, §27.5). */
const DIAGNOSIS_PATTERNS: RegExp[] = [
  /\bsei\s+(depress|ansios|malat|dipendente|patologic)/i,
  /\bhai\s+(un[a']?\s+)?(depressione|ansia|patologia|disturbo|dipendenza)\b/i,
  /\bsoffri\s+di\b/i,
  /\bdovresti\s+(vedere|consultare)\s+(uno\s+)?(psicolog|terapeut|medico|dottor)/i,
];

/** Threats / invented consequences (§7.5 minacce, conseguenze inventate). */
const THREAT_PATTERNS: RegExp[] = [
  /\bti\s+(punir|castig|bloccher[òo]\s+per\s+sempre)/i,
  /\bse\s+non\s+.*\b(perderai|ti\s+coster[àa]|verrai\s+(bloccat|espuls))/i,
  /\bconseguenze\s+(gravi|permanenti|irreversibili)/i,
  /\baddebiter[òo]|\bti\s+far[òo]\s+pagare\b/i,
];

/** Degrading / insulting language (§7.5 insultare, umiliare). */
const DEGRADING_PATTERNS: RegExp[] = [
  /\bsei\s+(debole|patetic|inutil|un\s+fallit|incapac|pigr|stupid|idiot)/i,
  /\bfallirai\b/i,
  /\bnon\s+ce\s+la\s+farai\s+mai\b/i,
  /\bfai\s+schifo\b/i,
  /\bche\s+vergogna\b/i,
];

/** Pretending to be a real human / faking emotions (§27.5 fake_human, §7.5). */
const FAKE_HUMAN_PATTERNS: RegExp[] = [
  /\bsono\s+(davvero\s+)?(tri?ste|arrabbiat|delus|ferit)\s+(per\s+te|con\s+te)/i,
  /\bmi\s+hai\s+(fatto\s+)?(del\s+male|soffrire)\b/i,
  /\bcome\s+(tuo|un)\s+(amico|fratello|padre|madre)\s+(ti\s+dico|vero)/i,
];

function testAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Check a message against the coach profile and the hard prohibitions.
 * @param text The candidate message.
 * @param coach The user's coach profile (banned words, max length) — §18.
 */
export function checkSafety(text: string, coach: CoachProfile): SafetyResult {
  const violations: SafetyViolation[] = [];
  const normalized = text.normalize("NFC");

  if (testAny(DIAGNOSIS_PATTERNS, normalized))
    violations.push({ kind: "diagnosis", detail: "Linguaggio che implica una diagnosi clinica." });
  if (testAny(THREAT_PATTERNS, normalized))
    violations.push({ kind: "threat", detail: "Minaccia o conseguenza inventata." });
  if (testAny(DEGRADING_PATTERNS, normalized))
    violations.push({ kind: "degrading", detail: "Linguaggio degradante o umiliante." });
  if (testAny(FAKE_HUMAN_PATTERNS, normalized))
    violations.push({ kind: "fake_human", detail: "Finge emozioni umane o un rapporto personale reale." });

  // §18 — user-configured banned words (whole-word, case-insensitive).
  for (const word of coach.bannedWords) {
    const w = word.trim();
    if (!w) continue;
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "i");
    if (re.test(normalized))
      violations.push({ kind: "banned_word", detail: `Parola vietata dall'utente: "${w}".` });
  }

  // §19 — respect the coach's max message length.
  if (coach.maxMessageLength > 0 && normalized.length > coach.maxMessageLength)
    violations.push({ kind: "too_long", detail: `Messaggio oltre il limite (${normalized.length}/${coach.maxMessageLength}).` });

  return { safe: violations.length === 0, violations };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
