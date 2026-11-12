"""Fail closed on CodeQL errors; tolerate only completed scans of retired merge groups."""
import os
import subprocess
import sys


QUEUE_REF_PREFIX = "refs/heads/gh-readonly-queue/"


def has_nonempty_sarif(directory):
    """The CodeQL action sets sarif-output before uploading; require a real result."""
    if not directory or not os.path.isdir(directory):
        return False
    for root, _, files in os.walk(directory):
        for name in files:
            if name.lower().endswith(".sarif"):
                try:
                    if os.path.getsize(os.path.join(root, name)) > 0:
                        return True
                except OSError:
                    return False
    return False


def is_retired_group_upload_failure(event_name, ref, sarif_ready, probe_status):
    """Only a generated CodeQL result plus an exact missing-ref response is ignorable."""
    return (
        event_name == "merge_group"
        and isinstance(ref, str)
        and ref.startswith(QUEUE_REF_PREFIX)
        and sarif_ready
        and probe_status == 2  # git ls-remote --exit-code: no matching ref
    )


def main():
    event_name = os.environ.get("CI_EVENT", "")
    ref = os.environ.get("CI_REF", "")
    sarif_output = os.environ.get("CODEQL_SARIF_OUTPUT", "")
    if not has_nonempty_sarif(sarif_output):
        print("::error::CodeQL produced no non-empty SARIF result; preserving the analysis failure.")
        return 1
    if event_name != "merge_group" or not ref.startswith(QUEUE_REF_PREFIX):
        print("::error::The failed run does not identify a merge-queue ref; preserving the failure.")
        return 1

    try:
        probe = subprocess.run(
            ["git", "ls-remote", "--exit-code", "origin", ref],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        print(f"::error::Could not verify the merge-group ref; preserving the failure: {exc}")
        return 1

    if is_retired_group_upload_failure(event_name, ref, True, probe.returncode):
        print(
            "::notice::CodeQL produced SARIF, but this merge-group ref was retired before upload. "
            "The merge group is no longer active; CodeQL remains enabled on push to main."
        )
        return 0
    if probe.returncode == 0:
        print("::error::The merge-group ref still exists; preserving the CodeQL failure.")
    else:
        print(
            f"::error::Could not prove the merge-group ref is absent "
            f"(git ls-remote exit {probe.returncode}); preserving the CodeQL failure."
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
