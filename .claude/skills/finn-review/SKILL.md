---
name: finn-review
description: Review open PRs against their linked Linear issues and required GitHub checks, then post a three-group verdict with Finn-loop labels. Use when asked to run Finn-loop's reviewer or review its PR queue. Designed for /loop; never merges or pushes code.
---

# Finn-loop reviewer

One pass = one PR reviewed. Under `/loop`, each iteration runs this skill once.

## 1. Find a PR needing review

```bash
gh pr list --state open --json number,title,labels,isDraft,headRefOid,updatedAt,url
```

Skip drafts. For each PR, find the latest comment whose first line is
`Finn-loop review of COMMIT_SHA`.

Skip a PR when that recorded SHA equals its current `headRefOid` and it already
has `loop-approved`, `loop-changes-requested`, or `needs-human-review`. Review
it again when new commits landed after the recorded SHA. If nothing needs
review, say so and end the pass.

## 2. Read the contract and code

- Parse the linked issue identifier from `Closes TEAM-NNN` in the PR body and
  fetch the full Linear issue, including comments and relations. No linked
  issue is a must-fix finding.
- Read the full diff and every changed file in context.
- Review only against the linked issue: acceptance-criteria gaps, defects,
  broken data flow, unnecessary scope expansion, security problems, missing
  loading/error states, and code future agents will struggle to modify.
- Do not suggest unrelated improvements unless they are severe.

Every must-fix code finding starts with one of:

- `[AC-N]` — the PR does not satisfy that acceptance criterion
- `[DEFECT]` — the implementation is broken while staying inside scope
- `[SECURITY]` — a severe security issue blocks shipping
- `[CI]` — a required GitHub check failed

Non-goals are binding. If fixing a finding would require behavior excluded by
an `NG-N`, do not prescribe code. Record
`[SCOPE-CONFLICT AC-N ↔ NG-N]` with the exact contradiction and mark the PR for
human escalation.

## 3. Check merge evidence

Inspect the current PR head, mergeability, and required checks:

```bash
gh pr view NUMBER --json headRefOid,mergeable,mergeStateStatus
gh pr checks NUMBER --required --json bucket,name,state,link
```

- **Exclude the `merge-guard` check from this evaluation.** It is not a build/CI
  signal — it encodes *this* review's own verdict and fails precisely because
  `loop-approved` is not present yet. Treating it as a blocking required check
  would deadlock the review: the gate can never turn green, because the approval
  that greens it is exactly what the red gate would block. Evaluate only genuine
  build/CI checks (e.g. `verify`).
- If the genuine required checks are pending or mergeability is still unknown,
  report that the PR is waiting and end without posting a verdict or changing
  labels. A later loop pass will retry it.
- A failed genuine required check (e.g. `verify`) is a `[CI]` must-fix finding.
- A merge conflict is a `[DEFECT]` must-fix finding.
- If the repository has no genuine required check — only `merge-guard`, or none
  at all — mark the PR for human escalation; do not apply `loop-approved`.
  Finn-loop does not treat missing CI as green.

Review the exact `headRefOid` used for this evidence. Re-fetch it immediately
before posting. If it changed, discard the review and start again on a future
pass.

## 4. Post one verdict

Post one comment in this structure:

```md
Finn-loop review of COMMIT_SHA

CI: required checks passed | failed | not configured
Mergeability: clean | conflicting

## Review

Summary: one or two plain-language sentences on what this PR does.

## 1. Must fix before merge

None.

## 2. Should fix soon

None.

## 3. Safe to merge

Yes — automated review evidence is complete. A human still makes the merge decision.
```

Then set labels based on the verdict, checking existing labels before removing
them so an absent label does not fail the command:

- No must-fix and no new escalation: add `loop-approved`; remove
  `loop-changes-requested`. Preserve a pre-existing `needs-human-review` label
  because it may represent a separate high-risk human gate.
- Must-fix present: add `loop-changes-requested`; remove `loop-approved`.
- Scope conflict or no required CI: add `needs-human-review`; remove both
  `loop-approved` and `loop-changes-requested`; set "Safe to merge" to
  `No — human decision required.`

## 4b. Mirror the verdict onto Linear

The Linear state is the only view a human watching the board sees. Left alone it
reads `In Review` the moment the builder opens the PR — before this review runs —
so a reviewer who finds bugs would still leave the issue looking mergeable. Keep
Linear honest: after setting the labels, update the linked issue (parsed in
step 2) through the Linear connector so its state always matches the verdict.

- **Approved** (`loop-approved`): leave the issue in the team's review state and
  comment `✅ Finn-loop review passed on COMMIT_SHA — awaiting human merge. Do
  not merge until the PR shows the loop-approved label.` If the team has a
  dedicated post-review state (e.g. `Ready to merge`), move it there instead.
- **Changes requested** (`loop-changes-requested`): move the issue back to the
  team's started state (prefer `In Progress`) and comment the must-fix summary
  with the PR link. It is being repaired by the builder, so it must not sit in
  the review column looking ready.
- **Escalation** (`needs-human-review`): leave the issue in the review state and
  comment that a human decision is required, quoting the exact reason.

Never move the Linear issue to a completed/`Done` state. Done happens only when a
human merges the PR (`Closes TEAM-NNN` drives the GitHub↔Linear integration).
So an issue in the review state always means "reviewer approved, waiting for the
human"; a flagged PR is never parked there.

The escalation path deliberately leaves the automated repair queue. A human
must resolve the reason, change the issue or repository configuration as
needed, and remove `needs-human-review` before Finn-loop reviews that unchanged
commit again.

## 5. Hard limits

- Never merge or enable auto-merge.
- Never push commits to the PR branch.
- Never approve or request changes through a formal GitHub review. Use one
  comment plus labels because the loop may run on the PR author's token and
  GitHub rejects self-reviews.
- `loop-approved` is evidence for a human, not merge authorization.
