import copy
import unittest
import os
import re
from pathlib import Path
from unittest.mock import patch
import ci_full_tree_proof
from ci_full_tree_proof import WORKFLOWS, REPO, REPO_ID, ORIGINAL_REPO, current_repo, prove_full_tree, can_reuse_main
from test_ci_all_checks import jobs_of
A, T, M = "a"*40, "b"*40, "c"*40
H, P = "e"*40, "f"*40
QUEUE_BRANCH = "gh-readonly-queue/main/pr-3144-" + P

def fixture():
    runs = []
    replies = {"git/commits/" + M: {"sha": M, "tree": {"sha": T}, "parents": [{"sha":"d"*40},{"sha":A}]}}
    for index, (workflow, names) in enumerate(WORKFLOWS.items(), 1):
        runs.append({"id":index, "path":".github/workflows/"+workflow+".yml", "event":"pull_request",
                     "head_sha":A, "status":"completed", "conclusion":"success",
                     "repository":{"id":REPO_ID,"full_name":REPO}, "head_repository":{"id":REPO_ID,"full_name":REPO},
                     "display_title":"PV8 source "+M})
        jobs = [{"name":n,"status":"completed","conclusion":"success","started_at":"2026-10-25T00:00:00Z",
                 "completed_at":"2026-10-25T00:01:00Z"} for n in names | {"Documentation scope ("+workflow+")"}]
        replies["actions/runs/"+str(index)+"/jobs?filter=latest&per_page=100"] = {"total_count":len(jobs),"jobs":jobs}
    replies["actions/runs?head_sha="+A+"&event=pull_request&per_page=100"] = {"total_count":len(runs),"workflow_runs":runs}
    return replies

class FullTreeProofTests(unittest.TestCase):
    def test_current_name_only_with_the_permanent_id(self):
        self.assertEqual(current_repo({}), ORIGINAL_REPO)
        self.assertEqual(current_repo({"GITHUB_REPOSITORY":"new-owner/marktmorgen","GITHUB_REPOSITORY_ID":str(REPO_ID)}), "new-owner/marktmorgen")
        for env in [{"GITHUB_REPOSITORY":"new-owner/marktmorgen"},
                    {"GITHUB_REPOSITORY":"new-owner/marktmorgen","GITHUB_REPOSITORY_ID":str(REPO_ID+1)},
                    {"GITHUB_REPOSITORY":"new-owner/other","GITHUB_REPOSITORY_ID":str(REPO_ID)},
                    {"GITHUB_REPOSITORY":"a/b/marktmorgen","GITHUB_REPOSITORY_ID":str(REPO_ID)},
                    {"GITHUB_REPOSITORY":"../marktmorgen","GITHUB_REPOSITORY_ID":str(REPO_ID)}]:
            self.assertEqual(current_repo(env), ORIGINAL_REPO)

    def test_exact_complete_tree_passes(self):
        self.assertTrue(prove_full_tree(A,T,fixture().__getitem__))

    def test_unknown_or_different_tree_refuses(self):
        self.assertFalse(prove_full_tree(A,"e"*40,fixture().__getitem__))
        self.assertFalse(prove_full_tree("--bad",T,fixture().__getitem__))

    def test_skipped_failed_cancelled_missing_and_duplicate_jobs_refuse(self):
        for conclusion in ["skipped","failure","cancelled",None]:
            data=fixture()
            data["actions/runs/1/jobs?filter=latest&per_page=100"]["jobs"][0]["conclusion"]=conclusion
            self.assertFalse(prove_full_tree(A,T,data.__getitem__))
        for mutation in ["missing","duplicate","unstarted"]:
            data=fixture(); reply=data["actions/runs/1/jobs?filter=latest&per_page=100"]
            if mutation=="missing": reply["jobs"].pop()
            elif mutation=="duplicate": reply["jobs"][0]=copy.deepcopy(reply["jobs"][1])
            else: reply["jobs"][0]["started_at"]=None
            self.assertFalse(prove_full_tree(A,T,data.__getitem__))

    def test_wrong_source_event_repository_or_head_refuses(self):
        for field,value in [("event","push"),("head_sha","e"*40),("display_title","owner supplied title"),
                            ("conclusion","failure"),("repository",{"id":1,"full_name":"other/repo"}),
                            ("head_repository",{"id":2,"full_name":"fork/repo"}),
                            ("repository",{"full_name":REPO}),
                            ("head_repository",{"id":REPO_ID+1,"full_name":REPO})]:
            data=fixture(); data[next(k for k in data if k.startswith("actions/runs?"))]["workflow_runs"][0][field]=value
            self.assertFalse(prove_full_tree(A,T,data.__getitem__))

    def test_truncated_listing_or_wrong_merge_parent_refuses(self):
        data=fixture(); data[next(k for k in data if k.startswith("actions/runs?"))]["total_count"]+=1
        self.assertFalse(prove_full_tree(A,T,data.__getitem__))
        data=fixture(); data["git/commits/"+M]["parents"][1]["sha"]="e"*40
        self.assertFalse(prove_full_tree(A,T,data.__getitem__))

    def test_new_pending_attempt_cannot_reuse_older_success(self):
        data=fixture(); listing=data[next(k for k in data if k.startswith("actions/runs?"))]
        latest=copy.deepcopy(listing["workflow_runs"][0]);latest.update(id=999,status="in_progress",conclusion=None)
        listing["workflow_runs"].append(latest);listing["total_count"]+=1
        self.assertFalse(prove_full_tree(A,T,data.__getitem__))

    def test_daily_and_manual_cannot_reuse_old_proof(self):
        for event in ("schedule", "workflow_dispatch", "pull_request", ""):
            with patch.dict(os.environ, {"CI_EVENT":event, "CI_REF":"refs/heads/main", "CI_REPOSITORY":REPO}):
                self.assertFalse(can_reuse_main())

def queue_fixture(head=H):
    """C1-0305-C4-28: the merge_group runs GitHub made on the very commit main now points at."""
    runs = []
    replies = {}
    for index, (workflow, names) in enumerate(WORKFLOWS.items(), 1):
        runs.append({"id":500+index, "path":".github/workflows/"+workflow+".yml", "event":"merge_group",
                     "head_sha":head, "head_branch":QUEUE_BRANCH, "status":"completed", "conclusion":"success",
                     "repository":{"id":REPO_ID,"full_name":REPO}, "head_repository":{"id":REPO_ID,"full_name":REPO},
                     "display_title":"PV8 source "+head})
        jobs = [{"name":n,"status":"completed","conclusion":"success","started_at":"2026-11-08T00:00:00Z",
                 "completed_at":"2026-11-08T00:01:00Z"} for n in names | {"Documentation scope ("+workflow+")"}]
        replies["actions/runs/"+str(500+index)+"/jobs?filter=latest&per_page=100"] = {"total_count":len(jobs),"jobs":jobs}
    replies["actions/runs?head_sha="+head+"&event=merge_group&per_page=100"] = {"total_count":len(runs),"workflow_runs":runs}
    return replies

def queue_listing(data):
    return data[next(k for k in data if "&event=merge_group&" in k)]

def push_env(workflow="product-checks", event="push"):
    return {"CI_EVENT":event, "CI_REF":"refs/heads/main", "CI_REPOSITORY":REPO,
            "GITHUB_WORKFLOW_REF":REPO+"/.github/workflows/"+workflow+".yml@refs/heads/main"}

def fake_git(head=H, parents=(), trees=None):
    trees = trees or {}
    def check_output(args, timeout=None):
        if args[1:] == ["rev-parse", "HEAD"]:
            return (head + "\n").encode()
        if args[1:4] == ["rev-list", "--parents", "-n"]:
            return (" ".join((head,) + tuple(parents)) + "\n").encode()
        if args[1] == "rev-parse" and args[2].endswith("^{tree}"):
            return (trees[args[2][:-len("^{tree}")]] + "\n").encode()
        raise AssertionError("unexpected git call: " + repr(args))
    return check_output

def reuse(env, api, git):
    with patch.dict(os.environ, env, clear=True), \
         patch.object(ci_full_tree_proof, "github_api", api), \
         patch.object(ci_full_tree_proof.subprocess, "check_output", git):
        return can_reuse_main()

class MergeQueueSameCommitTests(unittest.TestCase):
    """The push to main repeats the merge_group runs on the same SHA: reuse them, never CodeQL."""

    def test_merge_group_green_on_the_head_lets_the_push_skip(self):
        from ci_full_tree_proof import prove_merge_group
        self.assertTrue(prove_merge_group(H, queue_fixture().__getitem__))
        # A fast-forward of main has one parent or two; the proof never depends on that.
        self.assertTrue(reuse(push_env(), queue_fixture().__getitem__, fake_git(parents=(P,))))
        self.assertTrue(reuse(push_env("dependency-security"), queue_fixture().__getitem__, fake_git(parents=(P, A), trees={"HEAD":T, A:"9"*40})))

    def test_push_without_a_green_merge_group_on_the_same_sha_runs_everything(self):
        from ci_full_tree_proof import prove_merge_group
        empty = {"actions/runs?head_sha="+H+"&event=merge_group&per_page=100": {"total_count":0,"workflow_runs":[]}}
        self.assertFalse(reuse(push_env(), empty.__getitem__, fake_git(parents=(P,))))
        # A green merge group on an EARLIER head never covers the current one.
        earlier = queue_fixture(P)
        moved = {"actions/runs?head_sha="+H+"&event=merge_group&per_page=100": queue_listing(earlier)}
        moved.update({k: v for k, v in earlier.items() if "/jobs?" in k})
        self.assertFalse(prove_merge_group(H, moved.__getitem__))
        for field, value in [("event","push"), ("event","pull_request"), ("head_sha",P),
                             ("head_branch","main"), ("head_branch","gh-readonly-queue/other/pr-1-"+P),
                             ("head_branch","feature/gh-readonly-queue/main/x"), ("head_branch",None),
                             ("repository",{"id":1,"full_name":"other/repo"}), ("repository",{"full_name":REPO}),
                             ("head_repository",{"id":REPO_ID+1,"full_name":REPO}),
                             ("display_title","PV8 source "+P), ("display_title","owner supplied title"),
                             ("status","in_progress"), ("conclusion","failure"), ("conclusion","cancelled"),
                             ("conclusion","skipped"), ("conclusion",None), ("id","1"), ("id",True), ("id",0)]:
            data = queue_fixture(); queue_listing(data)["workflow_runs"][0][field] = value
            self.assertFalse(prove_merge_group(H, data.__getitem__), (field, value))
            self.assertFalse(reuse(push_env(), data.__getitem__, fake_git(parents=(P,))), (field, value))
        data = queue_fixture(); queue_listing(data)["workflow_runs"].pop(); queue_listing(data)["total_count"] -= 1
        self.assertFalse(prove_merge_group(H, data.__getitem__), "a workflow without its merge_group run")
        data = queue_fixture(); queue_listing(data)["total_count"] += 1
        self.assertFalse(prove_merge_group(H, data.__getitem__), "a truncated listing")
        data = queue_fixture(); queue_listing(data)["total_count"] = True
        self.assertFalse(prove_merge_group(H, data.__getitem__), "a count that is not a number")
        self.assertFalse(prove_merge_group("--bad", queue_fixture().__getitem__))

    def test_every_expected_job_of_the_latest_attempt_must_be_green(self):
        from ci_full_tree_proof import prove_merge_group
        key = "actions/runs/501/jobs?filter=latest&per_page=100"
        for conclusion in ["skipped","failure","cancelled",None]:
            data = queue_fixture(); data[key]["jobs"][0]["conclusion"] = conclusion
            self.assertFalse(prove_merge_group(H, data.__getitem__), conclusion)
        for mutation in ["missing","duplicate","unstarted","extra"]:
            data = queue_fixture(); reply = data[key]
            if mutation == "missing": reply["jobs"].pop(); reply["total_count"] -= 1
            elif mutation == "duplicate": reply["jobs"][0] = copy.deepcopy(reply["jobs"][1])
            elif mutation == "unstarted": reply["jobs"][0]["started_at"] = None
            else: reply["jobs"].append(dict(reply["jobs"][0], name="Something else")); reply["total_count"] += 1
            self.assertFalse(prove_merge_group(H, data.__getitem__), mutation)
        # A newer run of the same workflow on the same SHA that failed, is still going or is unreadable wins.
        for later in [{"status":"in_progress","conclusion":None}, {"conclusion":"failure"}, {"id":"1000"}]:
            data = queue_fixture(); listing = queue_listing(data)
            newer = copy.deepcopy(listing["workflow_runs"][0]); newer.update({"id": 999, **later})
            listing["workflow_runs"].append(newer); listing["total_count"] += 1
            self.assertFalse(prove_merge_group(H, data.__getitem__), later)

    def test_unreadable_evidence_never_skips(self):
        def broken(path):
            raise ValueError("HTTP 403")
        self.assertFalse(reuse(push_env(), broken, fake_git(parents=(P,))))
        data = queue_fixture(); data["actions/runs/501/jobs?filter=latest&per_page=100"] = {"jobs": "nope"}
        self.assertFalse(reuse(push_env(), data.__getitem__, fake_git(parents=(P,))))
        self.assertFalse(reuse(push_env(), queue_fixture().__getitem__, fake_git(head="not-a-sha", parents=(P,))))

    def test_codeql_is_never_skipped(self):
        # With every proof available, CodeQL's own push run still runs for real.
        both = queue_fixture(); both.update(fixture())
        self.assertFalse(reuse(push_env("codeql"), both.__getitem__, fake_git(parents=(P, A), trees={"HEAD":T, A:T})))
        self.assertNotIn("codeql", WORKFLOWS)
        self.assertTrue(all("CodeQL" not in name for names in WORKFLOWS.values() for name in names))
        self.assertFalse(reuse(dict(push_env(), GITHUB_WORKFLOW_REF="other/marktmorgen/.github/workflows/product-checks.yml@refs/heads/main"),
                               both.__getitem__, fake_git(parents=(P,))), "a workflow of another repository")
        for ref in ["", REPO+"/.github/workflows/unknown.yml@refs/heads/main",
                    REPO+"/.github/workflows/product-checks.yml@refs/heads/feature"]:
            env = push_env(); env["GITHUB_WORKFLOW_REF"] = ref
            self.assertFalse(reuse(env, both.__getitem__, fake_git(parents=(P,))), ref)
        env = push_env(); del env["GITHUB_WORKFLOW_REF"]
        self.assertFalse(reuse(env, both.__getitem__, fake_git(parents=(P,))), "no workflow named")

    def test_schedule_dispatch_and_other_events_run_everything_even_with_both_proofs(self):
        both = queue_fixture(); both.update(fixture())
        for event in ("schedule", "workflow_dispatch", "merge_group", "pull_request", ""):
            self.assertFalse(reuse(push_env(event=event), both.__getitem__, fake_git(parents=(P,))), event)
        self.assertFalse(reuse(dict(push_env(), CI_REF="refs/heads/feature"), both.__getitem__, fake_git(parents=(P,))))

    def test_the_pull_request_proof_still_works_beside_it(self):
        # No merge_group run on the head; the PR proof of the identical tree stays as it was.
        data = fixture(); data["actions/runs?head_sha="+M+"&event=merge_group&per_page=100"] = {"total_count":0,"workflow_runs":[]}
        self.assertTrue(reuse(dict(push_env(), GITHUB_WORKFLOW_REF=REPO+"/.github/workflows/product-checks.yml@refs/heads/main"),
                              data.__getitem__, fake_git(head=M, parents=("d"*40, A), trees={"HEAD":T, A:T})))

class WorkflowSourceAndOrderTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / ".github/workflows/product-checks.yml"
        self.jobs = jobs_of(path.read_text(encoding="utf-8"))

    def test_mobile_driver_build_and_measurement_share_the_workflow_source(self):
        body = "\n".join(self.jobs["mobile-render"])
        matrix = body.split("        include:\n", 1)[1].split("    env:\n", 1)[0]
        # A PR head and its merge can have different UI contracts. The default
        # driver checkout is github.sha, so the built app must be that source too.
        self.assertEqual(re.findall(r"^\s+ref: (.+)$", matrix, re.MULTILINE), ["${{ github.sha }}"])
        self.assertNotIn("github.event.pull_request.head.sha", body)
        checkouts = body.split("      - uses: actions/checkout@")
        self.assertEqual(len(checkouts), 3)
        self.assertNotRegex(checkouts[1], r"(?m)^\s+ref:")
        self.assertIn("          ref: ${{ matrix.ref }}\n          path: measured-app", checkouts[2])
        self.assertIn("MOBILE_RENDER_SHA: ${{ matrix.ref }}", body)
        self.assertIn("run: node scripts/ci-build.mjs\n        working-directory: measured-app", body)
        self.assertIn("run: node tests/e2e/mobile-render.mjs measured-app", body)

    def test_actual_order_admission_waits_for_its_node_dependencies(self):
        steps = re.split(r"(?m)^      - ", "\n".join(self.jobs["form-opportunity-redis"]))[1:]
        order = [index for index, step in enumerate(steps) if step.startswith("name: Actual Redis order admission checks\n")]
        install = [index for index, step in enumerate(steps) if step.startswith("run: npm ci\n")]
        setup = [index for index, step in enumerate(steps) if step.startswith("uses: actions/setup-node@")]
        self.assertEqual([len(order), len(install), len(setup)], [1, 1, 1])
        self.assertLess(setup[0], install[0])
        self.assertLess(install[0], order[0])
        self.assertIn('MARKTMORGEN_REDIS_INTEGRATION: "1"', steps[order[0]])
        self.assertIn("run: python3 scripts/test_order_admission_redis.py", steps[order[0]])
        self.assertNotIn("\n        if:", steps[order[0]])
        self.assertNotIn("continue-on-error", steps[order[0]])

if __name__=="__main__":
    unittest.main()
