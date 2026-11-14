"""The final check of a workflow: one result that says whether every job of it passed.

GitHub can require a check by name before a pull request enters main. A job that a
matrix expands, or that is skipped, reports under a different name, so requiring each
job by name would leave every documentation-only pull request waiting forever. Each
workflow therefore ends with this one job, which always runs and reads the result of
every other job of the same workflow:

- every job succeeded: pass;
- documentation-scope succeeded and said full coverage is not needed
  (outputs.full == "false": a documentation-only pull request, a pull request that
  scripts/ci_ui_scope.py proves cannot reach a browser-only suite, or a push whose
  identical tree already passed in full), and every other job succeeded or was
  skipped: pass;
- anything else (a failure, a cancellation, a skip without that proof, a missing
  result or a failed documentation-scope): fail.

A pass here never replaces a test; it only repeats the results of the jobs it reads.
scripts/test_ci_all_checks.py holds the rules and checks that every workflow has
this job, that it depends on every other job and that it always runs.
"""
import json
import os
import sys

SCOPE = "documentation-scope"


def decide(needs):
    """Return (passed, problems) from a workflow's `needs` context."""
    if not isinstance(needs, dict) or SCOPE not in needs or len(needs) < 2:
        return False, ["the final check must depend on documentation-scope and on every other job"]
    problems = []
    scope = needs.get(SCOPE) or {}
    scope_result = scope.get("result")
    if scope_result != "success":
        problems.append(SCOPE + ": " + str(scope_result))
    outputs = scope.get("outputs") or {}
    documentation_only = scope_result == "success" and outputs.get("full") == "false"
    for name in sorted(needs):
        if name == SCOPE:
            continue
        job = needs.get(name)
        result = job.get("result") if isinstance(job, dict) else None
        if result == "success":
            continue
        if result == "skipped" and documentation_only:
            continue
        problems.append(name + ": " + str(result))
    return not problems, problems


def main():
    try:
        needs = json.loads(os.environ.get("NEEDS", ""))
    except ValueError:
        needs = None
    passed, problems = decide(needs)
    if isinstance(needs, dict):
        for name in sorted(needs):
            job = needs.get(name)
            print(name + ": " + str(job.get("result") if isinstance(job, dict) else None))
    if passed:
        print("All checks passed.")
        return 0
    print("Final check failed:")
    for problem in problems:
        print("  " + problem)
    return 1


if __name__ == "__main__":
    sys.exit(main())
