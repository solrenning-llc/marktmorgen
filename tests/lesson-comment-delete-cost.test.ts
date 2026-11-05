/** Regression proof: deleting one thread must not read every lesson row with a separate paid command. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("lib/lesson-comments.ts"), "utf8");
const script = source.match(/const DELETE_THREAD = `([\s\S]*?)`;/)?.[1] ?? "";

test("thread deletion batches the bounded lesson rows in one Redis read", () => {
  assert.ok(script.startsWith("-- marktmorgen:lesson-comment-thread-delete:v1\n"));
  assert.match(script, /local rows = redis\.call\("HMGET", KEYS\[1\], unpack\(ids\)\)/);
  assert.doesNotMatch(
    script,
    /for _, id in ipairs\(ids\) do\s+local row = redis\.call\("HGET", KEYS\[1\], id\)/,
    "one HGET per lesson row makes repeated deletion quadratic in paid Redis commands",
  );
});
