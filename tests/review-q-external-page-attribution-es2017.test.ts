import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the study evidence test uses syntax supported by the repository target", () => {
  const config = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { compilerOptions?: { target?: string } };
  assert.equal(config.compilerOptions?.target, "ES2017");

  const source = readFileSync("tests/external-page-attribution-study.test.ts", "utf8");
  const unsupported = source
    .split("\n")
    .filter((line) => /\/[^/]*\/[dgimuvy]*s[dgimuvy]*/.test(line));
  assert.deepEqual(unsupported, []);
});
