import { test } from "node:test";
import assert from "node:assert/strict";
import { holdLock, setIfHeld, type Held } from "@/lib/redis-lock";
import { store } from "./redis-stub";

test("unknown script acknowledgments never confirm a lease or fenced write", async () => {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  const held: Held = { key: "synthetic:held", token: "owner", ttlSeconds: 15 };
  try {
    for (const acknowledgment of [undefined, null, false, true, 0, 2, "1", "OK", {}, []]) {
      store.pipeline = async () => [acknowledgment];
      assert.equal(await holdLock(held), false);
      assert.equal(await setIfHeld(held, "synthetic:record", "value"), false);
    }
    store.pipeline = async () => [1];
    assert.equal(await holdLock(held), true);
    assert.equal(await setIfHeld(held, "synthetic:record", "value"), true);
  } finally { store.pipeline = original; }
});

// Rule 23 (Codex G on #2721, C4-20261106-1055-TODOS-59): this test once accepted a separate GET + EXPIRE / EXISTS + SET
// when the script could not run, as long as storage acknowledged each step. Read then act as two steps leaves a gap in
// which an expired lock can become another holder's, so the fallback is gone: with the script unavailable a hold is
// never confirmed and a fenced write never lands, whatever the separate commands would have answered.
test("when the script cannot run, no renewal or fenced write is confirmed and no separate command is sent", async () => {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  const held: Held = { key: "synthetic:held", token: "owner", ttlSeconds: 15 };
  let separate = 0;
  store.pipeline = async commands => {
    if (commands[0]?.[0] === "EVAL") throw Error("Synthetic unsupported script");
    separate += 1;
    return commands.map(command => (command[0] === "GET" ? held.token : command[0] === "EXISTS" ? 0 : command[0] === "EXPIRE" ? 1 : "OK"));
  };
  try {
    assert.equal(await holdLock(held), false);
    assert.equal(await setIfHeld(held, "synthetic:record", "value"), false);
    assert.equal(await setIfHeld(held, "synthetic:record", "value", { absent: true }), false);
    assert.equal(separate, 0);
  } finally { store.pipeline = original; }
});
