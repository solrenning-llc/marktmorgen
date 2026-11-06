import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = mkdtempSync(join(tmpdir(), "o-mention-proof-"));
try {
  const bundle = join(out, "proof.cjs");
  await build({ entryPoints: [join(root, "proofs/o/community-mention-read.proof.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias: testAliases("community-mention-read.proof.ts", root, join(root, "tests")) });
  const run = spawnSync(process.execPath, [bundle], { cwd: root, stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = run.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
