import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const tests = join(root, "tests");
const entry = join(root, "proofs/c2/creator-invite-refund-list.proof.ts");
const output = "/tmp/c2-creator-invite-refund-list-proof.cjs";
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: output,
  logLevel: "error",
  alias: testAliases("creator-invite-refund-list.proof.ts", root, tests),
});
const result = spawnSync(process.execPath, [output], { env: testEnvironment(process.env), stdio: "inherit" });
process.exit(result.status ?? 1);
