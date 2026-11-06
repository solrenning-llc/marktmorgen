"""Synthetic policy regressions; run by GitHub Actions, never provider traffic."""
import unittest
from pathlib import Path
from ci_documentation_scope import documentation_diff, documentation_path, requires_full

A = "a" * 40
B = "b" * 40

def change(path, before="100644", after="100644", status="M"):
    return (f":{before} {after} {A} {B} {status}\0{path}\0").encode()

class DocumentationScopeTests(unittest.TestCase):
    def test_markdown_add_modify_delete_and_unicode(self):
        raw = change("README.md") + change("docs/visão.md", "000000", status="A")
        raw += change("docs/old.md", after="000000", status="D")
        self.assertTrue(documentation_diff(raw))
        self.assertFalse(requires_full("pull_request", A, B, lambda *_: raw))

    def test_code_config_dependencies_and_policy_always_full(self):
        for path in ["app/page.tsx", "docs/example.py", "tests/notes.md",
                     "package-lock.json", ".github/workflows/ci.yml", "AGENTS.md",
                     "docs/AGENTS.md", "docs/SKILL.md", "scripts/README.md",
                     "docs/.config/readme.md", "docs/image.svg", "README.MD"]:
            with self.subTest(path=path):
                self.assertFalse(documentation_diff(change(path)))

    def test_mixed_change_and_renamed_code_cannot_hide(self):
        self.assertFalse(documentation_diff(change("docs/readme.md") + change("lib/old.ts", after="000000", status="D")))
        self.assertFalse(documentation_diff(change("docs/renamed.md", status="R100")))

    def test_symlink_executable_submodule_and_type_changes_full(self):
        for before, after, status in [("120000", "100644", "T"),
                                     ("100644", "120000", "T"),
                                     ("100755", "100755", "M"),
                                     ("160000", "160000", "M")]:
            self.assertFalse(documentation_diff(change("docs/readme.md", before, after, status)))

    def test_unknown_empty_truncated_and_invalid_encoding_full(self):
        for raw in [b"", change("README.md")[:-1], b"bad\0", b"bad\0x\0",
                    change("README.md") + b"\xff\0"]:
            with self.subTest(raw=raw):
                self.assertTrue(requires_full("pull_request", A, B, lambda *_: raw))

    def test_push_daily_manual_unknown_and_bad_refs_always_full(self):
        for event, base, head in [("push", A, B), ("schedule", A, B),
                                  ("workflow_dispatch", A, B), ("", A, B),
                                  ("pull_request", "", B), ("pull_request", "--help", B)]:
            self.assertTrue(requires_full(event, base, head, lambda *_: change("README.md")))

    def test_git_failure_cannot_skip(self):
        def failed(*_):
            raise OSError("unavailable history")
        self.assertTrue(requires_full("pull_request", A, B, failed))

    def test_special_names_are_data_not_commands(self):
        self.assertTrue(documentation_path("docs/space and newline\nname.md"))
        self.assertFalse(documentation_path("../README.md"))
        self.assertFalse(documentation_path("/README.md"))


    def test_workflow_conditions_stay_inside_jobs_and_are_unique(self):
        names = set()
        workflows = list(Path(".github/workflows").glob("*.yml"))
        self.assertEqual(len(workflows), 9)
        for path in workflows:
            text = path.read_text(encoding="utf-8")
            prefix, jobs = text.split("jobs:\n", 1)
            self.assertNotIn("needs:", prefix, str(path))
            self.assertNotIn("    if:", prefix, str(path))
            self.assertIn("  documentation-scope:\n", jobs)
            scope_name = next(line.strip() for line in jobs.splitlines() if line.startswith("    name: Documentation scope"))
            self.assertNotIn(scope_name, names)
            names.add(scope_name)
            # Each existing heavy job has exactly one gate and condition.
            parts = __import__("re").split(r"(?m)^  ([a-z][a-z0-9-]*):\n", jobs)
            named = list(zip(parts[1::2], parts[2::2]))
            self.assertEqual(named[0][0], "documentation-scope", str(path))
            # The final check is the last job; its own rules (always runs, reads every job)
            # are held by scripts/test_ci_all_checks.py. Every job between keeps the rules below.
            self.assertEqual(named[-1][0], "all-checks", str(path))
            chunks = [body for _, body in named[1:-1]]
            self.assertTrue(chunks, str(path))
            for chunk in chunks:
                self.assertEqual(chunk.count("    needs: documentation-scope\n"), 1)
                conditions = [line for line in chunk.splitlines() if line.startswith("    if:")]
                self.assertEqual(len(conditions), 1, str(path))
                self.assertIn("${{ !cancelled() && needs.documentation-scope.outputs.full != 'false'", conditions[0])
                self.assertTrue(conditions[0].endswith(" }}"), str(path))
                self.assertNotIn("always()", conditions[0], str(path))

    def test_daily_and_manual_events_are_explicit_and_isolated(self):
        for path in Path(".github/workflows").glob("*.yml"):
            text = path.read_text(encoding="utf-8")
            prefix = text.split("jobs:\n", 1)[0]
            self.assertIn("  schedule:\n    - cron: '37 5 * * *'\n  workflow_dispatch:\n", prefix, str(path))
            self.assertIn("-${{ github.event_name }}", prefix, str(path))
            self.assertNotIn("paths-ignore", prefix, str(path))

if __name__ == "__main__":
    unittest.main()
