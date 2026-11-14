/**
 * Next's TypeScript check runs once per commit in CI, in product-checks' verify job, and the
 * browser legs that build the same commit skip the identical check (scripts/ci-build-args.mjs,
 * TYPES_CHECKED_IN_VERIFY). This holds the rule both ways:
 *
 * - verify always type-checks, so does any job not named, and no build outside GitHub Actions
 *   can switch the check off;
 * - a named leg only exists in a workflow that runs on exactly the same events as
 *   product-checks.yml and is gated by the same documentation-scope decision as verify, so
 *   whenever a named leg builds, verify type-checks that commit too.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  TYPES_CHECKED_IN_VERIFY, TYPES_CHECKED_IN_VERIFY_VARIABLE, ciBuildTypeCheckEnvironment,
} from "../scripts/ci-build-args.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const workflow = (file: string) => read(`.github/workflows/${file}`);

/** Top-level jobs of a workflow: {job id: its text}. */
function jobs(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const body = text.split("\njobs:\n")[1] ?? "";
  let current = "";
  for (const line of body.split("\n")) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) { current = id[1]; found[current] = ""; continue; }
    if (current) found[current] += line + "\n";
  }
  return found;
}
const triggers = (text: string) => text.split("\npermissions:\n")[0].split("\non:\n")[1] ?? "";
const gate = (job: string) => /^ {4}if: (.+)$/m.exec(job)?.[1] ?? "";
/** Whether `text` has an || outside every parenthesis (it would widen what it is joined to). */
function orAtTopLevel(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (depth === 0 && text.startsWith("||", i)) return true;
  }
  return false;
}
/** Whether a job's `if:` is verify's, or verify's with more conditions joined by && after it (never a top-level ||). */
function narrowedFrom(leg: string, base: string): boolean {
  const inner = (text: string) => /^\$\{\{ (.+) \}\}$/.exec(text)?.[1];
  const [a, b] = [inner(leg), inner(base)];
  if (a === undefined || b === undefined || orAtTopLevel(b)) return false;
  return a === b || (a.startsWith(`${b} && `) && !orAtTopLevel(a.slice(b.length)));
}
const builds = (job: string) => /^\s*(?:- )?run: node scripts\/ci-build\.mjs\s*$/m.test(job);
const env = (file: string, job: string, extra: Record<string, string> = {}) => ({
  GITHUB_ACTIONS: "true",
  GITHUB_WORKFLOW_REF: `solrenning-llc/marktmorgen/.github/workflows/${file}@refs/pull/1/merge`,
  GITHUB_JOB: job,
  ...extra,
});
const skips = (environment: Record<string, string | undefined>) =>
  ciBuildTypeCheckEnvironment(environment)[TYPES_CHECKED_IN_VERIFY_VARIABLE];

part("the decision, from GitHub's own workflow file and job id");
is("the variable is the one next.config.ts reads", TYPES_CHECKED_IN_VERIFY_VARIABLE, "MARKTMORGEN_CI_TYPES_CHECKED_IN_VERIFY");
is("verify type-checks", skips(env("product-checks.yml", "verify")), "");
is("a named leg skips the identical check", skips(env("accessibility-public-matrix.yml", "public-matrix")), "1");
is("a merge-queue ref reads the same", skips(env("product-checks.yml", "cross-browser", {
  GITHUB_WORKFLOW_REF: "solrenning-llc/marktmorgen/.github/workflows/product-checks.yml@refs/heads/gh-readonly-queue/main/pr-1-abc",
})), "1");
is("an unknown job type-checks", skips(env("product-checks.yml", "store-copy")), "");
is("a named job id under another workflow type-checks", skips(env("codeql.yml", "public-matrix")), "");
is("verify's job id under another workflow file name type-checks", skips(env("accessibility-public-matrix.yml", "verify")), "");
is("outside GitHub Actions it type-checks", skips(env("product-checks.yml", "cross-browser", { GITHUB_ACTIONS: "" })), "");
is("without a workflow reference it type-checks", skips({ GITHUB_ACTIONS: "true", GITHUB_JOB: "cross-browser" }), "");
is("without a job id it type-checks", skips({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: env("product-checks.yml", "x").GITHUB_WORKFLOW_REF }), "");
is("an inherited value never switches the check off in verify", skips(env("product-checks.yml", "verify", {
  MARKTMORGEN_CI_TYPES_CHECKED_IN_VERIFY: "1",
})), "");
is("nothing in the environment is set but the one variable",
  Object.keys(ciBuildTypeCheckEnvironment(env("product-checks.yml", "verify"))), [TYPES_CHECKED_IN_VERIFY_VARIABLE]);

part("verify runs the check whenever a named leg builds");
const productChecks = workflow("product-checks.yml");
const verify = jobs(productChecks).verify ?? "";
is("product-checks.yml has a verify job that runs the synthetic build", builds(verify), true);
is("verify is never named", TYPES_CHECKED_IN_VERIFY.includes("product-checks.yml#verify"), false);
is("every name is unique", new Set(TYPES_CHECKED_IN_VERIFY).size, TYPES_CHECKED_IN_VERIFY.length);
const files = new Set(readdirSync(".github/workflows"));
for (const name of TYPES_CHECKED_IN_VERIFY) {
  const [file, id] = name.split("#");
  const text = files.has(file) ? workflow(file) : "";
  const job = jobs(text)[id];
  is(`${name}: the workflow file and job exist`, job !== undefined, true);
  is(`${name}: runs on exactly product-checks.yml's events`, triggers(text), triggers(productChecks));
  // The same decision, or the same one with more conditions after it (the real readers run only on the public repository).
  is(`${name}: gated by the same documentation-scope decision as verify, at most narrowed`,
    [narrowedFrom(gate(job ?? ""), gate(verify)), /^ {4}needs: documentation-scope$/m.test(job ?? "")], [true, true]);
}
is("verify's gate is the documentation-scope decision, needed first", gate(verify),
  "${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' }}");
is("a gate with a top-level || is never taken as narrower", [
  narrowedFrom("${{ x && y || z }}", "${{ x }}"), narrowedFrom("${{ x && (y || z) }}", "${{ x }}"),
], [false, true]);
is("mobile render builds only the commit under test (every matrix ref is github.sha)",
  [...(jobs(productChecks)["mobile-render"] ?? "").matchAll(/^ {12}ref: (.+)$/gm)].map((m) => m[1]),
  ["${{ github.sha }}"]);
is("verify needs the documentation scope", /^ {4}needs: documentation-scope$/m.test(verify), true);

part("every build reads the decision, and only GitHub Actions can skip the check");
const build = read("scripts/ci-build.mjs");
is("the synthetic build passes the decision to next build, after the inherited environment",
  /\.\.\.process\.env,[\s\S]*\.\.\.ciBuildTypeCheckEnvironment\(process\.env\),[\s\S]*NEXT_FONT_GOOGLE_MOCKED_RESPONSES/.test(build), true);
is("next.config.ts skips the check only under GitHub Actions with the variable at 1",
  read("next.config.ts").includes(
    "    ignoreBuildErrors:\n      process.env.GITHUB_ACTIONS === \"true\" && process.env.MARKTMORGEN_CI_TYPES_CHECKED_IN_VERIFY === \"1\",\n"),
  true);
is("next.config.ts sets ignoreBuildErrors in one place", read("next.config.ts").split("ignoreBuildErrors").length - 1, 1);

done();
