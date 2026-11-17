/**
 * ALL-194 (coordinator, 14/11/2026): CodeQL (javascript-typescript) was cancelled at its 60-minute job limit in about
 * 45% of merge groups. The logs show time, not memory: run-queries already uses every core of the runner (--threads=4)
 * and ~14 GB (--ram=14568), shows no memory error, and was cancelled with 82 of 105 queries done; completed runs take
 * 27 to 54 minutes. The analyze job gets 120 minutes, well inside the merge queue's own 360-minute check timeout,
 * while the coverage stays exactly the same: both languages, security-extended, build-mode none, no paths-ignore.
 * Reads .github/workflows/codeql.yml as it is.
 *
 * Merge queue (15/11/2026): the analyze job took 64 min median in each merge group (p90 80, max 103, 182 runs in
 * 24 h), the slowest step of the queue, while there it uploaded nothing (upload: never), could not fail on a finding
 * and fed no rule of the main ruleset (the sources are in the workflow's comment). So it is skipped under merge_group
 * only, and "All checks (codeql)" accepts that one skip only there; every pull request, push to main, daily and
 * manual run still analyzes with the same queries and uploads. paths-ignore for tests/ and proofs/ was weighed and
 * left out: scripts/ (the margin calculators among them) import tests/, so it would cut real data flow.
 *
 * 180 minutes (owner, 16/11/2026): on 16/11/2026 finished runs took 64 to 112 minutes and three were cut at 120, one on
 * main's own push, which froze the queue for about 4 hours (#4826). Coverage is unchanged; only the time limit grows.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { codeqlTimeout } from "../scripts/queue_health_report.mjs";
import { done, is, part } from "./check";

const yaml = readFileSync(".github/workflows/codeql.yml", "utf8");

part("Time to finish");
is("the analyze job may run 180 minutes, read as the queue health report reads it", codeqlTimeout(yaml), 180);

part("The same coverage");
is("both languages are analyzed", /language: \[javascript-typescript, actions\]/.test(yaml), true);
is("with the security-extended queries and build-mode none", [/queries: security-extended/.test(yaml), /build-mode: none/.test(yaml)], [true, true]);
is("no path is left out of the analysis", /paths-ignore|paths:/.test(yaml), false);
is("All checks (codeql) still needs the analysis", /needs: \[analyze, documentation-scope\]/.test(yaml), true);

part("Skipped only in the merge queue, analyzed and uploaded everywhere else");
const analyzeIf = /\n {2}analyze:\n(?:(?: {4}.*)?\n)*? {4}if: (.*)\n/.exec(yaml)?.[1];
is("analyze runs on every event but merge_group, still gated by the documentation scope", analyzeIf,
  "${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' && github.event_name != 'merge_group' }}");
const uploads = yaml.split("\n").filter((line) => !line.trim().startsWith("#") && /\bupload:/.test(line)).map((line) => line.trim());
is("every run that analyzes uploads its results, none is left unsent", uploads, ["upload: always"]);
is("pull_request, push to main, daily and manual runs still trigger it, and merge_group still reports the check",
  ["  pull_request:\n", "  push:\n    branches: [main]\n", "  schedule:\n", "  workflow_dispatch:\n", "  merge_group:\n    types: [checks_requested]\n"].map((t) => yaml.includes(t)),
  [true, true, true, true, true]);
const finalCheck = yaml.split("\n  all-checks:\n")[1] ?? "";
is("the final check is told the event and that this workflow analyzes outside the queue",
  [finalCheck.includes("          CI_EVENT: ${{ github.event_name }}\n"), finalCheck.includes("          CI_ANALYSIS_OUTSIDE_QUEUE: \"true\"\n")], [true, true]);
const verdicts = spawnSync("python3", ["-B", "-c", [
  "import sys; sys.path.insert(0, 'scripts')",
  "from ci_all_checks import decide",
  "scope = {'result': 'success', 'outputs': {'full': 'true'}}",
  "def d(result, event, switch=True, name='analyze'): return decide({'documentation-scope': scope, name: {'result': result}}, event, False, switch)[0]",
  "print([d('skipped', 'merge_group'), d('skipped', 'merge_group', False), d('skipped', 'merge_group', name='verify'),",
  "       d('failure', 'merge_group'), d('cancelled', 'merge_group'), d('success', 'merge_group')])",
  "print([d('skipped', e) for e in ['pull_request', 'push', 'schedule', 'workflow_dispatch', '']])",
].join("\n")], { encoding: "utf8" });
is("in the merge queue only analyze's skip passes, only with the switch; a run that fails or is canceled still fails",
  verdicts.stdout.trim().split("\n")[0], "[True, False, False, False, False, True]");
is("outside the merge queue a skipped analysis fails the required check", verdicts.stdout.trim().split("\n")[1], "[False, False, False, False, False]");
done();
