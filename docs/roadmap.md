# Roadmap

This file is the **only** source the Finn-loop orchestrator uses to generate new
work autonomously (`finn-spec-auto`). You own it. The loop never invents scope —
it only expands what you write here into build-ready Linear issues, one at a
time, and only when the queue is empty.

## Authoritative contract

Every item **must** follow the **Automated Spec & Roadmap Contract in
[`CLAUDE.md`](../CLAUDE.md) §3** — the three core principles (§3.1), the item
schema (§3.2), the anti-patterns (§3.3), and the worked example (§3.4). That is
the single source of truth for the format; this file only holds the live queue.

## How the loop consumes it

- Each pending item becomes **one** build-ready issue (one PR-sized unit,
  < 400 lines of diff).
- The orchestrator picks the **first unchecked** item that has no Linear issue
  yet and whose `After:` prerequisite is already merged (`Done`), expands it into
  a full spec per the CLAUDE.md §3.2 schema, and files it on team `COD` as
  `agent-ready` with a `Roadmap: <slug>` marker.
- If an item is too vague to spec **without guessing**, the loop skips it and
  tells you exactly what is missing — it never invents scope.
- Tick `- [x]` yourself for your own tracking; the loop also skips any item whose
  `slug` already has a Linear issue, so it never duplicates.

## Pending items

<!--
Add real items below using the CLAUDE.md §3.2 schema. Until you add one, the
orchestrator has nothing to generate and simply skips its spec-generation step.
See CLAUDE.md §3.4 for a fully-worked example at the right level of detail.
-->

_(none yet — add items above, in the CLAUDE.md §3.2 format, to feed the loop)_
