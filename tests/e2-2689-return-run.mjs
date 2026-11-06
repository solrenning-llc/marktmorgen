import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "./test-config.mjs";
const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "e2-2689-return-"));
let failed = false;
try {
  for (const file of process.argv.slice(2)) {
    const alias = testAliases(file.endsWith(".proof.ts") ? "stats-notes-read-evidence.test.ts" : file, root, join(root, "tests"));
    if (process.env.E2_STATS_SOURCE) alias["@/lib/stats-notes"] = resolve(process.env.E2_STATS_SOURCE);
    const bundle = join(out, file + ".cjs");
    await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias, logLevel: "error" });
    console.log("=== " + file + " ===");
    const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: testEnvironment(process.env) });
    failed ||= result.status !== 0;
  }
} finally { rmSync(out, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
