import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "./test-config.mjs";
const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "e2-2523-return-"));
let failed = false;
try {
  for (const file of process.argv.slice(2)) {
    const alias = testAliases(file.startsWith("review-e2-") ? "draft-view.test.ts" : file, root, join(root, "tests"));
    const bundle = join(out, file + ".cjs");
    await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias, logLevel: "error" });
    const result = spawnSync(process.execPath, [bundle], { cwd: root, encoding: "utf8", env: testEnvironment(process.env) });
    console.log(file, "exit", result.status, result.stdout.trim());
    if (result.status !== 0) console.error(result.stderr);
    failed ||= result.status !== 0;
  }
} finally { rmSync(out, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
