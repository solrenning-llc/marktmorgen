import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "./test-config.mjs";

const file = "u-book-metadata-language.proof.ts";
const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "u-book-metadata-language-"));
try {
  await build({
    entryPoints: [resolve("tests", file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(out, "run.cjs"),
    alias: testAliases(file, root, resolve("tests")),
    logLevel: "error",
  });
  const result = spawnSync(process.execPath, [join(out, "run.cjs")], {
    stdio: "inherit",
    env: testEnvironment(process.env),
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
