/**
 * The price, margin and cost reports are generated on demand, with no stored copy (owner, 20 November 2026, Fortaleza,
 * AGENTS.md AC (b)). Holds:
 *   - each report's path keeps exactly one short fixed text, so it never conflicts and is never stale;
 *   - each script prints the report from the current code and writes nothing under docs/;
 *   - the solver runs on demand in the test job, from pinned packages, so its output is never stored either.
 * The checks on the figures themselves stay in each report's own test, now on the output computed on demand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ON_DEMAND_REPORTS, onDemandSentence, onDemandText } from "./generated-on-demand";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("each report's path holds exactly its fixed on-demand text", () => {
  for (const report of ON_DEMAND_REPORTS) assert.equal(read(report.file), onDemandText(report), `${report.file} holds only: ${onDemandSentence(report.command)}`);
});

test("the fixed text is the owner's sentence, and a .json path stays valid JSON", () => {
  for (const report of ON_DEMAND_REPORTS) {
    assert.match(onDemandSentence(report.command), /^Generated on demand: run node scripts\/[a-z-]+\.mjs( --[a-z-]+)?; the output is always computed from the current code\.$/);
    if (report.json) assert.equal(JSON.parse(read(report.file)).generatedOnDemand, onDemandSentence(report.command));
  }
});

test("no report script writes a file; each prints its report", () => {
  const scripts = [...new Set(ON_DEMAND_REPORTS.map((r) => r.command.split(" ")[1]))];
  for (const script of scripts) assert.doesNotMatch(read(script), /writeFileSync|writeFile\(/, `${script} prints the report and writes nothing`);
  assert.doesNotMatch(read("scripts/pricing-optimization-milp.py"), /write_text|open\([^)]*["']w/, "the solver reads stdin and prints to stdout");
});

test("running each command prints its report, leaves the stored text unchanged, and keeps the rules that read docs/", () => {
  // tests/tax-gate.test.ts read every file under docs/ for "accountant" (owner, 18 October 2026: no accountant). The reports
  // are no longer there, so the same rule is held here on what each script prints.
  const allowed = /\b(no|not to use an|uses no|without an?)\s+accountant\b/i;
  for (const report of ON_DEMAND_REPORTS) {
    const [, script, ...flags] = report.command.split(" ");
    const run = spawnSync(process.execPath, [script, ...flags], { cwd: root, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, `${report.command}: ${run.stderr}`);
    if (report.json) {
      const parsed = JSON.parse(run.stdout);
      assert.ok(report.file.includes("input") ? Array.isArray(parsed.tiers) && typeof parsed.plans === "object" : Array.isArray(parsed.solutions) && parsed.solutions.length > 0, `${report.command} prints the ${report.file.includes("input") ? "solver's input" : "solver's solutions"}`);
    } else {
      assert.ok(run.stdout.length > 1_000 && /^# /m.test(run.stdout), `${report.command} prints the report`);
      const said = run.stdout.split("\n").filter((line) => /accountant/i.test(line) && line.replace(new RegExp(allowed.source, "gi"), "").match(/accountant/i));
      assert.deepEqual(said, [], `${report.command} leaves no doubt for an accountant to close`);
    }
    assert.equal(read(report.file), onDemandText(report), `${report.command} leaves ${report.file} as its fixed text`);
  }
});

test("the solver's stdout carries only its JSON, even when HiGHS writes straight to fd 1", () => {
  // HiGHS can print a diagnostic to file descriptor 1 whatever options={"disp": False} says (seen on 21/11/2026 with
  // #4888's cost lines: "HighsMipSolverData::transformNewIntegerFeasibleSolution tmpSolver.run();"), which made the
  // solver's output unreadable. The real script runs here with milp wrapped to write such a line to fd 1 first.
  const input = spawnSync(process.execPath, ["scripts/pricing-optimization.mjs", "--milp-input"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(input.status, 0, input.stderr);
  const line = "HighsMipSolverData::transformNewIntegerFeasibleSolution tmpSolver.run();";
  const wrapped = [
    "import importlib.util, os",
    "spec = importlib.util.spec_from_file_location('solver', 'scripts/pricing-optimization-milp.py')",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "real = m.milp",
    `def noisy(*a, **k):\n    os.write(1, b${JSON.stringify(line + "\n")})\n    return real(*a, **k)`,
    "m.milp = noisy",
    "m.main()",
  ].join("\n");
  const run = spawnSync(process.env.MILP_PYTHON || "python3", ["-c", wrapped], { cwd: root, input: input.stdout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(Array.isArray(parsed.solutions) && parsed.solutions.length > 0, "the JSON on stdout has the solutions");
  assert.ok(run.stderr.includes(line), "what HiGHS writes to fd 1 goes to stderr, not lost and not into the JSON");
});

test("the test job installs the solver's pinned packages, so the solver runs on demand there", () => {
  // Each requirement is one logical line ("\" continues it): the exact version, then the sha256 of each prebuilt wheel the
  // job may take (owner's SIM of 20/11/2026, condition 3: --only-binary :all: and --require-hashes).
  const pins = read("scripts/requirements-solver.txt").replace(/\\\n/g, " ").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(pins.map((l) => l.split("==")[0]).sort(), ["numpy", "scipy"]);
  for (const pin of pins) {
    assert.match(pin, /^[a-z]+==\d+\.\d+\.\d+ /, `${pin.split(" ")[0]} is an exact version`);
    const hashes = pin.match(/--hash=sha256:[0-9a-f]{64}\b/g) ?? [];
    assert.ok(hashes.length >= 1 && hashes.length === pin.split("--hash=").length - 1, `${pin.split(" ")[0]} is locked by the sha256 of its wheels`);
  }
  const workflow = read(".github/workflows/product-checks.yml");
  const job = workflow.slice(workflow.indexOf("\n  behavior-regressions:"), workflow.indexOf("\n  store-copy:"));
  assert.match(job, /python3 -m venv "\$RUNNER_TEMP\/solver"/);
  // Only prebuilt wheels, each checked against its hash: no install script runs in CI, and a swapped package fails.
  assert.match(job, /"\$RUNNER_TEMP\/solver\/bin\/pip" install --only-binary :all: --require-hashes -r scripts\/requirements-solver\.txt/);
  assert.match(job, /MILP_PYTHON=\$RUNNER_TEMP\/solver\/bin\/python/);
  assert.ok(job.indexOf("requirements-solver") < job.indexOf("run: npm test"), "the solver is installed before the tests run");
});

test("AGENTS.md says the reports are generated on demand, where it said they were stored copies", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /generated on demand|gerados na hora/);
  assert.match(agents, /ON_DEMAND_REPORTS/);
});
