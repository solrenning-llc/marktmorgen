import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the synthetic build applies the platform-specific Node arguments", async () => {
  const source = await readFile(new URL("./ci-build.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ ciBuildNodeArguments \} from "\.\/ci-build-args\.mjs";/);
  assert.match(source, /spawn\(process\.execPath, \[\.\.\.ciBuildNodeArguments\(process\.platform\),/);
});

test("only macOS gets the explicit heap needed by the hosted Next build", async () => {
  const { ciBuildNodeArguments } = await import("./ci-build-args.mjs");
  assert.deepEqual(ciBuildNodeArguments("darwin"), ["--max-old-space-size=4096"]);
  assert.deepEqual(ciBuildNodeArguments("linux"), []);
  assert.deepEqual(ciBuildNodeArguments("win32"), []);
});
