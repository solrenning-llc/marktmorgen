import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBundle, runTestFiles } from "./test-runner.mjs";

test("a real failed default executable counts once and preserves the following test", async () => {
  const directory = mkdtempSync(join(tmpdir(), "l-runner-review-"));
  const original = process.execPath;
  const ran: string[] = [];
  try {
    const worker = join(directory, "worker.cjs");
    writeFileSync(worker, "process.exit(0);");
    let result: unknown;
    try {
      result = await runTestFiles({ files: ["missing", "valid"], compile: async () => worker,
        run: async (file: string, bundle: string) => {
          ran.push(file);
          process.execPath = file === "missing" ? join(directory, "does-not-exist") : original;
          try { return await runBundle(bundle, process.env); }
          finally { process.execPath = original; }
        },
      });
    } catch { result = "aborted"; }
    assert.deepEqual([result, ran], [1, ["missing", "valid"]]);
  } finally {
    process.execPath = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all 127 short failure schedules retain exact ordering and failure counts", async () => {
  let cases = 0;
  for (let length = 0; length <= 6; length += 1) {
    const files = Array.from({ length }, (_, i) => String(i));
    for (let mask = 0; mask < 2 ** length; mask += 1) {
      let active = 0;
      let preparations = 0;
      const compiled: string[] = [], ran: string[] = [];
      const result = await runTestFiles({ files,
        compile: async (file: string) => {
          assert.equal(++preparations, 1);
          compiled.push(file);
          await Promise.resolve();
          preparations -= 1;
          return file;
        },
        run: async (file: string, bundle: string) => {
          assert.equal(++active, 1);
          assert.equal(bundle, file);
          ran.push(file);
          await Promise.resolve();
          active -= 1;
          return mask & (1 << Number(file)) ? 7 : 0;
        },
      });
      assert.deepEqual([compiled, ran, active, preparations, result], [files, files, 0, 0, files.filter((_, i) => mask & (1 << i)).length]);
      cases += 1;
    }
  }
  assert.equal(cases, 127);
});
