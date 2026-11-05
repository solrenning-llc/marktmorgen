import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const here = join(root, "tests");
const aliases = testAliases("preview-counter-admission.test.ts", root, here);
aliases["@/lib/redis"] = join(here, "review-q-preview-counter-world.ts");

const output = join(process.env.TMPDIR || "/tmp", `review-q-preview-counter-${randomUUID()}.cjs`);
await build({
  entryPoints: [join(here, "review-q-preview-counter-controls.test.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  alias: aliases,
  logLevel: "silent",
});
const result = spawnSync(process.execPath, [output], {
  cwd: root,
  env: testEnvironment(process.env),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
