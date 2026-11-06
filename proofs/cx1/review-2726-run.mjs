import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const file = "cx1-review-2726-readback.proof.ts";
const out = join(root, ".git", "cx1-results");
mkdirSync(out, { recursive: true });
const bundle = join(out, "review-2726-readback.cjs");
await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias: testAliases(file, root, join(root, "tests")), logLevel: "error" });
const run = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), stdio: "inherit" });
process.exitCode = run.status ?? 1;
