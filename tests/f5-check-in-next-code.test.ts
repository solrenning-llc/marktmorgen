import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Keep esbuild in the child's project dependency tree, rather than bundling its API into the test runner.
test("the check-in component keeps the next code typed while the first reply waits", () => {
  const result = spawnSync(process.execPath, ["--test", "tests/f5-check-in-next-code.proof.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
