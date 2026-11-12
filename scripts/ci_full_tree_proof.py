"""PV8(b): a push to main reuses only complete coverage of the identical code.

Two proofs, either one enough, both read again on every push and both refused on any doubt:
- the merge queue (C1-0305-C4-28): main only fast-forwards to the merge queue's commit, so the
  merge_group runs GitHub already made are on main's HEAD itself; every expected workflow's
  latest run there passed with every expected job (prove_merge_group);
- the pull request: complete PR coverage of a merge commit with HEAD's tree (prove_full_tree).
Only on a push to main (schedule and workflow_dispatch always run everything), and never for
CodeQL: it is in no reuse path, so its push run on main always analyzes the code for real."""
import json
import os
import re
import subprocess
import urllib.request

# This repository's permanent numeric ID: GitHub keeps it when the repository is
# renamed or moved to another owner, and no fork or copy has it. The API path uses
# the current name only when the runner proves it is this repository by that ID.
REPO_ID = 1334793724
ORIGINAL_REPO = "viniciussucupira/marktmorgen"
REPO_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/marktmorgen\Z")

def current_repo(env=os.environ):
    name = env.get("GITHUB_REPOSITORY", "")
    if env.get("GITHUB_REPOSITORY_ID") == str(REPO_ID) and REPO_NAME.fullmatch(name):
        return name
    return ORIGINAL_REPO

REPO = current_repo()
SHA = re.compile(r"[0-9a-f]{40}\Z")
WORKFLOWS = {
    "product-checks": {"verify", "form-opportunity-redis", "Mobile render (candidate)", "Cross-browser (firefox)", "Cross-browser (webkit)",
                       "Copying a whole store (chromium)"},
    "dependency-security": {"audit"},
    "accessibility-real-readers": {"Real reader entry (windows-latest)", "Real reader entry (macos-latest)"},
}
for key, label in [("buyer-actions", "Buyer action"), ("product-actions", "Product action"),
                   ("public-matrix", "Public"), ("signup-actions", "Signup action"),
                   ("studio-matrix", "Studio")]:
    WORKFLOWS["accessibility-" + key] = {label + " AAA (" + browser + ")" for browser in ("chromium", "firefox", "webkit")}
# CodeQL is deliberately absent: no proof covers it and its own push run is never skipped.
NEVER_REUSED = {"codeql"}
# Every workflow ends with its final check (scripts/ci_all_checks.py), which must have passed too.
for workflow in WORKFLOWS:
    WORKFLOWS[workflow] = WORKFLOWS[workflow] | {"All checks (" + workflow + ")"}

def prove_full_tree(candidate, tree, api):
    if not SHA.fullmatch(candidate) or not SHA.fullmatch(tree):
        return False
    listing = api("actions/runs?head_sha=" + candidate + "&event=pull_request&per_page=100")
    runs = listing.get("workflow_runs", [])
    if listing.get("total_count") != len(runs) or len(runs) > 100:
        return False
    commits = {}
    for workflow, expected in WORKFLOWS.items():
        path = ".github/workflows/" + workflow + ".yml"
        matches = [r for r in runs if r.get("path") == path and r.get("event") == "pull_request"
                   and r.get("head_sha") == candidate]
        if not matches:
            return False
        run = max(matches, key=lambda r: r["id"])
        if (run.get("status") != "completed" or run.get("conclusion") != "success"
                or run.get("repository", {}).get("id") != REPO_ID
                or run.get("head_repository", {}).get("id") != REPO_ID):
            return False
        title = run.get("display_title", "")
        tested = title.removeprefix("PV8 source ")
        if title != "PV8 source " + tested or not SHA.fullmatch(tested):
            return False
        if tested not in commits:
            commits[tested] = api("git/commits/" + tested)
        commit = commits[tested]
        parents = commit.get("parents", [])
        if (commit.get("sha") != tested or commit.get("tree", {}).get("sha") != tree
                or len(parents) != 2 or parents[1].get("sha") != candidate):
            return False
        if not all_jobs_passed(run, workflow, expected, api):
            return False
    return True

def all_jobs_passed(run, workflow, expected, api):
    """Every expected job of the run's latest attempt, and nothing else, completed with success."""
    run_id = run.get("id")
    if type(run_id) is not int or run_id <= 0:
        return False
    jobs_reply = api("actions/runs/" + str(run_id) + "/jobs?filter=latest&per_page=100")
    jobs = jobs_reply.get("jobs", [])
    names = expected | {"Documentation scope (" + workflow + ")"}
    return not (type(jobs_reply.get("total_count")) is not int or jobs_reply.get("total_count") != len(jobs)
                or not isinstance(jobs, list) or len(jobs) != len(names)
                or {j.get("name") for j in jobs} != names
                or any(j.get("status") != "completed" or j.get("conclusion") != "success"
                       or not j.get("started_at") or not j.get("completed_at") for j in jobs))

def prove_merge_group(head, api):
    """Every expected workflow's newest merge_group run on HEAD itself, in main's merge queue, passed."""
    if not SHA.fullmatch(head):
        return False
    listing = api("actions/runs?head_sha=" + head + "&event=merge_group&per_page=100")
    runs = listing.get("workflow_runs", [])
    if type(listing.get("total_count")) is not int or not isinstance(runs, list) or listing.get("total_count") != len(runs) or len(runs) > 100:
        return False
    for workflow, expected in WORKFLOWS.items():
        path = ".github/workflows/" + workflow + ".yml"
        # The newest run of the file decides, whatever it is: an older success never hides it.
        matches = [r for r in runs if r.get("path") == path]
        if not matches or any(type(r.get("id")) is not int for r in matches):
            return False
        run = max(matches, key=lambda r: r["id"])
        branch = run.get("head_branch")
        if (run.get("event") != "merge_group" or run.get("head_sha") != head
                or type(branch) is not str or not branch.startswith("gh-readonly-queue/main/")
                or run.get("status") != "completed" or run.get("conclusion") != "success"
                or run.get("repository", {}).get("id") != REPO_ID
                or run.get("head_repository", {}).get("id") != REPO_ID
                or run.get("display_title") != "PV8 source " + head):
            return False
        if not all_jobs_passed(run, workflow, expected, api):
            return False
    return True

WORKFLOW_REF = re.compile(r"(.+)/\.github/workflows/([a-z0-9-]+)\.yml@refs/heads/main\Z")

def reusable_workflow(env=os.environ):
    """The running workflow, only when it is one of this repository's reusable ones (never CodeQL)."""
    match = WORKFLOW_REF.fullmatch(env.get("GITHUB_WORKFLOW_REF", ""))
    if not match or match.group(1) != REPO or match.group(2) not in WORKFLOWS:
        return None
    return match.group(2)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        raise ValueError("proof redirect refused")

def github_api(path):
    token = os.environ.get("CI_TOKEN", "")
    if not token:
        raise ValueError("no read token")
    request = urllib.request.Request("https://api.github.com/repos/" + REPO + "/" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "marktmorgen-ci-tree-proof"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("oversized proof")
    return json.loads(raw)

def can_reuse_main():
    if (os.environ.get("CI_EVENT") != "push" or os.environ.get("CI_REF") != "refs/heads/main"
            or os.environ.get("CI_REPOSITORY") != REPO or reusable_workflow() is None):
        return False
    try:
        def git(*args):
            return subprocess.check_output(["git", *args], timeout=15).decode().strip()
        if prove_merge_group(git("rev-parse", "HEAD"), github_api):
            return True
        parents = git("rev-list", "--parents", "-n", "1", "HEAD").split()
        if len(parents) != 3:
            return False
        candidate = parents[2]
        tree = git("rev-parse", "HEAD^{tree}")
        if tree != git("rev-parse", candidate + "^{tree}"):
            return False
        return prove_full_tree(candidate, tree, github_api)
    except Exception:
        # Missing, malformed, stale or unavailable evidence never permits skipping.
        return False
