"""Synthetic policy regressions; run by GitHub Actions, never provider traffic."""
import subprocess
import unittest
from pathlib import Path
from ci_documentation_scope import decide, documentation_diff, documentation_path, requires_full
from ci_full_tree_proof import REPO, REPO_ID

A = "a" * 40
B = "b" * 40
# The one workflow that is not CI: the MV alarm (AGENTS.md) runs only after the nine below
# complete on main and has no documentation scope (tests/main-red-alarm.test.ts).
NOT_CI = {"main-red-alarm.yml", "stale-pr-report.yml"}

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
                     "app/README.md", "lib/notes.md", "public/notes.md", "cli/README.md",
                     "components/x/README.md", "docs/tests/notes.md", "docs/data.json",
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
            self.assertTrue(named[1:-1], str(path))
            # The scope publishes both decisions and reads the inputs of every event it can classify.
            scope = named[0][1]
            for line in ["      full: ${{ steps.scope.outputs.full }}", "      docs: ${{ steps.scope.outputs.docs }}",
                         "          CI_BASE: ${{ github.event.pull_request.base.sha }}",
                         "          CI_HEAD: ${{ github.event.pull_request.head.sha }}",
                         "          CI_GROUP_HEAD: ${{ github.event.merge_group.head_sha }}",
                         "          CI_BEFORE: ${{ github.event.before }}",
                         "          CI_SHA: ${{ github.sha }}",
                         "          CI_TOKEN: ${{ github.token }}",
                         "      # Documentation-only allowlist (scripts/ci_documentation_scope.py documentation_path): regular,"]:
                self.assertIn(line + "\n", scope, str(path))
            self.assertEqual(text.count("documentation-tests"), 2 if path.name == "product-checks.yml" else 0, str(path))
            for job, chunk in named[1:-1]:
                self.assertEqual(chunk.count("    needs: documentation-scope\n"), 1)
                conditions = [line for line in chunk.splitlines() if line.startswith("    if:")]
                self.assertEqual(len(conditions), 1, str(path))
                if job == "documentation-tests":
                    # The one job that runs only in documentation mode, only in product-checks.
                    self.assertEqual(path.name, "product-checks.yml")
                    self.assertEqual(conditions[0], "    if: ${{ !cancelled() && needs.documentation-scope.outputs.docs == 'true' }}")
                    self.assertIn("run: node tests/run.mjs --documentation-readers\n", chunk)
                    continue
                self.assertIn("${{ !cancelled() && needs.documentation-scope.outputs.full != 'false'", conditions[0])
                self.assertTrue(conditions[0].endswith(" }}"), str(path))
                self.assertNotIn("always()", conditions[0], str(path))

    def test_daily_and_manual_events_are_explicit_and_isolated(self):
        for path in ci_workflows():
            text = path.read_text(encoding="utf-8")
            prefix = text.split("jobs:\n", 1)[0]
            self.assertIn("  schedule:\n    - cron: '37 5 * * *'\n  workflow_dispatch:\n", prefix, str(path))
            self.assertIn("-${{ github.event_name }}", prefix, str(path))
            self.assertNotIn("paths-ignore", prefix, str(path))


H, P, Q, C = "c" * 40, "d" * 40, "e" * 40, "f" * 40
QUEUE_REF = "refs/heads/gh-readonly-queue/main/pr-3584-" + P
WF = ".github/workflows/product-checks.yml"
DOCS = change("docs/codex-queue.md") + change("README.md")
MIXED = change("docs/codex-queue.md") + change("lib/plan.ts")
WORKFLOW = change("docs/codex-queue.md") + change(".github/workflows/product-checks.yml")
DIFFS = {"docs": DOCS, "mixed": MIXED, "workflow": WORKFLOW, "empty": b""}
ALLGREEN = [{"type": "required_status_checks", "parameters": {}},
            {"type": "merge_queue", "parameters": {"grouping_strategy": "ALLGREEN"}}]


def fake_git(head=H, parents=(P, Q), ancestor=True):
    def git(*args):
        if args == ("rev-parse", "HEAD"):
            return head
        if args[:3] == ("rev-list", "--parents", "-n"):
            return " ".join((args[4],) + tuple(parents))
        if args[:2] == ("merge-base", "--is-ancestor"):
            if not ancestor:
                raise subprocess.CalledProcessError(1, "git")
            return ""
        raise AssertionError(args)
    return git


def diff_of(kind, expect_base):
    def diff(base, head):
        if base != expect_base:
            raise AssertionError("diffed against " + base)
        return DIFFS[kind]
    return diff


def api_of(replies):
    def api(path):
        if path not in replies:
            raise ValueError("unreadable " + path)
        return replies[path]
    return api


def never_reused():
    return False


def queue_env(**extra):
    env = {"CI_EVENT": "merge_group", "CI_REPOSITORY": REPO, "CI_REF": QUEUE_REF, "CI_GROUP_HEAD": H}
    env.update(extra)
    return env


def run(id_, event="push", conclusion="success", status="completed", branch="main", sha=B, path=WF, **extra):
    r = {"id": id_, "event": event, "status": status, "conclusion": conclusion, "head_branch": branch,
         "head_sha": sha, "path": path, "repository": {"id": REPO_ID}, "head_repository": {"id": REPO_ID},
         "updated_at": "2026-11-12T05:00:30Z"}
    r.update(extra)
    return r


def push_env(workflow="product-checks", **extra):
    env = {"CI_EVENT": "push", "CI_REF": "refs/heads/main", "CI_REPOSITORY": REPO, "CI_BEFORE": B,
           "CI_SHA": H, "GITHUB_RUN_ID": "900",
           "GITHUB_WORKFLOW_REF": REPO + "/.github/workflows/" + workflow + ".yml@refs/heads/main"}
    env.update(extra)
    return env


def push_replies(runs, jobs=None, current_created="2026-11-12T05:00:00Z"):
    replies = {"actions/runs?head_sha=" + B + "&per_page=100": {"total_count": len(runs), "workflow_runs": runs},
               "actions/runs/900": {"id": 900, "path": WF, "event": "push", "created_at": current_created}}
    for id_, listed in (jobs or {}).items():
        replies["actions/runs/" + str(id_) + "/jobs?filter=latest&per_page=100"] = {"total_count": len(listed), "jobs": listed}
    return replies


class DecisionDryRun(unittest.TestCase):
    """The detection, end to end on synthetic git and GitHub replies: docs-only, mixed,
    workflow-touching and empty diffs, for every event the workflows receive."""

    def test_pull_request(self):
        for kind, mode in [("docs", "documentation"), ("mixed", "full"), ("workflow", "full"), ("empty", "full")]:
            with self.subTest(kind=kind):
                env = {"CI_EVENT": "pull_request", "CI_BASE": A, "CI_HEAD": B}
                self.assertEqual(decide(env, fake_git(), diff_of(kind, A), api_of({}), never_reused), mode)

    def test_merge_group_entry_against_its_first_parent(self):
        for kind, mode in [("docs", "documentation"), ("mixed", "full"), ("workflow", "full"), ("empty", "full")]:
            with self.subTest(kind=kind):
                api = api_of({"rules/branches/main?per_page=100": ALLGREEN})
                self.assertEqual(decide(queue_env(), fake_git(), diff_of(kind, P), api, never_reused), mode)

    def test_merge_group_needs_allgreen_read_now(self):
        for rules in [[{"type": "merge_queue", "parameters": {"grouping_strategy": "HEADGREEN"}}],
                      ALLGREEN + [{"type": "merge_queue", "parameters": {"grouping_strategy": "HEADGREEN"}}],
                      [{"type": "merge_queue", "parameters": {}}], [{"type": "required_status_checks"}],
                      [], {"message": "Not Found"}, None]:
            with self.subTest(rules=rules):
                api = api_of({"rules/branches/main?per_page=100": rules})
                self.assertEqual(decide(queue_env(), fake_git(), diff_of("docs", P), api, never_reused), "full")
        self.assertEqual(decide(queue_env(), fake_git(), diff_of("docs", P), api_of({}), never_reused), "full")

    def test_merge_group_shape_ref_and_repository(self):
        api = api_of({"rules/branches/main?per_page=100": ALLGREEN})
        cases = [(queue_env(), fake_git(parents=(P,))),            # squash or rebase: one parent
                 (queue_env(), fake_git(parents=(P, Q, C))),       # octopus
                 (queue_env(), fake_git(head=C)),                  # checkout is not the group's head
                 (queue_env(CI_GROUP_HEAD=""), fake_git()),
                 (queue_env(CI_GROUP_HEAD="--help"), fake_git()),
                 (queue_env(CI_REF="refs/heads/main"), fake_git()),
                 (queue_env(CI_REF="refs/heads/gh-readonly-queue/other/pr-1-" + P), fake_git()),
                 (queue_env(CI_REPOSITORY="someone/marktmorgen"), fake_git())]
        for env, git in cases:
            with self.subTest(env=env):
                self.assertEqual(decide(env, git, diff_of("docs", P), api, never_reused), "full")

    def test_push_reuses_the_identical_code_first(self):
        self.assertEqual(decide(push_env(), fake_git(), diff_of("mixed", B), api_of({}), lambda: True), "reused")

    def test_push_documentation_only_when_the_previous_head_is_green(self):
        green = push_replies([run(10), run(5, event="merge_group", branch="gh-readonly-queue/main/pr-1-" + P)])
        for kind, mode in [("docs", "documentation"), ("mixed", "full"), ("workflow", "full"), ("empty", "full")]:
            with self.subTest(kind=kind):
                self.assertEqual(decide(push_env(), fake_git(), diff_of(kind, B), api_of(green), never_reused), mode)

    def test_push_previous_head_red_running_or_unknown_runs_everything(self):
        queue_green = run(5, event="merge_group", branch="gh-readonly-queue/main/pr-1-" + P)
        for runs in [[run(10, conclusion="failure"), queue_green],
                     [run(10, conclusion="timed_out"), queue_green],
                     [run(10, conclusion="startup_failure"), queue_green],
                     [run(10, status="in_progress", conclusion=None), queue_green],
                     [run(10), run(11, event="schedule", conclusion="failure"), queue_green],
                     [run(10, conclusion="neutral"), queue_green],
                     [run(5, event="merge_group", branch="gh-readonly-queue/main/pr-1-" + P, conclusion="failure")],
                     [run(5, event="merge_group", branch="feature", conclusion="success")],
                     [],
                     [run(10, path=".github/workflows/codeql.yml")],
                     [run(10, repository={"id": 1})]]:
            with self.subTest(runs=runs):
                self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(push_replies(runs)), never_reused), "full")

    def test_push_canceled_previous_run_counts_only_when_superseded_without_red(self):
        queue_green = run(5, event="merge_group", branch="gh-readonly-queue/main/pr-1-" + P)
        canceled = run(10, conclusion="cancelled")
        stopped = [{"name": "verify", "conclusion": "cancelled"}, {"name": "All checks (product-checks)", "conclusion": "failure"}]
        # Superseded by this push before it ended, no failed job: the queue's green on that head decides.
        replies = push_replies([canceled, queue_green], {10: stopped})
        self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(replies), never_reused), "documentation")
        for jobs, created in [([{"name": "verify", "conclusion": "failure"}], "2026-11-12T05:00:00Z"),
                              ([{"name": "verify", "conclusion": "timed_out"}], "2026-11-12T05:00:00Z"),
                              (stopped, "2026-11-12T05:01:00Z")]:  # this push began after it ended
            with self.subTest(jobs=jobs, created=created):
                replies = push_replies([canceled, queue_green], {10: jobs}, created)
                self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(replies), never_reused), "full")
        # No push run there yet, the queue's green decides; no green there: everything runs.
        self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(push_replies([queue_green])), never_reused), "documentation")
        replies = push_replies([canceled], {10: stopped})
        self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(replies), never_reused), "full")

    def test_push_codeql_wrong_ref_history_or_listing_runs_everything(self):
        green = push_replies([run(10)])
        cases = [(push_env(workflow="codeql"), fake_git()),
                 (push_env(CI_REF="refs/heads/other"), fake_git()),
                 (push_env(CI_BEFORE="0" * 40), fake_git(ancestor=False)),
                 (push_env(CI_BEFORE=""), fake_git()),
                 (push_env(GITHUB_RUN_ID=""), fake_git()),
                 (push_env(), fake_git(head=C)),
                 (push_env(), fake_git(ancestor=False))]
        for env, git in cases:
            with self.subTest(env=env):
                self.assertEqual(decide(env, git, diff_of("docs", B), api_of(green), never_reused), "full")
        truncated = push_replies([run(10)])
        truncated["actions/runs?head_sha=" + B + "&per_page=100"]["total_count"] = 2
        self.assertEqual(decide(push_env(), fake_git(), diff_of("docs", B), api_of(truncated), never_reused), "full")

    def test_daily_manual_and_unknown_events_always_full(self):
        for event in ["schedule", "workflow_dispatch", "pull_request_target", "", "merge_group "]:
            with self.subTest(event=event):
                env = dict(push_env(), CI_EVENT=event, CI_BASE=A, CI_HEAD=B)
                api = api_of(dict(push_replies([run(10)]), **{"rules/branches/main?per_page=100": ALLGREEN}))
                self.assertEqual(decide(env, fake_git(), lambda *_: DOCS, api, lambda: True), "full")

    def test_git_failure_cannot_skip(self):
        def broken(*args):
            raise subprocess.SubprocessError("no history")
        api = api_of({"rules/branches/main?per_page=100": ALLGREEN})
        self.assertEqual(decide(queue_env(), broken, diff_of("docs", P), api, never_reused), "full")
        self.assertEqual(decide(push_env(), broken, diff_of("docs", B), api_of(push_replies([run(10)])), never_reused), "full")


if __name__ == "__main__":
    unittest.main()
