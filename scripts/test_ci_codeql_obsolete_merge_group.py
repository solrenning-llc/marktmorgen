"""Regression tests for the narrow CodeQL merge-group upload fallback."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ci_codeql_obsolete_merge_group import is_retired_group_upload_failure  # noqa: E402


QUEUE_REF = "refs/heads/gh-readonly-queue/main/pr-123-" + "a" * 40


class RetiredMergeGroupRules(unittest.TestCase):
    def test_missing_ref_after_sarif_generation_is_the_only_ignored_case(self):
        self.assertTrue(is_retired_group_upload_failure("merge_group", QUEUE_REF, True, 2))

    def test_existing_ref_keeps_the_codeql_failure(self):
        self.assertFalse(is_retired_group_upload_failure("merge_group", QUEUE_REF, True, 0))

    def test_missing_ref_without_completed_sarif_keeps_the_failure(self):
        self.assertFalse(is_retired_group_upload_failure("merge_group", QUEUE_REF, False, 2))

    def test_probe_errors_keep_the_failure(self):
        for status in (1, 128, 255):
            with self.subTest(status=status):
                self.assertFalse(is_retired_group_upload_failure("merge_group", QUEUE_REF, True, status))

    def test_non_queue_refs_and_other_events_keep_the_failure(self):
        self.assertFalse(is_retired_group_upload_failure("merge_group", "refs/heads/main", True, 2))
        self.assertFalse(is_retired_group_upload_failure("push", QUEUE_REF, True, 2))

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
