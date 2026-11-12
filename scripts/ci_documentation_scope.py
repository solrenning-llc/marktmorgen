"""PV8(a): conservatively classify documentation-only changes; all uncertainty runs full CI.

Allowlist (documentation_path): a regular, non-executable Markdown file (*.md, lower case)
- at the top level of the repository, or
- anywhere under docs/,
never AGENTS.md or SKILL.md (agent instructions), never under a hidden folder or a tests/,
scripts/, tooling/ or node_modules/ folder. Every other path (code, tests, configuration,
workflows, package files, JSON, images, Markdown elsewhere), a rename, a symlink, an
executable bit, a submodule or an unreadable diff runs everything exactly as before.

Markdown is still read by tests (tests/tax-gate.test.ts walks docs/, tests/reservation-check
reads docs/reservations/...), so a documentation-only change is not untested: its scope sets
docs=true and product-checks runs every unit test that can read a file (tests/run.mjs
--documentation-readers, tests/documentation-readers.mjs). Only builds, browsers, Redis,
screen readers, CodeQL and the dependency audit, which read no Markdown, are skipped.

Where it applies:
- pull_request: the PR's base..head diff.
- merge_group: the queue entry's own change, its merge commit against its first parent (the
  entry below it in the queue, or main). Sound only because every entry must pass its own
  required checks before main moves (grouping_strategy ALLGREEN, read from main's rules on
  every run); any other strategy, merge shape or unreadable rule runs everything.
- push to main (never CodeQL, which always analyzes main for real): main's previous head..new
  head, and only when the previous head is green for this same workflow by the rule the main
  red alarm uses (scripts/main_red_alarm.mjs), so a documentation commit never hides red.
- schedule, workflow_dispatch and anything else: always everything.
"""
import os
import re
import subprocess
from pathlib import PurePosixPath

from ci_full_tree_proof import (REPO, REPO_ID, can_reuse_main, github_api, reusable_workflow)

SHA = re.compile(r"[0-9a-f]{40}\Z")
EXCLUDED_NAMES = ("agents.md", "skill.md")
EXCLUDED_FOLDERS = ("tests", "scripts", "tooling", "node_modules")


def documentation_path(path):
    parts = PurePosixPath(path).parts
    return bool(parts and not path.startswith("/") and
                all(p not in ("", ".", "..") and not p.startswith(".") for p in parts) and
                path.endswith(".md") and
                (len(parts) == 1 or parts[0] == "docs") and
                parts[-1].lower() not in EXCLUDED_NAMES and
                not any(p.lower() in EXCLUDED_FOLDERS for p in parts))


def documentation_diff(raw):
    if not raw or not raw.endswith(b"\0"):
        return False
    fields = raw[:-1].split(b"\0")
    if len(fields) % 2:
        return False
    for index in range(0, len(fields), 2):
        header = fields[index].decode("ascii", errors="strict").split()
        path = fields[index + 1].decode("utf-8", errors="strict")
        if len(header) != 5 or header[0] not in (":100644", ":000000"):
            return False
        if header[1] not in ("100644", "000000") or header[4] not in ("A", "M", "D"):
            return False
        if not SHA.fullmatch(header[2]) or not SHA.fullmatch(header[3]):
            return False
        if not documentation_path(path):
            return False
    return True


def documentation_between(base, head, diff):
    """True only for a readable diff of documentation files alone; an empty diff is not one."""
    if not SHA.fullmatch(base or "") or not SHA.fullmatch(head or ""):
        return False
    try:
        return documentation_diff(diff(base, head))
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return False


def requires_full(event, base, head, diff):
    """The pull_request decision; every other event needs its own proof (decide)."""
    if event != "pull_request":
        return True
    return not documentation_between(base, head, diff)


def allgreen(api):
    """Every merge queue rule on main makes each entry pass its own checks (ALLGREEN)."""
    rules = api("rules/branches/main?per_page=100")
    if not isinstance(rules, list) or len(rules) >= 100:
        return False
    queues = [r for r in rules if isinstance(r, dict) and r.get("type") == "merge_queue"]
    return bool(queues) and all(isinstance(r.get("parameters"), dict)
                                and r["parameters"].get("grouping_strategy") == "ALLGREEN" for r in queues)


def queue_entry_base(env, git, api):
    """The first parent of the queue entry's merge commit, when its own diff alone decides."""
    head = env.get("CI_GROUP_HEAD", "")
    if (env.get("CI_REPOSITORY") != REPO or not SHA.fullmatch(head)
            or not env.get("CI_REF", "").startswith("refs/heads/gh-readonly-queue/main/")
            or git("rev-parse", "HEAD") != head):
        return None
    parents = git("rev-list", "--parents", "-n", "1", head).split()
    if len(parents) != 3 or parents[0] != head or not all(SHA.fullmatch(p) for p in parents):
        return None
    if not allgreen(api):
        return None
    return parents[1]


RED_JOB = ("failure", "timed_out", "startup_failure")
COUNTED = ("push", "schedule")


def listing(api, path):
    reply = api(path)
    runs = reply.get("workflow_runs") if isinstance(reply, dict) else None
    if (not isinstance(runs, list) or type(reply.get("total_count")) is not int
            or reply.get("total_count") != len(runs) or len(runs) >= 100
            or any(not isinstance(r, dict) or type(r.get("id")) is not int for r in runs)):
        raise ValueError("incomplete run listing")
    return runs


def ours(run):
    return (run.get("repository", {}).get("id") == REPO_ID
            and run.get("head_repository", {}).get("id") == REPO_ID)


def canceled_without_red(run, current, api):
    """A canceled main run is no evidence (main_red_alarm.mjs redInside) only when no job failed
    and every stopped job was stopped because this newer push superseded it before it ended."""
    reply = api("actions/runs/" + str(run["id"]) + "/jobs?filter=latest&per_page=100")
    jobs = reply.get("jobs") if isinstance(reply, dict) else None
    if (not isinstance(jobs, list) or reply.get("total_count") != len(jobs) or len(jobs) >= 100
            or any(not isinstance(j, dict) for j in jobs)):
        return False
    work = [j for j in jobs if not str(j.get("name", "")).startswith("All checks (")]
    if any(j.get("conclusion") in RED_JOB for j in work):
        return False
    if not any(j.get("conclusion") == "cancelled" for j in work):
        return True
    ended, began = run.get("updated_at"), current.get("created_at")
    return (current.get("event") == run.get("event") and current.get("id", 0) > run["id"]
            and type(ended) is str and type(began) is str and began <= ended)


def previous_head_green(before, workflow, run_id, api):
    """main's previous head is green for this workflow, as the main red alarm reads it."""
    path = ".github/workflows/" + workflow + ".yml"
    runs = [r for r in listing(api, "actions/runs?head_sha=" + before + "&per_page=100")
            if r.get("path") == path and r.get("head_sha") == before and ours(r)]
    current = api("actions/runs/" + str(run_id))
    if not isinstance(current, dict) or current.get("id") != run_id or current.get("path") != path:
        return False
    counted = [r for r in runs if r.get("event") in COUNTED and r.get("head_branch") == "main"]
    if counted:
        newest = max(counted, key=lambda r: r["id"])
        if newest.get("status") != "completed":
            return False
        if newest.get("conclusion") == "success":
            return True
        if newest.get("conclusion") not in ("cancelled", "skipped"):
            return False
        if newest.get("conclusion") == "cancelled" and not canceled_without_red(newest, current, api):
            return False
    # No push or daily result there: the newest merge_group run on that very head decides.
    queue = [r for r in runs if r.get("event") == "merge_group"]
    if not queue:
        return False
    newest = max(queue, key=lambda r: r["id"])
    branch = newest.get("head_branch")
    return (type(branch) is str and branch.startswith("gh-readonly-queue/main/")
            and newest.get("status") == "completed" and newest.get("conclusion") == "success")


def main_push_base(env, git, api):
    """main's previous head, when only documentation changed since and that head is green."""
    before, head = env.get("CI_BEFORE", ""), env.get("CI_SHA", "")
    workflow = reusable_workflow(env)
    run_id = env.get("GITHUB_RUN_ID", "")
    if (env.get("CI_REF") != "refs/heads/main" or env.get("CI_REPOSITORY") != REPO or workflow is None
            or not SHA.fullmatch(before) or not SHA.fullmatch(head) or not run_id.isdigit()
            or git("rev-parse", "HEAD") != head):
        return None
    try:
        git("merge-base", "--is-ancestor", before, head)
    except subprocess.CalledProcessError:
        return None
    if not previous_head_green(before, workflow, int(run_id), api):
        return None
    return before


def decide(env, git, diff, api, reuse):
    """'documentation', 'reused' or 'full'. Any error or doubt is 'full'."""
    event = env.get("CI_EVENT", "")
    try:
        if event == "pull_request":
            if not requires_full(event, env.get("CI_BASE", ""), env.get("CI_HEAD", ""), diff):
                return "documentation"
        elif event == "merge_group":
            base = queue_entry_base(env, git, api)
            if base and documentation_between(base, env["CI_GROUP_HEAD"], diff):
                return "documentation"
        elif event == "push":
            if reuse():
                return "reused"
            base = main_push_base(env, git, api)
            if base and documentation_between(base, env["CI_SHA"], diff):
                return "documentation"
    except Exception:
        # Missing history, an unreadable API reply or anything unexpected never permits skipping.
        return "full"
    return "full"


def git_diff(base, head):
    # No rename detection: moving code to .md retains the code deletion in the diff.
    return subprocess.check_output(
        ["git", "diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--"],
        timeout=60)


def git(*args):
    return subprocess.check_output(["git", *args], timeout=15).decode().strip()


OUTPUTS = {"full": ("true", "false"), "documentation": ("false", "true"), "reused": ("false", "false")}

if __name__ == "__main__":
    mode = decide(os.environ, git, git_diff, github_api, can_reuse_main)
    full, docs = OUTPUTS[mode]
    print({"full": "Full coverage required",
           "documentation": "Documentation only: every unit test that can read a file still runs",
           "reused": "Reused complete coverage of the identical code"}[mode])
    print("Full coverage required: " + full)
    print("Documentation tests required: " + docs)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("full=" + full + "\ndocs=" + docs + "\n")
