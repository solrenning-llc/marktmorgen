import test from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHandle, renameHandle, releaseHandle, saleHandles, storeForEmail } from "@/lib/store";
import { beforeHandleRelease, ownReleasedHandleTimes, releasedHandleTimes, ownHandleOwnership, handleOwnership, legacyHandleOwnership, acquireHandleOwnership, releaseHandleOwnership } from "@/lib/platform-plan-identity";

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


test("acquisition and release preserve each recorded ownership interval without inventing old beginnings", async () => {
  redis.clear(); const email = "intervals@example.test";
  await claimHandle(email, "interval-xray", "Intervals", "");
  const first = (await storeForEmail(email))!;
  assert.deepEqual(first.handleOwnership, [{handle:"interval-xray", acquiredAt:Date.parse(first.createdAt), releasedAt:null}]);
  await renameHandle(email, "interval-alpha");
  const renamed = (await storeForEmail(email))!;
  assert.equal(renamed.handleOwnership!.length, 2);
  await renameHandle(email, "interval-xray");
  assert.deepEqual((await storeForEmail(email))!.handleOwnership, renamed.handleOwnership, "using a still-owned alias is not a new acquisition");
  await releaseHandle(email, "interval-alpha");
  const released = (await storeForEmail(email))!;
  const a = released.handleOwnership!.find(row => row.handle === "interval-alpha")!;
  assert.ok(a.acquiredAt && a.releasedAt && a.releasedAt >= a.acquiredAt);
  const old = releaseHandleOwnership({}, "legacy-name", 3000);
  assert.deepEqual(old, [{handle:"legacy-name", acquiredAt:null, releasedAt:3000}]);
  assert.equal(legacyHandleOwnership(old, "legacy-name", 1), "unknown");
  assert.equal(legacyHandleOwnership(old, "legacy-name", 3), "foreign");
  const reacquired = acquireHandleOwnership({handleOwnership:old}, "legacy-name", 6000);
  assert.equal(legacyHandleOwnership(reacquired, "legacy-name", 4), "foreign");
  assert.equal(legacyHandleOwnership(reacquired, "legacy-name", 6), "owned");
  assert.equal(reacquired.length, 2, "a later acquisition never erases the earlier release");
});

test("ownership intervals reject malformed, overlapping, inherited and executable evidence", () => {
  let reads = 0;
  const valid = {handle:"xray", acquiredAt:1000, releasedAt:3000};
  const getter = Object.defineProperty({...valid}, "acquiredAt", {get(){reads++;return 1000;}});
  const sparse = new Array(1);
  for (const rows of [[getter],sparse,[Object.create(valid)],[{...valid, acquiredAt:4000}],
    [valid,{...valid,acquiredAt:2000}], [{...valid,extra:1}], [{...valid,acquiredAt:null,releasedAt:null}]]) assert.equal(handleOwnership(rows), null);
  const source = [valid], captured = ownHandleOwnership({handleOwnership:source})!;
  valid.acquiredAt = 5000;
  assert.equal(legacyHandleOwnership(captured,"xray",2),"owned");
  assert.equal(legacyHandleOwnership(captured,"xray",0),"unknown");
  assert.equal(legacyHandleOwnership(captured,"xray",3),"foreign");
  assert.equal(ownHandleOwnership(Object.defineProperty({},"handleOwnership",{get(){reads++;return source;}})),null);
  assert.deepEqual(ownHandleOwnership(Object.create({get handleOwnership(){reads++;return source;}})),[]);
  assert.equal(reads,0);
});

test("a provider creation second straddling acquisition or release stays unknown", () => {
  const rows = [{handle:"xray", acquiredAt:1500, releasedAt:3500}];
  assert.equal(legacyHandleOwnership(rows,"xray",1),"unknown");
  assert.equal(legacyHandleOwnership(rows,"xray",2),"owned");
  assert.equal(legacyHandleOwnership(rows,"xray",3),"unknown");
  assert.equal(legacyHandleOwnership(rows,"xray",4),"foreign");
});
