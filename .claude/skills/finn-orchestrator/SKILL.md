---
name: finn-orchestrator
description: Meta-loop that drives Finn-loop end to end — generate specs from the roadmap, build, review, and flag merge-ready PRs for the human. Use when asked to run the Finn-loop orchestrator or the full autonomous loop. Designed for /loop; one pass does one highest-priority action. Never merges.
---

# Finn-loop orchestrator

One pass = one action. Each `/loop` iteration assesses the whole queue and
performs the single highest-priority step below, then ends. It drains work in
flight before creating more, so work-in-progress stays bounded.

**It never merges.** Merging is the human's decision; this loop only surfaces
merge-ready PRs for them (per the configured policy: human merge, notify only).

**Run this loop OR the standalone finn-build / finn-review loops — never both**,
or they double-drive the queue. Stop any standalone finn-build/finn-review cron
before starting this one.

## 0. Preflight

Confirm the intended GitHub repository and a clean working tree (as `finn-build`
step 0). If the tree is dirty, report the paths and end the pass — never stash,
reset, or commit unrelated work.

## Decision order — do the first step that applies, then end the pass

### 1. Review any PR that needs it
If an open, non-draft PR has no `Finn-loop review of <headSha>` verdict matching
its current head (never reviewed, or new commits since the last verdict), invoke
the **finn-review** skill for that one PR and end. (This also keeps Linear honest
via finn-review's own state mirroring.)

### 2. Advance the build queue
Else if any open PR carries `loop-changes-requested` and not
`needs-human-review`, or team `COD` has an `agent-ready`, unassigned, unblocked
issue, invoke the **finn-build** skill for one unit of work and end. (finn-build
fixes review feedback before claiming new issues.)

### 3. Flag merge-ready PRs for the human — never merge
Else, for each open PR that is **all** of: labeled `loop-approved`, every
required check green, mergeable with no conflict — check whether it already
carries a `Finn-loop: merge-ready <headSha>` marker comment.

- If not, post that marker comment (one line: "🟢 Ready for human merge — the
  reviewer approved this commit, required checks are green, no conflicts.") and
  tell the user in the loop output: PR number, title, URL. Include the
  attribution footer on the comment.
- If the marker already exists for the current head, stay silent (already
  announced).

Never merge and never enable auto-merge — only announce. If this step announced
anything new, end the pass.

### 4. Top up the queue from the roadmap
Else, only when there is **no work in flight** (no open PRs and no `agent-ready`
issue on team `COD`) and `docs/roadmap.md` has a qualifying pending item, invoke
the **finn-spec-auto** skill for one issue and end. This WIP gate stops the
builder from being flooded — the queue is refilled one issue at a time, only when
empty.

### 5. Idle
Else report "nothing to do" and end the pass.

## Hard limits

- Never merge or enable auto-merge. The only merge-side action allowed is posting
  the `Finn-loop: merge-ready` marker comment and notifying the user.
- One action per pass; highest priority first.
- Honour every sub-skill's own limits (finn-review never pushes code;
  finn-build does one unit; finn-spec-auto never guesses product scope).
