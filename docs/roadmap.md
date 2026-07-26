# Roadmap

This file is the **only** source the Finn-loop orchestrator uses to generate new
work autonomously (`finn-spec-auto`). You own it. The loop never invents scope —
it only expands what you write here into build-ready Linear issues, one at a
time, and only when the queue is empty.

## How it works

- Each pending item below becomes **one** build-ready issue (one PR-sized unit).
- The orchestrator picks the **first unchecked** item that has no Linear issue
  yet and whose dependencies are merged, expands it into a full spec
  (acceptance criteria + non-goals), and files it on team `COD` as `agent-ready`.
- Give each item enough detail to spec **without guessing**. If an item is too
  vague, the loop skips it and tells you what's missing rather than inventing.
- Tick `- [x]` yourself for your own tracking; the loop also skips any item that
  already has a Linear issue (matched by its `slug`), so it never duplicates.

## Item format

```markdown
- [ ] (slug: short-stable-id) One-line goal of this unit of work
      Goal: what should exist after this PR, in product terms.
      Constraints: hard rules to respect (e.g. keep HTTP contracts unchanged).
      Out of scope: what this unit must NOT touch (becomes the non-goals).
      After: other-slug            # optional — only start once that slug is Done
```

Keep each item to a single PR. If something is clearly several PRs, list it as
several items in dependency order using `After:`.

## Pending items

<!--
Add your real items below, one per line, using the format above. Until you add
one, the orchestrator has nothing to generate and simply skips step 4.

Example (delete and replace with real work):

- [ ] (slug: persist-config-entities) Persist habits/rules/commitments to the durable DB
      Goal: move config entities off MemoryStore onto the PGlite foundation.
      Constraints: keep the HTTP contracts and Api signatures unchanged.
      Out of scope: coach/memory persistence; auth; migrations framework.
      After: cod-2-durable-db
-->

_(none yet — add items above to feed the loop)_
