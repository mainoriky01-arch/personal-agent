---
name: finn-spec-auto
description: Non-interactive Finn-loop spec. Turn the next item on the human-authored roadmap into one build-ready Linear issue, without an interview. Use only inside the finn-orchestrator loop; when a human is present with a fresh idea, use finn-spec instead. One pass = one issue; never invents product scope.
---

# Finn-loop autonomous spec

One pass = one roadmap item turned into one build-ready issue. This is the
unattended counterpart of `finn-spec`: it never invents product intent, it only
expands an item a human already wrote on the roadmap. If an item is too vague to
spec without guessing, it flags it and stops — it does not make product
decisions. A wrong spec is worse than no spec: build and review would both go on
to certify the wrong thing.

## 1. Read the roadmap

The roadmap is `docs/roadmap.md` (human-authored). Each top-level checkbox item
is one planned unit of work carrying a stable `slug:` and enough detail to spec.

Pick the first item that is all of:

- unchecked (`- [ ]`);
- has no Linear issue yet — search team `COD` for a description containing
  `Roadmap: <slug>` and skip the item if one already exists (idempotency);
- names no unmet dependency — if the item says "after `<slug>`", that slug's
  issue must already be `Done`; otherwise skip and try the next item.

If no item qualifies, say so and end the pass.

## 2. Quality gate — never guess

Proceed only if the item gives enough to write concrete, independently testable
acceptance criteria and explicit non-goals **without inventing** scope, product
behaviour, or architecture.

If it is ambiguous or underspecified, do **not** create an issue. Post nothing to
Linear, report exactly which detail is missing so the human can expand the
roadmap item, and end the pass.

## 3. File one build-ready issue

Create a Linear issue on team `COD`, unassigned, left in the backlog state,
labeled `agent-ready`, mirroring the `finn-spec` contract so `finn-build` can
consume it unchanged:

- **Title** — short imperative summary.
- `## Problem` — why, drawn from the roadmap item.
- `## Acceptance Criteria` — `AC-1..N`, each independently verifiable.
- `## Non-goals` — `NG-1..N`, binding scope fences.
- `## Relevant files` — best-effort pointers into the repo.
- `## Test expectations` — the checks a PR must add or keep green.
- `## How to verify` — numbered manual steps.
- Final line `Roadmap: <slug>` — the idempotency marker, **required**.

Keep it one-PR-sized. If the roadmap item is clearly several PRs, spec only the
first slice and note that the rest belongs to later items.

Do not assign it, do not move it out of backlog, and do not open a branch or PR —
that is `finn-build`'s job on a later orchestrator pass. End the pass.

## Hard limits

- Never invent product scope; expand only what the roadmap states.
- One issue per pass.
- Never touch code, branches, or PRs.
