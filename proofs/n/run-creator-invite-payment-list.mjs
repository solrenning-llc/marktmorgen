import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const tests = join(root, "tests");
const entry = join(root, "proofs/n/creator-invite-payment-list.proof.ts");
const output = "/tmp/n-creator-invite-payment-list-proof.cjs";
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: output,
  logLevel: "error",
  alias: testAliases("creator-invite-payment-list.proof.ts", root, tests),
});
const result = spawnSync(process.execPath, [output], { env: testEnvironment(process.env), stdio: "inherit" });
process.exit(result.status ?? 1);
