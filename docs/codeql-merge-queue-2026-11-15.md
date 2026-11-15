# CodeQL in the merge queue (15 November 2026)

Author: Claude 1 cloud Q. Change of CI on a required check: the coordinator confirms with the owner
before it enters the merge queue. No price, limit, commission, flag or gate changes here
(PLANS_ON_SALE, OPENING_REQUESTED, tax gate, art. 9a, commercial review and
stripePlatformEligibilityReady are untouched).

## The problem, measured on 15/11/2026 at 03:00 UTC

- In `merge_group` runs, the job "CodeQL (javascript-typescript)" took 64 minutes median
  (p90 80, maximum 103) over 182 runs in 24 hours; the `analyze` step alone took 75 minutes
  in the group of #4557. It was the slowest step of every merge group.
- In a merge group the step ran with `upload: never`: the whole analysis ran and its results
  were thrown away. The push to main then ran the same analysis again and uploaded it.

## What the merge-group analysis protected: nothing beyond the other runs

Sources read on 15/11/2026:

1. **github/codeql-action, `analyze/action.yml` at the pinned commit
   `24c54180a607b1449ed407dd24f251e4e9147c8d` (v4.38.3).** `upload`: "'never' avoids uploading
   the SARIF file to Code Scanning, even if the code scanning run fails." No input of the step
   fails it on a finding (there is no `fail-on` or similar input). So in a merge group the job
   could fail only on an execution error or a time-out, never on an alert.
2. **GitHub Docs, from the github/docs repository at commit `d59b2631` (13/11/2026)**
   (docs.github.com itself is not reachable from this environment; the repository is the source
   of the published pages):
   - "Triage code scanning alerts in pull requests" (`content/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/triage-alerts-in-pull-requests.md`):
     "If the code scanning results check finds any problems with a severity of `error`,
     `critical`, or `high`, the check fails". That check is made from uploaded results; a merge
     group uploaded none. The analysis check "may fail if there are configuration problems, or if
     the pull request breaks the build for a language that the analysis compiles" (we compile
     nothing: build-mode none).
   - "Code scanning merge protection" (`content/code-security/concepts/code-scanning/merge-protection.md`):
     "Merge protection with rulesets will **not apply** to: Merge queue groups".
   - "Workflow configuration options" (`content/code-security/reference/code-scanning/workflow-configuration-options.md`):
     "If your repository is configured with a merge queue, you need to include the `merge_group`
     event as an additional trigger for code scanning. This will ensure that pull requests are
     also scanned when they are added to a merge queue." That scan is the uploaded result; ours
     was never uploaded, because the group's ref is deleted when the group merges. The workflow
     keeps the `merge_group` trigger, so the required check still reports in every group.
   - "Managing a merge queue" (`content/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue.md`):
     "A merge queue will wait for required checks to be reported before it can proceed with
     merging." "All checks (codeql)" still reports in every merge group.
3. **Ruleset 26510779 "main: tests before merge"** (REST API, read 15/11/2026, last updated
   12/11/2026): rules `deletion`, `non_fast_forward`, `pull_request`, `required_status_checks`
   (the nine "All checks (...)") and `merge_queue` (10 builds, 360-minute check timeout). There is
   no `code_scanning` rule. `GET rules/branches/main` lists only this ruleset; main has no classic
   branch protection.
4. **This repository**: `scripts/ci_all_checks.py` only repeats the results of the jobs it reads;
   `scripts/ci_full_tree_proof.py` never reuses a CodeQL run for main (NEVER_REUSED); the
   main-red alarm (`scripts/main_red_alarm.mjs`) took a green merge-group run as main's result
   when the head's own push run gave none.

## The change (A)

- `analyze` is skipped under `merge_group` only, by its own `if`. Every pull request, every push
  to main, the daily run and the manual run analyze exactly as before (both languages,
  security-extended, build-mode none, no path left out) and upload (`upload: always`).
- "All checks (codeql)" accepts that one skip only under `merge_group`, only for the job
  `analyze`, only with `CI_ANALYSIS_OUTSIDE_QUEUE: "true"` (set in codeql.yml alone), and only
  with a successful documentation scope. A failure or cancellation still fails; a skip on any
  other event still fails.
- The main-red alarm never takes CodeQL's merge-group run as main's result (`NOT_FROM_QUEUE`), so
  main is green for CodeQL only when its own push or daily run analyzed the head. Without this,
  the alarm could have closed on a merge group that skipped the analysis.
- The alarm takes no longer to close than before: it used a merge-queue run only when the head
  had no counted push or daily run of that workflow. CodeQL's push run on main is never canceled
  while it runs (cancel-in-progress only on pull requests), so a running or waiting one already
  held the close until it finished. What changes is the rare head with no CodeQL push run at all
  (a missing run, or a commit message with `[skip ci]`): it now waits for the daily run, which
  analyzes that head, instead of trusting a merge-group run that no longer analyzes.
- What moves from the queue to main: an execution error or a time-out of CodeQL on the combined
  tree, which used to fail the merge group, now shows up on the push run of main for that same
  commit. That run fails and the main-red alarm opens its issue. It cannot change product code:
  the analysis only reads, and a finding never failed the group anyway.
- A cancel after the documentation scope succeeded also leaves `analyze` skipped, and "All checks
  (codeql)" passes under `merge_group`. That is harmless: under `merge_group` the job never runs,
  canceled or not, so no analysis is lost.
- Security coverage stays the same: the alerts in code scanning always came from the pull
  request and main runs. What the queue loses is only a non-uploaded repeat that could not fail
  on a finding.

Expected gain: a merge group's longest check drops from about 64 minutes median to the next
slowest required workflow; CodeQL itself answers in the time of its documentation-scope job
(about one minute). The new figure is to be measured on the queue after the change; nothing here
claims it.

## Follow-up, not in this change

`scripts/queue_health_report.mjs` takes the p90 of CodeQL's analyze jobs from the last 20
completed CodeQL runs of every event. Skipped jobs were already left out (documentation-only pull
requests); merge-group runs now add more of them (about 343 merge-group, 500 pull request and 67
push runs in the 24 hours before 15/11/2026, 03:00 UTC), so the warning reads fewer real samples.
It still warns. Listing `event=pull_request` and `event=push` apart would restore the sample; a
small PR of its own, with the report's tests.

## Evaluated and left out (B): `paths-ignore` for `tests/**` and `proofs/**`

`paths-ignore` in a CodeQL configuration file excludes files from the analysis itself for
interpreted languages, JavaScript/TypeScript included ("Specifying directories to scan",
workflow-configuration-options.md). It is not the same as `on.<event>.paths-ignore`, which only
decides whether the workflow runs.

- Estimated gain: `tests/` is about 28 MB and 2,812 source files against about 30 MB and 2,051
  files in `app/`, `lib/` and `components/`, so extraction and queries could drop by roughly a
  third to a half on pull request and main runs. Not measured. After (A) none of this is on the
  merge queue's path, so it would not speed up merges.
- What would stop being analyzed: every file under `tests/` and `proofs/`, and the data flow
  through them. `scripts/` imports `tests/` today (for example `scripts/margin-alignment.mjs`,
  `scripts/pricing-optimization.mjs`, `scripts/pack-cost-decomposition.mjs`), and those scripts
  generate the margin documents and run in CI, so excluding `tests/` would cut real flow into
  code that matters.
- Recommendation: do not apply now. Revisit only if pull request time becomes the bottleneck,
  and then measure first, with a list of what each excluded file feeds.
