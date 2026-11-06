import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "./test-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const file = "u-letter-metadata-language.proof.ts";
const out = mkdtempSync(resolve(tmpdir(), "codex-u-letter-metadata-"));
const aliases = testAliases(file, root, here);
aliases["next/headers"] = resolve(here, "letter-members-world.ts");
aliases["next/navigation"] = resolve(here, "meeting-withdrawal-page-world.ts");
aliases["@/components/store-tracking"] = resolve(here, "letter-members-world.ts");

try {
  const bundle = resolve(out, "proof.cjs");
  await build({
    entryPoints: [resolve(here, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: aliases,
  });
  const result = spawnSync(process.execPath, [bundle], {
    cwd: root,
    env: testEnvironment(process.env),
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
