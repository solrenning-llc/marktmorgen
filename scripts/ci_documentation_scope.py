"""PV8(a): conservatively classify documentation-only PRs; all uncertainty runs full CI.

Also, for the six accessibility workflows only, whether a pull request's heavy jobs wait for the
merge queue (deferred_to_merge_group); every doubt runs them on the pull request."""
import os
from ci_full_tree_proof import can_reuse_main
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

# The six accessibility workflows whose heavy jobs, on a pull request, wait for the merge queue
# (owner, 12/11/2026): every change still passes them in its merge group before it reaches main,
# and push, schedule and workflow_dispatch run them as before. Each one says so to its scope and to
# its final check with CI_MERGE_GROUP_ONLY: "true" (scripts/test_ci_all_checks.py holds where).
MERGE_GROUP_ONLY = frozenset("accessibility-" + key for key in (
    "buyer-actions", "product-actions", "public-matrix", "real-readers", "signup-actions", "studio-matrix"))

# What those workflows run, or what decides how they run: a pull request that changes any of it
# runs the full accessibility matrix on its own head, so a change to that CI is proven where it is
# made. scripts/test_ci_documentation_scope.py follows every file the six workflows run and what
# those files read under tests/, and fails when one is left outside these rules.
HARNESS_PREFIXES = (".github/", "tests/e2e/", "tooling/")
# npm-shrinkwrap.json takes precedence over package-lock.json, and .npmrc changes how npm ci installs.
HARNESS_FILES = frozenset({"package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc",
                           "tsconfig.json", "tests/next-link-world.tsx"})
CHANGE = re.compile(r":[0-7]{6}\Z")
MODE = re.compile(r"[0-7]{6}\Z")

def harness_path(path):
    parts = PurePosixPath(path).parts if isinstance(path, str) else ()
    if (not parts or path.startswith(("/", "./")) or "//" in path
            or any(p in ("", ".", "..") for p in path.split("/"))):
        return True  # An odd path is never trusted to be outside the harness.
    if path in HARNESS_FILES or path.startswith(HARNESS_PREFIXES):
        return True
    return len(parts) == 2 and parts[0] == "scripts" and parts[1].startswith(("ci_", "ci-", "test_ci_"))

def changed_paths(raw):
    """Every path of a `git diff --raw --no-renames -z`, or None when any record does not read."""
    if not isinstance(raw, bytes) or not raw or not raw.endswith(b"\0"):
        return None
    fields = raw[:-1].split(b"\0")
    if len(fields) % 2:
        return None
    paths = []
    for index in range(0, len(fields), 2):
        try:
            header = fields[index].decode("ascii", errors="strict").split()
            path = fields[index + 1].decode("utf-8", errors="strict")
        except UnicodeError:
            return None
        if (len(header) != 5 or not CHANGE.fullmatch(header[0]) or not MODE.fullmatch(header[1])
                or not SHA.fullmatch(header[2]) or not SHA.fullmatch(header[3])
                or header[4] not in ("A", "M", "D", "T")):
            return None
        paths.append(path)
    return paths

def deferred_to_merge_group(enabled, event, base, head, diff):
    """True only on a pull request of a merge-group-only workflow whose readable diff leaves the
    harness alone; any doubt runs the heavy jobs on the pull request as before."""
    if enabled is not True or event != "pull_request" or not isinstance(base, str) or not isinstance(head, str):
        return False
    if not SHA.fullmatch(base) or not SHA.fullmatch(head):
        return False
    try:
        paths = changed_paths(diff(base, head))
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return False
    return bool(paths) and not any(harness_path(path) for path in paths)

def git_diff(base, head):
    # No rename detection: moving code to .md retains the code deletion in the diff.
    return subprocess.check_output(
        ["git", "diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head, "--"],
        timeout=60)

if __name__ == "__main__":
    full = requires_full(os.environ.get("CI_EVENT", ""), os.environ.get("CI_BASE", ""),
                         os.environ.get("CI_HEAD", ""), git_diff)
    if full and can_reuse_main():
        full = False
        print("Reused complete coverage of the identical code: the merge queue on this commit, or the PR of this tree")
    deferred = full and deferred_to_merge_group(os.environ.get("CI_MERGE_GROUP_ONLY") == "true",
                                                os.environ.get("CI_EVENT", ""), os.environ.get("CI_BASE", ""),
                                                os.environ.get("CI_HEAD", ""), git_diff)
    value = "true" if full else "false"
    print("Full coverage required: " + value)
    if deferred:
        print("Deferred to the merge queue: this pull request leaves the accessibility harness alone,"
              " so its heavy jobs run in the merge group before the change reaches main")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("full=" + value + "\n")
        output.write("deferred=" + ("true" if deferred else "false") + "\n")
