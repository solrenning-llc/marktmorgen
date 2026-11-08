"""Rules of the final check (scripts/ci_all_checks.py) and its place in every workflow."""
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ci_all_checks import decide, SCOPE  # noqa: E402
from ci_full_tree_proof import WORKFLOWS  # noqa: E402

ROOT = os.path.dirname(HERE)
WORKFLOW_DIR = os.path.join(ROOT, ".github", "workflows")
CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7"
# The one workflow that is not CI: the MV alarm (AGENTS.md) runs only after these complete on
# main, is never a required check and has no final check (tests/main-red-alarm.test.ts).
NOT_CI = {"main-red-alarm.yml", "stale-pr-report.yml"}


def scope(result="success", full="true"):
    return {"result": result, "outputs": {"full": full} if full is not None else {}}


class DecisionRules(unittest.TestCase):
    def test_every_job_succeeded_passes(self):
        self.assertEqual(decide({SCOPE: scope(), "verify": {"result": "success"},
                                 "cross-browser": {"result": "success"}}), (True, []))

    def test_documentation_only_skips_pass(self):
        self.assertTrue(decide({SCOPE: scope(full="false"), "verify": {"result": "skipped"},
                                "cross-browser": {"result": "skipped"}})[0])

    def test_any_failure_or_cancellation_fails(self):
        for result in ("failure", "cancelled", None, "", "neutral", "timed_out", "SUCCESS"):
            for full in ("true", "false"):
                with self.subTest(result=result, full=full):
                    self.assertFalse(decide({SCOPE: scope(full=full), "verify": {"result": "success"},
                                             "cross-browser": {"result": result}})[0])

    def test_skip_without_documentation_proof_fails(self):
        for full in ("true", "", None, "False", "no", "0"):
            with self.subTest(full=full):
                self.assertFalse(decide({SCOPE: scope(full=full), "verify": {"result": "skipped"}})[0])

    def test_documentation_scope_not_successful_fails_even_if_it_said_docs_only(self):
        for result in ("failure", "cancelled", "skipped", None):
            with self.subTest(result=result):
                self.assertFalse(decide({SCOPE: scope(result=result, full="false"),
                                         "verify": {"result": "skipped"}})[0])
                self.assertFalse(decide({SCOPE: scope(result=result, full="true"),
                                         "verify": {"result": "success"}})[0])

    def test_missing_or_malformed_context_fails(self):
        for needs in (None, [], "", {}, {SCOPE: scope()}, {"verify": {"result": "success"}},
                      {SCOPE: scope(), "verify": None}, {SCOPE: scope(), "verify": "success"},
                      {SCOPE: None, "verify": {"result": "success"}}):
            with self.subTest(needs=needs):
                self.assertFalse(decide(needs)[0])

    def test_command_exit_code_follows_the_decision(self):
        script = os.path.join(HERE, "ci_all_checks.py")
        cases = [({SCOPE: scope(), "verify": {"result": "success"}}, 0),
                 ({SCOPE: scope(), "verify": {"result": "failure"}}, 1),
                 ({SCOPE: scope(full="false"), "verify": {"result": "skipped"}}, 0),
                 ({SCOPE: scope(), "verify": {"result": "skipped"}}, 1)]
        for needs, code in cases:
            env = dict(os.environ, NEEDS=json.dumps(needs))
            self.assertEqual(subprocess.run([sys.executable, script], env=env, capture_output=True).returncode, code)
        for raw in ("", "not json", "null"):
            env = dict(os.environ, NEEDS=raw)
            self.assertEqual(subprocess.run([sys.executable, script], env=env, capture_output=True).returncode, 1)


def jobs_of(text):
    """Top-level jobs of a workflow file: {job id: its lines}."""
    lines = text.splitlines()
    start = lines.index("jobs:")
    jobs, current = {}, None
    for line in lines[start + 1:]:
        match = re.fullmatch(r"  ([A-Za-z0-9_-]+):\s*", line)
        if match:
            current = match.group(1)
            jobs[current] = []
        elif current is not None:
            if line and not line.startswith("  "):
                break
            jobs[current].append(line)
    return jobs


class EveryWorkflowEndsWithTheFinalCheck(unittest.TestCase):
    def test_each_workflow_has_one_final_check_that_reads_every_other_job(self):
        files = sorted(f for f in os.listdir(WORKFLOW_DIR) if f.endswith(".yml"))
        # Each non-CI workflow may land on its own PR; whichever exists is left out.
        files = [f for f in files if f not in NOT_CI]
        self.assertTrue(files)
        self.assertEqual({f[:-4] for f in files}, set(WORKFLOWS))
        for name in files:
            stem = name[:-4]
            with self.subTest(workflow=stem):
                with open(os.path.join(WORKFLOW_DIR, name), encoding="utf-8") as handle:
                    text = handle.read()
                jobs = jobs_of(text)
                self.assertIn(SCOPE, jobs)
                self.assertIn("all-checks", jobs)
                body = "\n".join(jobs["all-checks"])
                others = sorted(j for j in jobs if j != "all-checks")
                self.assertIn("    name: All checks (" + stem + ")\n", body + "\n")
                self.assertIn("    if: ${{ always() }}\n", body + "\n")
                self.assertIn("    needs: [" + ", ".join(others) + "]\n", body + "\n")
                self.assertIn("          NEEDS: ${{ toJSON(needs) }}\n", body + "\n")
                self.assertIn("python3 scripts/test_ci_all_checks.py", body)
                self.assertIn("python3 scripts/ci_all_checks.py", body)
                self.assertIn(CHECKOUT, body)
                for forbidden in ("continue-on-error", "strategy:", "matrix.", "|| true", "exit 0"):
                    self.assertNotIn(forbidden, body)
                # Only the final check may run regardless of the others.
                for job, job_lines in jobs.items():
                    if job != "all-checks":
                        self.assertNotIn("always()", "\n".join(job_lines))
                # The required check name must be unique across the repository.
                self.assertEqual(text.count("All checks ("), 1)

    def test_main_reuse_proof_expects_the_final_check(self):
        for workflow, names in WORKFLOWS.items():
            with self.subTest(workflow=workflow):
                self.assertIn("All checks (" + workflow + ")", names)


if __name__ == "__main__":
    unittest.main()
