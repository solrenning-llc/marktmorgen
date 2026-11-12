/**
 * Next's TypeScript check runs in exactly one CI build: the verify job's "Production build and
 * route types" (product-checks, a required check). The browser and accessibility jobs build the
 * same commit only to drive the app, so they pass --skip-type-check (scripts/ci-build.mjs), which
 * next.config.ts honours only inside GitHub Actions. A type error therefore still fails every pull
 * request and merge group, and the host's build always checks types.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import { SKIP_TYPE_CHECK_ENV, SKIP_TYPE_CHECK_FLAG, ciBuildTypeCheckEnvironment } from "../scripts/ci-build-args.mjs";

const workflows = readdirSync(".github/workflows").filter((name) => name.endsWith(".yml")).sort();
const read = (name: string) => readFileSync(`.github/workflows/${name}`, "utf8");

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

part("the verify job's build keeps Next's type check");
const product = jobs(read("product-checks.yml"));
is("product-checks has a verify job", "verify" in product, true);
is("verify builds with the type check, no argument",
  /\n {6}- name: Production build and route types\n {8}run: node scripts\/ci-build\.mjs\n/.test(product.verify ?? ""), true);
is("verify passes no skip anywhere", (product.verify ?? "").includes(SKIP_TYPE_CHECK_FLAG), false);
is("the final check waits for verify", /\n {4}needs: \[[^\]]*\bverify\b[^\]]*\]\n/.test(product["all-checks"] ?? ""), true);

part("no workflow switches the check off by its environment");
for (const name of workflows) is(`${name}: never sets ${SKIP_TYPE_CHECK_ENV}`, read(name).includes(SKIP_TYPE_CHECK_ENV), false);

part("every other CI build skips it");
const builds = workflows.flatMap((name) =>
  [...read(name).matchAll(/run: node scripts\/ci-build\.mjs(.*)$/gm)].map((m) => `${name}: ${m[1].trim() || "(type check)"}`));
is("exactly one build checks types, and it is product-checks", builds.filter((b) => b.endsWith("(type check)")),
  ["product-checks.yml: (type check)"]);
is("the others all pass the flag and nothing else",
  builds.filter((b) => !b.endsWith("(type check)")).every((b) => b.endsWith(`: ${SKIP_TYPE_CHECK_FLAG}`)), true);

part("the argument alone decides, never an inherited variable");
is("no argument: the check runs", ciBuildTypeCheckEnvironment([]), { [SKIP_TYPE_CHECK_ENV]: "0" });
is("the flag: skipped", ciBuildTypeCheckEnvironment([SKIP_TYPE_CHECK_FLAG]), { [SKIP_TYPE_CHECK_ENV]: "1" });
let refused = "";
try { ciBuildTypeCheckEnvironment(["--skip-typecheck"]); } catch (error) { refused = String(error); }
is("a misspelt argument is refused, not ignored", /unknown argument/.test(refused), true);
const build = readFileSync("scripts/ci-build.mjs", "utf8");
is("ci-build.mjs reads its own arguments", build.includes("ciBuildTypeCheckEnvironment(process.argv.slice(2))"), true);
const env = build.slice(build.indexOf("env: {"), build.indexOf("},", build.indexOf("env: {")));
is("and spreads the result after the inherited environment, so it wins",
  env.indexOf("...process.env") >= 0 && env.indexOf("...typeCheck") > env.indexOf("...process.env"), true);

part("next.config.ts honours it only inside GitHub Actions");
const config = readFileSync("next.config.ts", "utf8");
is("ignoreBuildErrors needs both GITHUB_ACTIONS and the variable set to 1",
  config.includes(`ignoreBuildErrors: process.env.GITHUB_ACTIONS === "true" && process.env.${SKIP_TYPE_CHECK_ENV} === "1",`), true);
is("and is set nowhere else", (config.match(/ignoreBuildErrors/g) ?? []).length, 1);

done();
