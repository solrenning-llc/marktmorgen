/**
 * A product's campaign landings and their slot in the store's data room
 * (lib/campaign-landing-store.ts), held against Codex G's boundaries on
 * #1947 and Codex J's on #1950 (C3-139): a read that is not exact never
 * erases the others, a write or a delete whose answer is not the expected
 * one is never said saved and never gives room back, and two saves at once
 * never leave a record larger than its slot. Against the in-memory Redis
 * double only; the writes are matched both as the scripts they are now and
 * as the plain SET and DEL they were, so the same test holds the old code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropLandings, readLandings, removeLanding, saveLanding } from "../lib/campaign-landing-store";
import { dataKey, dataUsed, needData } from "../lib/store-data";
import { contentRoomFor, dataBytes } from "../lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const stats = "g".repeat(16);
const product = "g-product";
const key = `nl:product:landing:${stats}:${product}`;
const room = { ...ROOM, sid: "g-landing-room" };
const landing = (campaign: string, headline = "A practical cooking course", sub = "Learn knife skills", button = "See the course") => ({ campaign, headline, sub, button });
const slot = () => Number(redis.run(["HGET", dataKey(room)!, `al:${product}`]) ?? 0);
const stored = () => redis.run(["GET", key]);
const writes = (c: (string | number)[]) => (c[0] === "SET" && c[1] === key) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:landings-write"));
const deletes = (c: (string | number)[]) => (c[0] === "DEL" && c[1] === key) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:landings-drop"));
const covered = () => {
  const raw = stored();
  return typeof raw === "string" ? dataBytes([raw], 1) <= slot() : true;
};

test("a first save, read back", async () => {
  redis.clear();
  assert.equal(await saveLanding(stats, product, landing("first"), room), "saved");
  assert.deepEqual(await readLandings(stats, product), [landing("first")]);
  assert.ok(covered());
});

for (const shape of ["empty", "undefined", "malformed-json"] as const) {
  test(`a read answered ${shape} never erases a campaign already saved (Codex G and J)`, async () => {
    redis.clear();
    await saveLanding(stats, product, landing("existing"), room);
    const prior = stored();
    const pipeline = redis.pipeline;
    let intercepted = false;
    redis.pipeline = async (commands) => {
      if (!intercepted && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
        intercepted = true;
        return shape === "empty" ? [] : shape === "undefined" ? [undefined] : ["{broken"];
      }
      return pipeline(commands);
    };
    let outcome: unknown;
    try {
      outcome = await saveLanding(stats, product, landing("new"), room);
    } catch (error) {
      outcome = error;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(intercepted, true);
    assert.equal(stored(), prior, `the record was overwritten; answered ${String(outcome)}`);
    assert.notEqual(outcome, "saved");
  });
}

test("a write whose answer is not the expected one is never said saved (Codex G)", async () => {
  redis.clear();
  const pipeline = redis.pipeline;
  let intercepted = false;
  redis.pipeline = async (commands) => {
    if (commands.some(writes)) {
      intercepted = true;
      return [];
    }
    return pipeline(commands);
  };
  let outcome: unknown;
  try {
    outcome = await saveLanding(stats, product, landing("first"), room);
  } catch (error) {
    outcome = error;
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal(intercepted, true);
  assert.equal(stored(), null);
  assert.notEqual(outcome, "saved");
});

test("a delete whose answer is not the expected one gives no room back while the record is kept (Codex G)", async () => {
  redis.clear();
  await saveLanding(stats, product, landing("existing"), room);
  const prior = stored();
  const pipeline = redis.pipeline;
  let intercepted = false;
  redis.pipeline = async (commands) => {
    if (commands.some(deletes)) {
      intercepted = true;
      return [];
    }
    return pipeline(commands);
  };
  try {
    await dropLandings(stats, product, room);
  } catch {
    // Unknown: the record and its room stay counted.
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal(intercepted, true);
  assert.equal(stored(), prior);
  assert.ok(slot() >= dataBytes([String(prior)], 1), `the record is kept but its slot is ${slot()}`);
});

test("a large save held while a small one lands never leaves the record larger than its slot (Codex G and J)", async () => {
  redis.clear();
  const pipeline = redis.pipeline;
  const big = landing("large", "H".repeat(120), "S".repeat(300), "B".repeat(40));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  redis.pipeline = async (commands) => {
    if (!held && commands.some((c) => writes(c) && commands.some((x) => x.map(String).some((a) => a.includes(big.headline))))) {
      held = true;
      enter();
      await gate;
    }
    return pipeline(commands);
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = saveLanding(stats, product, big, room).catch((error: unknown) => error);
    await entered;
    assert.equal(await saveLanding(stats, product, landing("small", "Small", "", ""), room), "saved");
    const used = (await dataUsed(room))!.used;
    const limit = contentRoomFor(room, Date.now() / 1000);
    await needData(room, [{ slot: "other-valid-content", bytes: limit - used - 64, set: true }]);
    release();
    await pending;
    assert.ok(covered(), `stored ${dataBytes([String(stored())], 1)} bytes against a slot of ${slot()}`);
    assert.ok((await readLandings(stats, product)).some((one) => one.campaign === "small"), "the small save is kept");
  } finally {
    release();
    if (pending) await pending;
    redis.pipeline = pipeline;
  }
});

test("a removal frees only what it deleted, in the same step", async () => {
  redis.clear();
  await saveLanding(stats, product, landing("one"), room);
  await saveLanding(stats, product, landing("two"), room);
  await removeLanding(stats, product, "one", room);
  assert.deepEqual((await readLandings(stats, product)).map((one) => one.campaign), ["two"]);
  assert.ok(covered());
  await removeLanding(stats, product, "two", room);
  assert.deepEqual([stored(), slot()], [null, 0]);
});
