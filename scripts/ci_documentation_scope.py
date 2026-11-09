"""PV8(a): conservatively classify documentation-only PRs; all uncertainty runs full CI."""
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
    value = "true" if full else "false"
    print("Full coverage required: " + value)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("full=" + value + "\n")
