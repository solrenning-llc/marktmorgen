/**
 * lib/product-about-live.ts ABOUT_WRITE_IF_STORE_LIVE answers on the app's in-memory Redis (lib/redis-memory.ts) as it
 * does on Redis. The Mobile render check seeds the demo store on that stand-in, and the demo writes product
 * descriptions through this script: without it, the stand-in threw "MemoryRedis: unsupported EVAL" and the demo store
 * was never made (#4969, Mobile render on bf60c5d60d). The tests' own stand-in (tests/redis-take-scripts.ts) had it,
 * so no unit test saw the gap. Synthetic only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRedis } from "@/lib/redis-memory";
import { ABOUT_WRITE_IF_STORE_LIVE } from "@/lib/product-about-live";

type Arg = string | number;
const live = (): MemoryRedis => {
  const store = new MemoryRedis();
  store.run(["SET", "id", "ref"]);
  store.run(["SET", "about", "old text"]);
  return store;
};
const write = (store: MemoryRedis, compare: "0" | "1", expected: string, text: string): unknown =>
  store.run(["EVAL", ABOUT_WRITE_IF_STORE_LIVE, 3, "id", "erasing", "about", "field", compare, expected, text] as Arg[]);

test("a live store's description is written, compared or not", () => {
  const plain = live();
  assert.deepEqual(write(plain, "0", "", "new text"), [1]);
  assert.equal(plain.run(["GET", "about"]), "new text");
  const compared = live();
  assert.deepEqual(write(compared, "1", "old text", "newer"), [1]);
  assert.equal(compared.run(["GET", "about"]), "newer");
});

test("a compared write over a description that changed writes nothing and says its length now", () => {
  const store = live();
  assert.deepEqual(write(store, "1", "something else", "new text"), [0, Buffer.byteLength("old text", "utf8")]);
  assert.equal(store.run(["GET", "about"]), "old text");
});

test("an empty text deletes the description", () => {
  const store = live();
  assert.deepEqual(write(store, "0", "", ""), [1]);
  assert.equal(store.run(["GET", "about"]), null);
});

test("a store being erased, or with no id key, gets nothing written", () => {
  const erasing = live();
  erasing.run(["HSET", "erasing", "field", "1"]);
  assert.deepEqual(write(erasing, "0", "", "new text"), [-1]);
  assert.equal(erasing.run(["GET", "about"]), "old text");
  const gone = live();
  gone.run(["DEL", "id"]);
  assert.deepEqual(write(gone, "0", "", "new text"), [-1]);
  assert.equal(gone.run(["GET", "about"]), "old text");
});
