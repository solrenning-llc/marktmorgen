"""Regression tests for the narrow CodeQL merge-group upload fallback."""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ci_codeql_obsolete_merge_group as policy  # noqa: E402


QUEUE_REF = "refs/heads/gh-readonly-queue/main/pr-123-" + "a" * 40


class RetiredMergeGroupRules(unittest.TestCase):
    def invoke_main(self, event, ref, probe_status, sarif=True):
        with tempfile.TemporaryDirectory() as directory:
            if sarif:
                with open(os.path.join(directory, "result.sarif"), "w", encoding="utf-8") as f:
                    f.write("{}")
            env = {
                "CI_EVENT": event,
                "CI_REF": ref,
                "CODEQL_SARIF_OUTPUT": directory if sarif else "",
            }
            completed = policy.subprocess.CompletedProcess(args=[], returncode=probe_status)
            with patch.dict(os.environ, env), patch.object(policy.subprocess, "run", return_value=completed):
                return policy.main()

    def test_missing_ref_after_sarif_generation_is_the_only_ignored_case(self):
        self.assertEqual(self.invoke_main("merge_group", QUEUE_REF, 2), 0)

    def test_existing_ref_keeps_the_codeql_failure(self):
        self.assertEqual(self.invoke_main("merge_group", QUEUE_REF, 0), 1)

    def test_missing_ref_without_completed_sarif_keeps_the_failure(self):
        self.assertEqual(self.invoke_main("merge_group", QUEUE_REF, 2, sarif=False), 1)

    def test_probe_errors_keep_the_failure(self):
        for status in (1, 128, 255):
            with self.subTest(status=status):
                self.assertEqual(self.invoke_main("merge_group", QUEUE_REF, status), 1)

    def test_non_queue_refs_and_other_events_keep_the_failure(self):
        self.assertEqual(self.invoke_main("merge_group", "refs/heads/main", 2), 1)
        self.assertEqual(self.invoke_main("push", QUEUE_REF, 2), 1)

    def test_main_push_still_runs_codeql_and_active_analysis_has_no_event_skip(self):
        with open(os.path.join(os.path.dirname(HERE), ".github", "workflows", "codeql.yml"), encoding="utf-8") as f:
            workflow = f.read()
        self.assertRegex(workflow, r"\n  push:\n    branches: \[main\]\n")
        self.assertRegex(workflow, r"continue-on-error: \$\{\{ github\.event_name == 'merge_group' \}\}")
        self.assertRegex(
            workflow,
            r"if: \$\{\{ github\.event_name == 'merge_group' && steps\.codeql_analyze\.outcome == 'failure' \}\}",
        )
        analyze_job = workflow.split("\n  analyze:\n", 1)[1].split("\n  all-checks:\n", 1)[0]
        self.assertNotRegex(analyze_job, r"(?m)^    if:.*github\.event_name")


if __name__ == "__main__":
    unittest.main()
