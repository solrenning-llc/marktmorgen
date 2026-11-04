"""PV8(b): reuse only complete PR coverage of the identical checked-out tree."""
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
    "product-checks": {"verify", "form-opportunity-redis", "Mobile render (candidate)", "Cross-browser (firefox)", "Cross-browser (webkit)"},
    "dependency-security": {"audit"},
    "crm-redis": {"crm-import-redis"},
    "codeql": {"CodeQL (javascript-typescript)", "CodeQL (actions)"},
    "accessibility-real-readers": {"Real reader entry (windows-latest)", "Real reader entry (macos-latest)"},
}
for key, label in [("buyer-actions", "Buyer action"), ("product-actions", "Product action"),
                   ("public-matrix", "Public"), ("signup-actions", "Signup action"),
                   ("studio-matrix", "Studio")]:
    WORKFLOWS["accessibility-" + key] = {label + " AAA (" + browser + ")" for browser in ("chromium", "firefox", "webkit")}
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
        run_id = run.get("id")
        if type(run_id) is not int or run_id <= 0:
            return False
        jobs_reply = api("actions/runs/" + str(run_id) + "/jobs?filter=latest&per_page=100")
        jobs = jobs_reply.get("jobs", [])
        names = expected | {"Documentation scope (" + workflow + ")"}
        if (jobs_reply.get("total_count") != len(jobs) or len(jobs) != len(names)
                or {j.get("name") for j in jobs} != names
                or any(j.get("status") != "completed" or j.get("conclusion") != "success"
                       or not j.get("started_at") or not j.get("completed_at") for j in jobs)):
            return False
    return True

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
            or os.environ.get("CI_REPOSITORY") != REPO):
        return False
    try:
        def git(*args):
            return subprocess.check_output(["git", *args], timeout=15).decode().strip()
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
