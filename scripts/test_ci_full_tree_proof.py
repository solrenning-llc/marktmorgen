import copy
import unittest
import os
import re
from pathlib import Path
from unittest.mock import patch
from ci_full_tree_proof import WORKFLOWS, REPO, REPO_ID, ORIGINAL_REPO, current_repo, prove_full_tree, can_reuse_main
from test_ci_all_checks import jobs_of
A, T, M = "a"*40, "b"*40, "c"*40

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
