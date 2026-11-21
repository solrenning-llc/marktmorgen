"""The final check of a workflow: one result that says whether every job of it passed.

GitHub can require a check by name before a pull request enters main. A job that a
matrix expands, or that is skipped, reports under a different name, so requiring each
job by name would leave every documentation-only pull request waiting forever. Each
workflow therefore ends with this one job, which always runs and reads the result of
every other job of the same workflow:

- every job succeeded: pass;
- documentation-scope succeeded and said the change is documentation only
  (outputs.full == "false"), and every other job succeeded or was skipped: pass;
- only on a pull request, only in the six accessibility workflows (CI_MERGE_GROUP_ONLY is
  "true" there and nowhere else), documentation-scope succeeded and said the heavy jobs wait
  for the merge queue (outputs.full == "true" and outputs.deferred == "true"), and every other
  job succeeded or was skipped: pass. Their real run is in the merge group, where this rule
  never applies, so every change still passes them before it reaches main;
- only under merge_group, only in codeql.yml (CI_ANALYSIS_OUTSIDE_QUEUE is "true" there and
  nowhere else), documentation-scope succeeded and the one job skipped is "analyze": pass.
  There it uploaded nothing (upload: never), so it could fail only on an execution error, never
  on a finding, and the main ruleset has no code scanning rule; its real run, uploaded, is on the
  pull request (which must pass it before entering the queue) and on the push to main
  (.github/workflows/codeql.yml has the sources);
- anything else (a failure, a cancellation, a skip without that proof, a missing
  result or a failed documentation-scope): fail. Under merge_group, push, schedule and
  workflow_dispatch any other skip passes only for a documentation-only change, as before.

A pass here never replaces a test; it only repeats the results of the jobs it reads.
scripts/test_ci_all_checks.py holds the rules and checks that every workflow has
this job, that it depends on every other job and that it always runs.
"""
import json
import os
import sys

SCOPE = "documentation-scope"
# The one job that CodeQL skips on purpose in the merge queue (CI_ANALYSIS_OUTSIDE_QUEUE).
QUEUE_SKIPPED_JOB = "analyze"


def decide(needs, event="", merge_group_only=False, analysis_outside_queue=False):
    """Return (passed, problems) from a workflow's `needs` context, its event and its switches."""
    if not isinstance(needs, dict) or SCOPE not in needs or len(needs) < 2:
        return False, ["the final check must depend on documentation-scope and on every other job"]
    problems = []
    scope = needs.get(SCOPE) or {}
    scope_result = scope.get("result")
    if scope_result != "success":
        problems.append(SCOPE + ": " + str(scope_result))
    outputs = scope.get("outputs") or {}
    documentation_only = scope_result == "success" and outputs.get("full") == "false"
    deferred = (scope_result == "success" and merge_group_only is True and event == "pull_request"
                and outputs.get("full") == "true" and outputs.get("deferred") == "true")
    queue_skip = scope_result == "success" and analysis_outside_queue is True and event == "merge_group"
    for name in sorted(needs):
        if name == SCOPE:
            continue
        job = needs.get(name)
        result = job.get("result") if isinstance(job, dict) else None
        if result == "success":
            continue
        if result == "skipped" and (documentation_only or deferred):
            continue
        if result == "skipped" and queue_skip and name == QUEUE_SKIPPED_JOB:
            continue
        problems.append(name + ": " + str(result))
    return not problems, problems


def main():
    try:
        needs = json.loads(os.environ.get("NEEDS", ""))
    except ValueError:
        needs = None
    event = os.environ.get("CI_EVENT", "")
    merge_group_only = os.environ.get("CI_MERGE_GROUP_ONLY") == "true"
    analysis_outside_queue = os.environ.get("CI_ANALYSIS_OUTSIDE_QUEUE") == "true"
    passed, problems = decide(needs, event, merge_group_only, analysis_outside_queue)
    if isinstance(needs, dict):
        for name in sorted(needs):
            job = needs.get(name)
            print(name + ": " + str(job.get("result") if isinstance(job, dict) else None))
    if passed:
        outputs = (needs.get(SCOPE) or {}).get("outputs") or {}
        if event == "pull_request" and merge_group_only and outputs.get("deferred") == "true":
            print("Heavy jobs skipped on purpose on this pull request: their real run is in the merge queue.")
        if event == "merge_group" and analysis_outside_queue and (needs.get(QUEUE_SKIPPED_JOB) or {}).get("result") == "skipped":
            print("CodeQL analysis skipped on purpose in the merge queue: it runs and uploads on the pull request and on the push to main.")
        print("All checks passed.")
        return 0
    print("Final check failed:")
    for problem in problems:
        print("  " + problem)
    return 1


if __name__ == "__main__":
    sys.exit(main())
