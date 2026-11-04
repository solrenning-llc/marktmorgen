import test from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHandle, renameHandle, releaseHandle, saleHandles, storeForEmail } from "@/lib/store";
import { beforeHandleRelease, ownReleasedHandleTimes, releasedHandleTimes } from "@/lib/platform-plan-identity";

test("releasing an address persists its exact second without changing legacy sales names", async () => {
  redis.clear();
  const email = "release-history@example.test";
  assert.equal((await claimHandle(email, "history-xray", "History", "")).ok, true);
  assert.equal((await renameHandle(email, "history-alpha")).ok, true);
  const before = await storeForEmail(email);
  assert.ok(before);
  assert.equal(Object.hasOwn(before, "releasedHandleAt"), false, "an undated record gains no fabricated release");
  const start = Math.floor(Date.now() / 1000);
  const result = await releaseHandle(email, "history-xray");
  assert.equal(result.ok, true);
  const saved = await storeForEmail(email);
  assert.ok(saved);
  const ended = Math.floor(Date.now() / 1000), release = saved.releasedHandleAt?.["history-xray"];
  assert.ok(typeof release === "number" && release >= start && release <= ended);
  assert.deepEqual(saved.releasedHandles, ["history-xray"]);
  assert.deepEqual([...saleHandles(saved)].sort(), ["history-alpha", "history-xray"]);
  assert.equal(beforeHandleRelease(saved.releasedHandleAt, "history-xray", release - 1), true);
  assert.equal(beforeHandleRelease(saved.releasedHandleAt, "history-xray", release), false);
  assert.equal(beforeHandleRelease(undefined, "history-xray", 1), false);
});

test("release evidence is detached own data and never runs inherited or own getters", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "xray", { enumerable: true, get() { reads++; return 100; } });
  assert.equal(releasedHandleTimes(accessor), null);
  assert.equal(beforeHandleRelease(accessor, "xray", 1), false);
  const inherited = Object.create({ get xray() { reads++; return 100; } });
  assert.equal(releasedHandleTimes(inherited), null);
  assert.equal(beforeHandleRelease(inherited, "xray", 1), false);
  assert.equal(ownReleasedHandleTimes(Object.defineProperty({}, "releasedHandleAt", { get() { reads++; return { xray: 100 }; } })), null);
  assert.deepEqual(Object.keys(ownReleasedHandleTimes(Object.create({ get releasedHandleAt() { reads++; return { xray: 100 }; } }))!), []);
  const source = { xray: 100, constructor: 200 };
  const copy = releasedHandleTimes(source)!;
  assert.equal(Object.getPrototypeOf(copy), null);
  assert.equal(Object.hasOwn(copy, "constructor"), true);
  source.xray = 1;
  assert.equal(copy.xray, 100);
  assert.equal(reads, 0);
});
