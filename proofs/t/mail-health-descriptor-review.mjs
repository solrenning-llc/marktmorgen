/** Opt-in evidence runner. Never changes the selected source checkout or global test aliases. */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(process.argv[2] ?? evidence);
const revision = process.argv[3];
if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw new Error("Expected a full commit SHA");
const require = createRequire(join(source, "package.json"));
const { build } = require("esbuild");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(source, "tests/test-config.mjs")));
const out = mkdtempSync(join(tmpdir(), "t-mail-health-descriptor-"));
try {
  const file = "o-review-2687-descriptor.proof.ts";
  const bundle = join(out, "proof.cjs");
  await build({
    stdin: { contents: readFileSync(join(evidence, "tests", file), "utf8"), resolveDir: join(source, "tests"), sourcefile: file, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error",
    alias: testAliases(file, source, join(source, "tests")),
    plugins: revision ? [{ name: "exact-reviewed-module", setup(b) {
      b.onLoad({ filter: /[/\\]lib[/\\]mail-health\.ts$/ }, () => ({
        contents: execFileSync("git", ["show", `${revision}:lib/mail-health.ts`], { cwd: source, encoding: "utf8" }),
        loader: "ts", resolveDir: join(source, "lib"),
      }));
    } }] : [],
  });
  const run = spawnSync(process.execPath, [bundle], { cwd: source, stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = run.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
