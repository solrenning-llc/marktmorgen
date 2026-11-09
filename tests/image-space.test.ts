/**
 * lib/image-space.ts, step by step (owner's decision 8, 9 November 2026): the
 * counter of a store's pictures only ever errs upward, an unreadable one
 * refuses, and a reconciliation runs at most once a day. Synthetic files in a
 * file store held in memory (tests/failure-cleanup-world.ts) and the
 * in-memory Redis (lib/redis-memory.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageFolder } from "@/lib/store";
import {
  IMAGE_FOLD_MS, IMAGE_OPEN_MAX, IMAGE_SPACE_KEEP_SECONDS, ImageSpaceRefused, adjustImages, admitImage, imagesHeld,
  noteFilesAuthorized, reconcileImages, spaceUsed,
} from "@/lib/image-space";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const DAY = 24 * 60 * 60 * 1000;
const refusedFor = (promise: Promise<unknown>) => promise.then(() => "admitted", (error: unknown) => (error instanceof ImageSpaceRefused ? error.reason : String(error)));
let n = 0;
const owner = () => `space.${++n}@example.com`;
const picture = async (ref: string, size: number, name = (++n).toString(16).padStart(32, "0")) => {
  const path = `images/${await imageFolder(ref)}/${name}.jpg`;
  files.set(path, { bytes: JPEG, contentType: "image/jpeg", size });
  return path;
};
const field = async (ref: string, name: string) => redis.run(["HGET", `nl:images:space:${await imageFolder(ref)}`, name]);

test("a first admission lists the folder once, and counts the pictures already there", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  await picture(ref, 600);
  await admitImage(ref, 300, 1_000);
  assert.equal(await imagesHeld(ref), 900);
  assert.equal(await refusedFor(admitImage(ref, 101, 1_000)), "full");
  assert.equal(await refusedFor(admitImage(ref, 100, 1_000)), "admitted");
});

test("a file door sees the pictures, and a picture sees what the file door signed for", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  await picture(ref, 400);
  const held = await spaceUsed(ref, 1_000);
  assert.deepEqual([held.available, held.bytes, held.files, held.left], [true, 400, 0, 600]);
  await noteFilesAuthorized(ref, held.files, 500);
  // The file is not stored yet; the 500 bytes it may write are counted all the same.
  assert.equal(await refusedFor(admitImage(ref, 101, 1_000)), "full");
  assert.equal(await refusedFor(admitImage(ref, 100, 1_000)), "admitted");
  // A second door within the window adds to the first, never replaces it.
  await noteFilesAuthorized(ref, 0, 10);
  assert.equal(await field(ref, "files"), "510");
});

test("a door's picture is held at what it may weigh, settled to its size, and given back when deleted", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const folder = await imageFolder(ref);
  const path = `images/${folder}/${"a".repeat(32)}.jpg`;
  await admitImage(ref, 1_000, 10_000, path);
  assert.equal(await imagesHeld(ref), 1_000);
  assert.equal(await refusedFor(admitImage(ref, 1_000, 10_000, path)), "busy", "one name waits once");
  await adjustImages(ref, [{ path, bytes: 120 }]);
  assert.equal(await imagesHeld(ref), 120);
  await adjustImages(ref, [{ path, bytes: 120 }]);
  assert.equal(await imagesHeld(ref), 120, "settled once");
  await adjustImages(ref, [], 120);
  assert.equal(await imagesHeld(ref), 0);
  await adjustImages(ref, [], 1);
  assert.equal(await imagesHeld(ref), null, "below zero is unknown, never zero");
  assert.equal(await refusedFor(admitImage(ref, 1, 10_000)), "unknown");
});

test("door pictures waiting are capped, and one older than the fold is counted for good at what it may weigh", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const folder = await imageFolder(ref);
  const now = Date.now();
  for (let i = 0; i < IMAGE_OPEN_MAX; i += 1) await admitImage(ref, 10, 1e9, `images/${folder}/${i.toString(16).padStart(32, "0")}.jpg`, now);
  assert.equal(await refusedFor(admitImage(ref, 10, 1e9, `images/${folder}/${"f".repeat(32)}.jpg`, now)), "busy");
  await admitImage(ref, 10, 1e9, `images/${folder}/${"e".repeat(32)}.jpg`, now + IMAGE_FOLD_MS + 1);
  assert.equal(await field(ref, "held"), String(IMAGE_OPEN_MAX * 10));
  assert.equal(await field(ref, "pend"), "10");
});

test("one reconciliation a day: a listing that is not whole never lowers the counter", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const old = await picture(ref, 700);
  const now = Date.now();
  await admitImage(ref, 100, 1_000, undefined, now);
  files.delete(old);
  assert.equal(await reconcileImages(ref, now + 1), false, "not twice the same day");
  assert.equal(await imagesHeld(ref), 800);
  assert.equal(await reconcileImages(ref, now + DAY), true);
  assert.equal(await imagesHeld(ref), 0, "the folder as listed (the 100 bytes were never written)");
  const ttl = Number(redis.run(["TTL", `nl:images:space:${await imageFolder(ref)}`]));
  assert.ok(ttl > IMAGE_SPACE_KEEP_SECONDS - 5 && ttl <= IMAGE_SPACE_KEEP_SECONDS, "kept a while after, then gone");
});

test("an unreadable counter refuses every way in until a reconciliation makes it again", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const now = Date.now();
  await admitImage(ref, 10, 1_000, undefined, now);
  redis.run(["HSET", `nl:images:space:${await imageFolder(ref)}`, "held", "-5"]);
  assert.equal(await refusedFor(admitImage(ref, 10, 1_000, undefined, now)), "unknown");
  assert.equal((await spaceUsed(ref, 1_000)).available, false);
  assert.equal(await refusedFor(admitImage(ref, 10, 1_000, undefined, now + DAY)), "admitted");
});
