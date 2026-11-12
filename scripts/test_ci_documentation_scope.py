"""Synthetic policy regressions; run by GitHub Actions, never provider traffic."""
import re
import unittest
from pathlib import Path
from ci_documentation_scope import (MERGE_GROUP_ONLY, changed_paths, deferred_to_merge_group,
                                    documentation_diff, documentation_path, harness_path, requires_full)

A = "a" * 40
B = "b" * 40
# The one workflow that is not CI: the MV alarm (AGENTS.md) runs only after the nine below
# complete on main and has no documentation scope (tests/main-red-alarm.test.ts).
NOT_CI = {"main-red-alarm.yml", "stale-pr-report.yml"}

# The cheap workflows that keep running every job on each pull request.
EVERY_EVENT = {"product-checks", "codeql", "dependency-security"}
FULL = "${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' }}"
DEFERRED = "${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' && needs.documentation-scope.outputs.deferred != 'true' }}"
PUBLIC_ONLY = ("(github.repository_id == '1334793724' || github.repository == 'viniciussucupira/marktmorgen')"
               " && github.event.repository.private == false && github.event.repository.visibility == 'public'")
# Each heavy job's one condition, word for word: the six accessibility workflows also skip on a
# pull request whose real run waits for the merge queue (the scope's "deferred" output).
CONDITIONS = {name: FULL for name in EVERY_EVENT}
CONDITIONS.update({"accessibility-" + key: DEFERRED for key in
                   ("buyer-actions", "product-actions", "public-matrix", "signup-actions", "studio-matrix")})
CONDITIONS["accessibility-real-readers"] = DEFERRED[:-3] + " && " + PUBLIC_ONLY + " }}"

def ci_workflows():
    paths = list(Path(".github/workflows").glob("*.yml"))
    return [p for p in paths if p.name not in NOT_CI]

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
        workflows = ci_workflows()
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
                self.assertEqual(conditions[0], "    if: " + CONDITIONS[path.stem], str(path))
                self.assertTrue(conditions[0].endswith(" }}"), str(path))
                self.assertNotIn("always()", conditions[0], str(path))

    def test_daily_and_manual_events_are_explicit_and_isolated(self):
        for path in ci_workflows():
            text = path.read_text(encoding="utf-8")
            prefix = text.split("jobs:\n", 1)[0]
            self.assertIn("  schedule:\n    - cron: '37 5 * * *'\n  workflow_dispatch:\n", prefix, str(path))
            self.assertIn("-${{ github.event_name }}", prefix, str(path))
            self.assertNotIn("paths-ignore", prefix, str(path))


def pr_change(*paths):
    return b"".join(change(p) for p in paths)

class MergeGroupOnlyTests(unittest.TestCase):
    """On a pull request the six accessibility workflows defer their heavy jobs to the merge queue,
    unless the change touches their own harness; nothing else is ever deferred."""

    def test_exactly_the_six_accessibility_workflows(self):
        self.assertEqual(MERGE_GROUP_ONLY, frozenset(CONDITIONS) - EVERY_EVENT)
        self.assertEqual(len(MERGE_GROUP_ONLY), 6)
        self.assertFalse(MERGE_GROUP_ONLY & EVERY_EVENT)

    def test_product_change_on_a_pull_request_is_deferred(self):
        raw = pr_change("app/page.tsx", "lib/plan.ts", "docs/notes.md", "components/x.tsx")
        self.assertTrue(deferred_to_merge_group(True, "pull_request", A, B, lambda *_: raw))

    def test_never_deferred_outside_a_pull_request_or_when_not_enabled(self):
        raw = pr_change("app/page.tsx")
        for event in ("merge_group", "push", "schedule", "workflow_dispatch", "", "pull_request_target",
                      "PULL_REQUEST", None):
            with self.subTest(event=event):
                self.assertFalse(deferred_to_merge_group(True, event, A, B, lambda *_: raw))
        for enabled in (False, None, "true", 1, "True"):
            with self.subTest(enabled=enabled):
                self.assertFalse(deferred_to_merge_group(enabled, "pull_request", A, B, lambda *_: raw))
        for base, head in (("", B), (A, ""), ("--help", B), (A, "HEAD")):
            self.assertFalse(deferred_to_merge_group(True, "pull_request", base, head, lambda *_: raw))

    def test_a_change_to_the_harness_runs_the_full_matrix_on_its_own_pull_request(self):
        for path in [".github/workflows/accessibility-public-matrix.yml", ".github/workflows/new.yml",
                     ".github/dependabot.yml", "tests/e2e/accessibility-buyer-actions.mjs",
                     "tests/e2e/services.mjs", "tests/e2e/seed.ts", "tests/next-link-world.tsx",
                     "tooling/screen-reader/entry-pilot.mjs", "tooling/screen-reader/package-lock.json",
                     "scripts/ci_all_checks.py", "scripts/ci_documentation_scope.py",
                     "scripts/ci_full_tree_proof.py", "scripts/test_ci_all_checks.py",
                     "scripts/test_ci_documentation_scope.py", "scripts/ci-build.mjs",
                     "package.json", "package-lock.json", "tsconfig.json"]:
            with self.subTest(path=path):
                self.assertTrue(harness_path(path))
                self.assertFalse(deferred_to_merge_group(True, "pull_request", A, B,
                                                         lambda *_: pr_change("app/page.tsx", path)))
        for path in ["app/page.tsx", "lib/plan.ts", "tests/plan.test.ts", "scripts/margin-alignment.mjs",
                     "scripts/test_public_data.py", "docs/ci.md", "README.md", "public/x.svg"]:
            with self.subTest(path=path):
                self.assertFalse(harness_path(path))

    def test_odd_paths_count_as_harness(self):
        for path in ["", "/", "../.github/workflows/x.yml", "./tests/e2e/x.mjs", "app//x.ts", "app/../.github/x"]:
            with self.subTest(path=path):
                self.assertTrue(harness_path(path))

    def test_deleted_renamed_or_retyped_harness_still_runs(self):
        for raw in [change(".github/workflows/x.yml", after="000000", status="D"),
                    change("tests/e2e/new.mjs", "000000", status="A"),
                    change("tooling/screen-reader/x", "100644", "120000", "T")]:
            self.assertFalse(deferred_to_merge_group(True, "pull_request", A, B, lambda *_: raw))

    def test_unreadable_empty_or_failed_diff_runs_the_full_matrix(self):
        for raw in [b"", None, change("app/a.ts")[:-1], b"bad\0", b"bad\0x\0", change("app/a.ts") + b"\xff\0",
                    change("app/a.ts", status="R100"), change("app/a.ts", status="C75"), change("app/a.ts", status="X"),
                    (":100644 100644 short short M\0app/a.ts\0").encode()]:
            with self.subTest(raw=raw):
                self.assertIsNone(changed_paths(raw))
                self.assertFalse(deferred_to_merge_group(True, "pull_request", A, B, lambda *_: raw))
        def failed(*_):
            raise OSError("unavailable history")
        self.assertFalse(deferred_to_merge_group(True, "pull_request", A, B, failed))
        self.assertEqual(changed_paths(pr_change("app/a.ts", "docs/b.md")), ["app/a.ts", "docs/b.md"])

    def test_every_file_the_six_workflows_run_is_harness(self):
        """Entry scripts, working directories and what the tests/ files they run read, transitively."""
        found, todo = set(), []
        for name in sorted(MERGE_GROUP_ONLY):
            text = Path(".github/workflows/" + name + ".yml").read_text(encoding="utf-8")
            found.add(".github/workflows/" + name + ".yml")
            for match in re.finditer(r"node ((?:tests|scripts)/[\w./-]+)", text):
                todo.append(match.group(1))
            for match in re.finditer(r"python3 (scripts/[\w./-]+)", text):
                todo.append(match.group(1))
            for match in re.finditer(r"working-directory: ([\w./-]+)", text):
                found.add(match.group(1) + "/x")
        self.assertIn("tests/e2e/accessibility-public-matrix.mjs", todo)
        while todo:
            path = todo.pop()
            if Path(path).is_dir():
                path += "/x"  # A folder a file reads: anything in it is harness.
            if path in found:
                continue
            found.add(path)
            if not path.startswith("tests/") or not Path(path).is_file():
                continue
            text = Path(path).read_text(encoding="utf-8")
            folder = str(Path(path).parent)
            refs = [folder + "/" + m.group(1)[2:] for m in re.finditer(r"""(?:from |import |require\()["'](\./[^"']+)["']""", text)]
            refs += [folder + "/" + m.group(1) for m in re.finditer(r"""join\(here, ?["']([^"']+)["']""", text)]
            refs += [m.group(1) for m in re.finditer(r"""join\(root, ?["'](tests/[^"']+)["']""", text)]
            refs += [m.group(1) for m in re.finditer(r"""["']@/(tests/[^"']+)["']""", text)]
            todo.extend(refs)
        self.assertIn("tests/next-link-world.tsx", found)
        self.assertIn("tests/e2e/services.mjs", found)
        self.assertEqual(sorted(p for p in found if not harness_path(p)), [])

if __name__ == "__main__":
    unittest.main()
