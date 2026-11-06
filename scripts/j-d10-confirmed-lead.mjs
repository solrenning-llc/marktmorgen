import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd(), here = join(root, "tests");
const out = mkdtempSync(join(tmpdir(), "j-d10-confirmed-lead-"));
try {
  const bundle = join(out, "proof.cjs");
  const aliases = testAliases("store-join.test.ts", root, here);
  // Actual route POSTs run outside Next request scope; drain its held tasks in the proof.
  aliases["next/server"] = join(here, "next-server-after-world.ts");
  await build({ entryPoints: [join(here, "j-d10-confirmed-lead.proof.ts")], bundle: true,
    platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: aliases });
  const env = testEnvironment(process.env);
  // All HTTP is intercepted in the proof; discard inherited live provider configuration.
  for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", env, timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
