/**
 * Writes docs/opening-readiness/commercial-margin-figures.md from tests/commercial-margin-draft.ts, with the same
 * wiring the test runner uses (tests/test-config.mjs, the aliases of margin-alignment.test.ts), so no figure is typed.
 *
 * Two bundles: the first reads every email-dependent cost with PER_EMAIL in tests/plan-cost-registry.ts replaced by
 * SES_PER_EMAIL_USD (the LC rule's Amazon SES price, named in tests/commercial-margin-draft.ts); the second renders
 * the document with the code as it is and those SES figures for the LC columns. The replacement happens only inside
 * the first bundle; no file on disk changes. If the PER_EMAIL line is not found exactly once, the script fails.
 *
 * Deliberately no staleness test: pinned amounts would turn every unrelated cost change red.
 *
 *   node scripts/commercial-margin-draft.mjs           # writes the document
 *   node scripts/commercial-margin-draft.mjs --stdout  # prints it
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "tests");
const registry = join(here, "plan-cost-registry.ts");
const out = mkdtempSync(join(tmpdir(), "commercial-margin-draft-"));

/** Replaces the registry's PER_EMAIL literal with the SES price exported by the draft module, inside this bundle only. */
const sesPlugin = {
  name: "ses-per-email",
  setup(b) {
    b.onLoad({ filter: /plan-cost-registry\.ts$/ }, (args) => {
      if (resolve(args.path) !== registry) return undefined;
      const source = readFileSync(args.path, "utf8");
      const pattern = /^export const PER_EMAIL = [0-9.e_-]+;$/m;
      const matches = source.match(new RegExp(pattern.source, "gm")) ?? [];
      if (matches.length !== 1) throw new Error(`Expected one PER_EMAIL line in tests/plan-cost-registry.ts, found ${matches.length}`);
      return {
        contents: source.replace(pattern, 'import { SES_PER_EMAIL_USD as __SES_PER_EMAIL_USD } from "./commercial-margin-draft-ses";\nexport const PER_EMAIL = __SES_PER_EMAIL_USD;'),
        loader: "ts",
        resolveDir: dirname(args.path),
      };
    });
    // The SES constant is read from the draft module's source alone, so the registry does not import the whole draft.
    b.onResolve({ filter: /^\.\/commercial-margin-draft-ses$/ }, () => ({ path: "ses", namespace: "ses-price" }));
    b.onLoad({ filter: /.*/, namespace: "ses-price" }, () => {
      const draft = readFileSync(join(here, "commercial-margin-draft.ts"), "utf8");
      const line = draft.match(/^export const SES_PER_EMAIL_USD = ([0-9._ /]+);$/m);
      if (!line) throw new Error("SES_PER_EMAIL_USD not found in tests/commercial-margin-draft.ts");
      return { contents: `export const SES_PER_EMAIL_USD = ${line[1]};\n`, loader: "ts" };
    });
  },
};

async function bundleAndRun(name, contents, plugins, env = {}) {
  const bundle = join(out, `${name}.cjs`);
  await build({
    stdin: { contents, resolveDir: here, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("margin-alignment.test.ts", root, here),
    plugins,
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: { ...testEnvironment(process.env), ...env }, maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  return run.stdout;
}

try {
  const sesUsage = await bundleAndRun(
    "ses-usage",
    `import { commercialMarginUsage } from "./commercial-margin-draft";\nprocess.stdout.write(JSON.stringify(commercialMarginUsage()));\n`,
    [sesPlugin],
  );
  const usageFile = join(out, "ses-usage.json");
  writeFileSync(usageFile, sesUsage);
  const commit = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const document = await bundleAndRun(
    "render",
    `import { readFileSync } from "node:fs";\nimport { renderCommercialMarginDraft } from "./commercial-margin-draft";\nconst lcUsage = JSON.parse(readFileSync(process.env.COMMERCIAL_MARGIN_SES_USAGE, "utf8"));\nprocess.stdout.write(renderCommercialMarginDraft({ lcUsage, commit: process.env.COMMERCIAL_MARGIN_COMMIT, date: process.env.COMMERCIAL_MARGIN_DATE }));\n`,
    [],
    { COMMERCIAL_MARGIN_SES_USAGE: usageFile, COMMERCIAL_MARGIN_COMMIT: commit, COMMERCIAL_MARGIN_DATE: date },
  );
  const target = join(root, "docs/opening-readiness/commercial-margin-figures.md");
  if (process.argv.includes("--stdout")) process.stdout.write(document);
  else { writeFileSync(target, document); console.log(`Wrote ${target}`); }
} finally {
  rmSync(out, { recursive: true, force: true });
}
