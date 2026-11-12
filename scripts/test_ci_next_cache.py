"""Rules of the build cache in CI: it only makes a build faster, never replaces one.

- What is cached is only TypeScript's incremental record (`.next/cache/.tsbuildinfo`): never the
  built app, Turbopack's cache, the fetch cache, or the preview and Server Actions keys, which
  every build still makes for itself. Every CI job keeps running the same full build
  (scripts/ci-build.mjs); the restore sits right before it and is the only change.
- A CI job reads only the record of its own base commit: the first parent of the commit it checked
  out (main for a pull request's merge commit or a merge group; on main, the previous commit). No
  fallback to an older record, which was measured to save nothing after a day of merges.
- Records are written only by .github/workflows/next-build-cache.yml, on a push to main (or a
  manual run on main), right after its build, one job per place a CI build runs (the Linux runner,
  the Playwright container image, and the Windows and macOS runners of the real-reader job, which
  like that job run only in the public repository). Pull requests and merge groups never write one.
- Where a workflow builds Next once per run (a `Next build (...)` job) and shares it with its
  browser jobs, the record is read in that build job; a job that only unpacks the shared build
  reads none, since it builds nothing.
- Every cache action is pinned by its full commit, like every other action here.
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORKFLOW_DIR = os.path.join(os.path.dirname(HERE), ".github", "workflows")
WRITER = "next-build-cache.yml"
RESTORE = "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0"
SAVE = "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0"
BUILD = "node scripts/ci-build.mjs"
PATH = ".next/cache/.tsbuildinfo"
PREFIX = "next-tsbuildinfo-v1-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-"
BASE_KEY = PREFIX + "${{ steps.base.outputs.sha }}"
# The first parent of the checked-out commit, read from the commit itself (a shallow checkout has
# the commit but not its parent); anything but a full commit id becomes "none", which is never saved.
BASE_SCRIPT = "\n".join([
    "base=$(git cat-file -p HEAD 2>/dev/null | sed -n '/^$/q;s/^parent //p' | head -n 1) || base=none",
    'case "$base" in *[!0-9a-f]*|"") base=none ;; esac',
    '[ "${#base}" -eq 40 ] || base=none',
    'echo "sha=$base" >> "$GITHUB_OUTPUT"',
])
OWN_KEY = PREFIX + "${{ github.sha }}"
TIMEOUT = {"SEGMENT_DOWNLOAD_TIMEOUT_MINS": '"1"'}
MAIN = "${{ github.ref == 'refs/heads/main' }}"
# The real-reader job's own guard (accessibility-real-readers.yml): its runners exist only there.
PUBLIC = ("(github.repository_id == '1334793724' || github.repository == 'viniciussucupira/marktmorgen')"
          " && github.event.repository.private == false && github.event.repository.visibility == 'public'")
MAIN_PUBLIC = "${{ github.ref == 'refs/heads/main' && " + PUBLIC + " }}"
LINUX = "ubuntu-latest"


class Job(list):
    """A job's steps (dicts of their keys, `with` and `env` as dicts) and its job-level keys."""
    def __init__(self):
        super().__init__()
        self.keys = {}
        self.raw = []


def jobs_of(text):
    """{job id: Job}. Reads the workflow layout every file here uses (two-space indents)."""
    lines = text.splitlines()
    jobs, job = {}, None
    for line in lines[lines.index("jobs:") + 1:]:
        match = re.fullmatch(r"  ([A-Za-z0-9_-]+):\s*", line)
        if match:
            job = jobs[match.group(1)] = Job()
            continue
        if line and not line.startswith(" "):
            break
        if job is None:
            continue
        top = re.fullmatch(r"    ([A-Za-z0-9_-]+):\s*(.*)", line)
        if top:
            job.keys[top.group(1)] = top.group(2)
        elif line.startswith("      image: "):
            job.keys["image"] = line.split(": ", 1)[1]
        elif re.fullmatch(r"        os: \[[^\]]*\]\s*", line):
            job.keys["matrix.os"] = [os.strip() for os in line.split("[", 1)[1].split("]")[0].split(",")]
        elif line.startswith("      - "):
            job.raw.append([line])
        elif job.raw and (line.startswith("        ") or not line.strip()):
            job.raw[-1].append(line)
    for job in jobs.values():
        for lines_of_step in job.raw:
            step, section, block = {}, None, None
            for raw in (line[8:] for line in lines_of_step):
                if block is not None and raw.startswith("  "):
                    # A literal block ("run: |"): its lines without the block's indentation.
                    step[block] += ("\n" if step[block] else "") + raw[2:]
                    continue
                block = None
                if not raw.strip() or raw.lstrip().startswith("#"):
                    continue
                if not raw.startswith(" "):
                    key, _, value = raw.partition(":")
                    section = step.setdefault(key, {}) if key in ("with", "env") else None
                    if section is None:
                        step[key] = value.strip()
                        if step[key] == "|":
                            step[key], block = "", key
                elif section is not None:
                    key, _, value = raw.strip().partition(":")
                    section[key] = value.strip()
            job.append(step)
    return jobs


def workflows():
    found = {}
    for name in sorted(os.listdir(WORKFLOW_DIR)):
        if name.endswith(".yml"):
            with open(os.path.join(WORKFLOW_DIR, name), encoding="utf-8") as handle:
                found[name] = handle.read()
    return found


def places(job):
    """Where a job's build runs: its container image, or else each runner it runs on."""
    if "image" in job.keys:
        return {job.keys["image"]}
    runs_on = job.keys.get("runs-on")
    if runs_on == "${{ matrix.os }}":
        return set(job.keys["matrix.os"])
    return {runs_on}


class BuildCacheRules(unittest.TestCase):
    def test_parser_reads_steps_and_places(self):
        text = ("jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: x:1\n    steps:\n"
                "      - name: Restore\n        uses: " + RESTORE + "\n        with:\n          path: p\n"
                "          key: k\n      - run: " + BUILD + "\n")
        job = jobs_of(text)["a"]
        self.assertEqual([s.get("uses") for s in job], [RESTORE, None])
        self.assertEqual(job[0]["with"], {"path": "p", "key": "k"})
        self.assertEqual(job[1]["run"], BUILD)
        self.assertEqual(places(job), {"x:1"})
        matrix = jobs_of("jobs:\n  b:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n"
                         "        os: [windows-latest, macos-latest]\n    steps:\n      - run: x\n")["b"]
        self.assertEqual(places(matrix), {"windows-latest", "macos-latest"})

    def test_only_pinned_split_cache_actions(self):
        for name, text in workflows().items():
            for line in text.splitlines():
                if "actions/cache" in line:
                    with self.subTest(workflow=name, line=line):
                        self.assertIn(line.strip().removeprefix("- ").removeprefix("uses: "), (RESTORE, SAVE))

    def test_ci_jobs_only_read_their_base_record_right_before_the_same_full_build(self):
        found, restores = set(), 0
        for name, text in workflows().items():
            if name == WRITER:
                continue
            for job_id, job in jobs_of(text).items():
                for index, step in enumerate(job):
                    with self.subTest(workflow=name, job=job_id, step=index):
                        self.assertNotEqual(step.get("uses"), SAVE)
                        if step.get("uses") != RESTORE:
                            continue
                        restores += 1
                        self.assertEqual({k: job[index - 1].get(k) for k in ("id", "run")}, {"id": "base", "run": BASE_SCRIPT})
                        self.assertEqual(job[index + 1].get("run"), BUILD)
                        self.assertNotIn("working-directory", job[index + 1])
                        self.assertEqual(step["with"], {"path": PATH, "key": BASE_KEY})
                        self.assertEqual(step["env"], TIMEOUT)
                        self.assertNotIn("if", step)
                        self.assertNotIn("continue-on-error", step)
                        found |= places(job)
        self.assertGreater(restores, 0)
        # Every place a CI job reads from has a writer job of its own, and no writer is idle.
        writer = jobs_of(workflows()[WRITER])
        self.assertEqual(found, set().union(*(places(job) for job in writer.values())))

    def test_every_ci_build_reads_its_record_and_jobs_that_only_unpack_read_none(self):
        builds = unpacks = 0
        for name, text in workflows().items():
            if name == WRITER:
                continue
            for job_id, job in jobs_of(text).items():
                uses = [step.get("uses") for step in job]
                runs = [step.get("run", "") for step in job]
                with self.subTest(workflow=name, job=job_id):
                    for index, run in enumerate(runs):
                        if run == BUILD:
                            builds += 1
                            self.assertEqual(uses[index - 1], RESTORE)
                    if any("scripts/ci-next-artifact.mjs unpack" in run for run in runs):
                        unpacks += 1
                        self.assertNotIn(BUILD, runs)
                        self.assertNotIn(RESTORE, uses)
        self.assertGreater(builds, 0)
        self.assertGreater(unpacks, 0)

    def test_the_writer_runs_only_on_main_and_saves_right_after_its_build(self):
        text = workflows()[WRITER]
        triggers = text.split("\njobs:\n")[0]
        self.assertIn("\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\npermissions:\n  contents: read\n", triggers + "\n")
        for forbidden in ("pull_request", "merge_group", "schedule", "workflow_run", "write"):
            self.assertNotIn(forbidden, triggers)
        jobs = jobs_of(text)
        self.assertTrue(jobs)
        for job in jobs.values():
            self.assertEqual(len(places(job)), 1)
        self.assertEqual(len(set().union(*(places(job) for job in jobs.values()))), len(jobs))
        for job_id, job in jobs.items():
            with self.subTest(job=job_id):
                self.assertEqual(job.keys.get("if"), MAIN if job.keys.get("runs-on") == LINUX else MAIN_PUBLIC)
                kinds = [step.get("uses", step.get("run")) for step in job]
                self.assertEqual(kinds[-3:], [RESTORE, BUILD, SAVE])
                restore, save = job[-3], job[-1]
                self.assertEqual(restore["with"], {"path": PATH, "key": OWN_KEY, "restore-keys": PREFIX})
                self.assertEqual(restore["env"], TIMEOUT)
                self.assertEqual(save["with"], {"path": PATH, "key": OWN_KEY})
                self.assertNotIn("if", save)
                # It builds and saves; it runs no test and no other command.
                self.assertEqual([step["run"] for step in job if "run" in step], ["npm ci", BUILD])

    def test_the_writer_is_outside_ci(self):
        import test_ci_all_checks
        import test_ci_documentation_scope
        self.assertIn(WRITER, test_ci_all_checks.NOT_CI)
        self.assertIn(WRITER, test_ci_documentation_scope.NOT_CI)
        text = workflows()[WRITER]
        self.assertNotIn("All checks (", text)
        self.assertNotIn("run-name: PV8", text)


if __name__ == "__main__":
    unittest.main()
