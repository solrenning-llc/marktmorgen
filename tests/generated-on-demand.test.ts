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

test("the test job installs the solver's pinned packages, so the solver runs on demand there", () => {
  const pins = read("scripts/requirements-solver.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(pins.map((l) => l.split("==")[0]).sort(), ["numpy", "scipy"]);
  for (const pin of pins) assert.match(pin, /^[a-z]+==\d+\.\d+\.\d+$/, `${pin} is an exact version`);
  const workflow = read(".github/workflows/product-checks.yml");
  const job = workflow.slice(workflow.indexOf("\n  behavior-regressions:"), workflow.indexOf("\n  store-copy:"));
  assert.match(job, /python3 -m venv "\$RUNNER_TEMP\/solver"/);
  assert.match(job, /"\$RUNNER_TEMP\/solver\/bin\/pip" install -r scripts\/requirements-solver\.txt/);
  assert.match(job, /MILP_PYTHON=\$RUNNER_TEMP\/solver\/bin\/python/);
  assert.ok(job.indexOf("requirements-solver") < job.indexOf("run: npm test"), "the solver is installed before the tests run");
});

test("AGENTS.md says the reports are generated on demand, where it said they were stored copies", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /generated on demand|gerados na hora/);
  assert.match(agents, /ON_DEMAND_REPORTS/);
});
