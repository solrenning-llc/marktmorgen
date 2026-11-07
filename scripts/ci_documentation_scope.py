"""PV8(a): conservatively classify documentation-only PRs; all uncertainty runs full CI.

A workflow that sets CI_SUITE=ui (the browser-only suites) may also skip a pull request
that changes no file able to reach them (scripts/ci_ui_scope.py). Only a pull_request
event can skip this way; merge_group, push, schedule and workflow_dispatch never do. (A push
to main may still reuse a complete, fully passing run of the identical tree: PV8(b), below;
a pull request run whose suites were skipped is never such a run.)
"""
import os
from ci_full_tree_proof import can_reuse_main
from ci_ui_scope import changed_paths, unaffected_between
import re
import subprocess
from pathlib import PurePosixPath

SHA = re.compile(r"[0-9a-f]{40}\Z")

def documentation_path(path):
    # Markdown only: docs can also contain executable examples, fixtures and configuration.
    # Policy/instruction files can affect implementation and must receive full coverage.
    parts = PurePosixPath(path).parts
    return bool(parts and not path.startswith("/") and
                all(p not in ("", ".", "..") and not p.startswith(".") for p in parts) and
                path.endswith(".md") and
                parts[-1].lower() not in ("agents.md", "skill.md") and
                not any(p.lower() in ("tests", "scripts", "tooling", "node_modules") for p in parts))

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

def requires_full(event, base, head, diff):
    if event != "pull_request" or not SHA.fullmatch(base) or not SHA.fullmatch(head):
        return True
    try:
        return not documentation_diff(diff(base, head))
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return True

def requires_suite(suite, event, base, head, diff, unaffected):
    """Full coverage unless a documentation-only change, or, for CI_SUITE=ui on a
    pull_request, a change that the import graph proves cannot reach the suites."""
    if not requires_full(event, base, head, diff):
        return False
    if suite == "":
        return True
    if suite != "ui" or event != "pull_request" or not SHA.fullmatch(base) or not SHA.fullmatch(head):
        return True
    try:
        return unaffected(changed_paths(diff(base, head))) is not True
    except Exception:
        # Missing history, a malformed diff or an uncertain graph never permits skipping.
        return True

def git_diff(base, head):
    # No rename detection: moving code to .md retains the code deletion in the diff.
    return subprocess.check_output(
        ["git", "diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--"],
        timeout=60)

if __name__ == "__main__":
    event, suite = os.environ.get("CI_EVENT", ""), os.environ.get("CI_SUITE", "")
    base, head = os.environ.get("CI_BASE", ""), os.environ.get("CI_HEAD", "")
    documentation_only = not requires_full(event, base, head, git_diff)
    # The graph is read at the base, the head and the merge commit this checkout tests.
    full = requires_suite(suite, event, base, head, git_diff,
                          lambda changed: unaffected_between(changed, [base, head, "HEAD"]))
    if not full and not documentation_only:
        print("No changed file can reach the browser-only suites")
    if full and can_reuse_main():
        full = False
        print("Reused complete PR coverage for identical Git tree")
    value = "true" if full else "false"
    print("Full coverage required: " + value)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("full=" + value + "\n")
