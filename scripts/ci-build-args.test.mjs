import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

test("the synthetic build applies the platform-specific Node environment", async () => {
  const source = await readFile(new URL("./ci-build.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ ciBuildNodeEnvironment \} from "\.\/ci-build-args\.mjs";/);
  assert.match(source, /\.\.\.ciBuildNodeEnvironment\(process\.platform, process\.env\.NODE_OPTIONS\),/);
});

test("only macOS gets an inherited heap option and preserves existing options", async () => {
  const { ciBuildNodeEnvironment } = await import("./ci-build-args.mjs");
  assert.deepEqual(ciBuildNodeEnvironment("darwin"), { NODE_OPTIONS: "--max-old-space-size=4096" });
  assert.deepEqual(ciBuildNodeEnvironment("darwin", "--trace-warnings"), {
    NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096",
  });
  assert.deepEqual(ciBuildNodeEnvironment("linux"), {});
  assert.deepEqual(ciBuildNodeEnvironment("win32"), {});
});

test("the macOS environment gives a descendant a heap above the exhausted default", async () => {
  const { ciBuildNodeEnvironment } = await import("./ci-build-args.mjs");
  const descendantScript = [
    "import {spawnSync} from 'node:child_process';",
    "const child = spawnSync(process.execPath, [",
    "  '--input-type=module',",
    "  '--eval',",
    "  \"import {getHeapStatistics} from 'node:v8'; console.log(getHeapStatistics().heap_size_limit)\",",
    "], {encoding: 'utf8'});",
    "if (child.status !== 0) process.stderr.write(child.stderr);",
    "else process.stdout.write(child.stdout);",
    "process.exitCode = child.status ?? 1;",
  ].join("\n");
  const intermediary = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    descendantScript,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...ciBuildNodeEnvironment("darwin", process.env.NODE_OPTIONS) },
  });
  assert.equal(intermediary.status, 0, intermediary.stderr);
  assert.ok(Number(intermediary.stdout.trim()) > 3 * 1024 ** 3);
});
