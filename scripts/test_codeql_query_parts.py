"""Rules of the CodeQL query parts (scripts/codeql_query_parts.py) and their place in codeql.yml."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from codeql_query_parts import LISTED, PARTS, SUITE, check, config, listed_ids  # noqa: E402

ROOT = os.path.dirname(HERE)
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "codeql.yml")
OTHER = ["js/clear-text-cookie", "js/cors-permissive-configuration", "js/prototype-pollution"]


def sarif(ids, category="/language:javascript-typescript/", runs=1):
    run = {
        "tool": {
            "driver": {"name": "CodeQL", "rules": []},
            "extensions": [{"name": "codeql/javascript-queries", "rules": [{"id": i} for i in ids]}],
        },
        "automationDetails": {"id": category},
        "results": [],
    }
    return {"version": "2.1.0", "runs": [run] * runs}


class Partition(unittest.TestCase):
    def test_parts_are_disjoint_named_ids(self):
        ids = listed_ids()
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(PARTS, len(LISTED) + 1)
        for query in ids:
            self.assertRegex(query, r"^js/[a-z0-9/-]+$")
        for part in LISTED:
            self.assertTrue(part)

    def test_listed_parts_include_only_their_ids(self):
        for n in range(1, PARTS):
            self.assertEqual(config(n), {
                "queries": [{"uses": SUITE}],
                "query-filters": [{"include": {"id": list(LISTED[n - 1])}}],
            })

    def test_last_part_is_the_whole_suite_minus_the_listed_ids(self):
        self.assertEqual(config(PARTS), {
            "queries": [{"uses": SUITE}],
            "query-filters": [{"exclude": {"id": listed_ids()}}],
        })

    def test_no_other_part_number(self):
        for bad in (0, PARTS + 1, -1, True, "1", None):
            with self.assertRaises(ValueError):
                config(bad)


class Check(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def write(self, parts):
        for n, content in parts.items():
            with open(os.path.join(self.dir, "javascript-part-%d.sarif" % n), "w", encoding="utf-8") as handle:
                json.dump(content, handle)

    def good(self):
        parts = {n: sarif(LISTED[n - 1]) for n in range(1, PARTS)}
        parts[PARTS] = sarif(OTHER + ["js/summary/lines-of-code"])
        return parts

    def test_complete_parts_pass(self):
        self.write(self.good())
        self.assertEqual(check(self.dir), [])

    def test_summary_queries_in_every_part_pass(self):
        parts = self.good()
        for n in range(1, PARTS):
            parts[n] = sarif(list(LISTED[n - 1]) + ["js/summary/lines-of-code"])
        self.write(parts)
        self.assertEqual(check(self.dir), [])

    def test_missing_part_fails(self):
        parts = self.good()
        del parts[2]
        self.write(parts)
        self.assertTrue(check(self.dir))

    def test_extra_file_fails(self):
        parts = self.good()
        parts[PARTS + 1] = sarif(OTHER)
        self.write(parts)
        self.assertTrue(check(self.dir))

    def test_listed_query_not_evaluated_fails(self):
        parts = self.good()
        parts[1] = sarif(LISTED[0][1:])
        self.write(parts)
        self.assertTrue(any(LISTED[0][0] in p for p in check(self.dir)))

    def test_query_of_another_part_fails(self):
        parts = self.good()
        parts[1] = sarif(list(LISTED[0]) + [LISTED[1][0]])
        self.write(parts)
        self.assertTrue(check(self.dir))

    def test_listed_query_in_last_part_fails(self):
        parts = self.good()
        parts[PARTS] = sarif(OTHER + [LISTED[2][0]])
        self.write(parts)
        self.assertTrue(check(self.dir))

    def test_empty_last_part_fails(self):
        parts = self.good()
        parts[PARTS] = sarif([])
        self.write(parts)
        self.assertTrue(check(self.dir))

    def test_wrong_category_or_several_runs_fail(self):
        for bad in (sarif(LISTED[0], category="/language:actions/"), sarif(LISTED[0], runs=2), {"runs": []}):
            with self.subTest(bad=bad):
                parts = self.good()
                parts[1] = bad
                self.write(parts)
                self.assertTrue(check(self.dir))

    def test_unreadable_file_fails(self):
        self.write(self.good())
        with open(os.path.join(self.dir, "javascript-part-1.sarif"), "w", encoding="utf-8") as handle:
            handle.write("not json")
        self.assertTrue(check(self.dir))

    def test_missing_directory_fails(self):
        self.assertTrue(check(os.path.join(self.dir, "absent")))

    def test_command_exit_codes(self):
        script = os.path.join(HERE, "codeql_query_parts.py")
        self.write(self.good())
        self.assertEqual(subprocess.run([sys.executable, script, "check", self.dir], capture_output=True).returncode, 0)
        os.remove(os.path.join(self.dir, "javascript-part-1.sarif"))
        self.assertEqual(subprocess.run([sys.executable, script, "check", self.dir], capture_output=True).returncode, 1)
        out = subprocess.run([sys.executable, script, "config", "1"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0)
        self.assertEqual(json.loads(out.stdout.strip()[len("config="):]), config(1))
        self.assertEqual(subprocess.run([sys.executable, script, "config", "9"], capture_output=True).returncode, 2)


class Workflow(unittest.TestCase):
    def setUp(self):
        with open(WORKFLOW, encoding="utf-8") as handle:
            self.text = handle.read()

    def test_one_matrix_entry_per_part(self):
        self.assertIn("        part: [" + ", ".join(str(n) for n in range(1, PARTS + 1)) + "]\n", self.text)

    def test_every_part_runs_the_suite_through_its_config_and_never_uploads_alone(self):
        self.assertIn("python3 scripts/codeql_query_parts.py config ${{ matrix.part }}", self.text)
        self.assertIn("config: ${{ steps.part.outputs.config }}", self.text)
        self.assertIn("upload: never", self.text)
        self.assertNotIn("paths-ignore", self.text)
        self.assertNotIn("continue-on-error", self.text)

    def test_the_merged_upload_keeps_the_job_and_category_of_one_analysis(self):
        # Code scanning keys an analysis by the job (analyze) and its matrix ({"language": ...});
        # keeping both means the merged upload continues the existing configuration.
        jobs = re.findall(r"^  ([A-Za-z0-9_-]+):\s*$", self.text.split("\njobs:\n")[1], re.M)
        self.assertIn("analyze", jobs)
        self.assertIn("        language: [javascript-typescript, actions]\n", self.text)
        self.assertEqual(self.text.count("github/codeql-action/upload-sarif@"), 1)
        self.assertIn("category: /language:javascript-typescript\n", self.text)
        self.assertIn("python3 scripts/codeql_query_parts.py check ../codeql-parts", self.text)
        self.assertIn("PARTS_RESULT: ${{ needs.analyze-part.result }}", self.text)


if __name__ == "__main__":
    unittest.main()
