/** Replays the intentionally RED recovery proof on its recorded product source. */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testAliases, testEnvironment } from "./test-config.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "h2-health-recovery-"));
try {
  const file = "mail-health-recovery.proof.ts";
  const bundle = join(out, "proof.cjs");
  await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias: testAliases(file, root, join(root, "tests")) });
  const result = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
