import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ciBuildNodeEnvironment } from "./ci-build-args.mjs";

test("macOS passes a fresh inherited environment fragment to descendants", () => {
  const first = ciBuildNodeEnvironment("darwin", "--trace-warnings");
  const second = ciBuildNodeEnvironment("darwin", "--trace-warnings");

  assert.deepEqual(first, {
    NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096",
  });
  assert.notStrictEqual(first, second);

  const intermediary = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      "import {spawnSync} from 'node:child_process';",
      "const result = spawnSync(process.execPath, ['--input-type=module', '--eval',",
      "  `import {getHeapStatistics} from 'node:v8'; console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, heap: getHeapStatistics().heap_size_limit }))`,",
      "] , {encoding: 'utf8'});",
      "process.stdout.write(result.stdout);",
      "process.stderr.write(result.stderr);",
      "process.exitCode = result.status ?? 1;",
    ].join("\n"),
  ], {
    encoding: "utf8",
    env: { ...process.env, ...first },
  });

  assert.equal(intermediary.status, 0, intermediary.stderr);
  const descendant = JSON.parse(intermediary.stdout);
  assert.equal(descendant.options, "--trace-warnings --max-old-space-size=4096");
  assert.ok(descendant.heap > 3 * 1024 ** 3);
});

test("non-macOS helpers add nothing for every representative platform", () => {
  /** @type {NodeJS.Platform[]} */
  const platforms = ["linux", "win32", "freebsd", "openbsd", "aix", "sunos"];
  for (const platform of platforms) {
    assert.deepEqual(ciBuildNodeEnvironment(platform, "--trace-warnings"), {});
  }
});
