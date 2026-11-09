/**
 * lib/image-space.ts, step by step (owner's decision 8, 9 November 2026): the
 * counter of a store's pictures only ever errs upward, a counter that is not
 * whole refuses pictures but never files, the listing goes on where it stopped,
 * and a pass runs at most once every two days. Synthetic files in a file store
 * held in memory (tests/failure-cleanup-world.ts) and the in-memory Redis
 * (lib/redis-memory.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageFolder } from "@/lib/store";
import {
  IMAGE_FOLD_MS, IMAGE_LIST_PAGES, IMAGE_OPEN_MAX, IMAGE_SPACE_KEEP_SECONDS, ImageSpaceRefused, RECONCILE_EVERY_MS, adjustImages, admitImage,
  imagesHeld, listImages, noteFilesAuthorized, reconcileImages, spaceUsed,
} from "@/lib/image-space";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const EVERY = RECONCILE_EVERY_MS;
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
  await admitImage(ref, 1, 1_000);
  const held = await spaceUsed(ref, 1_000);
  assert.deepEqual([held.available, held.bytes, held.files, held.left], [true, 401, 0, 599]);
  await noteFilesAuthorized(ref, held.files, 500);
  // The file is not stored yet; the 500 bytes it may write are counted all the same.
  assert.equal(await refusedFor(admitImage(ref, 100, 1_000)), "full");
  assert.equal(await refusedFor(admitImage(ref, 99, 1_000)), "admitted");
  // A second door within the window adds to the first, never replaces it.
  await noteFilesAuthorized(ref, 0, 10);
  assert.equal(await field(ref, "files"), "510");
});

test("a file door is never refused because the pictures are not counted yet or cannot be read", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  // No counter at all: the files alone, as before this unit.
  assert.deepEqual([(await spaceUsed(ref, 1_000)).available, (await spaceUsed(ref, 1_000)).bytes], [true, 0]);
  await picture(ref, 300);
  await admitImage(ref, 1, 1_000);
  redis.run(["HSET", `nl:images:space:${await imageFolder(ref)}`, "held", "not a number"]);
  const held = await spaceUsed(ref, 1_000);
  assert.equal(held.available, true, "an unreadable counter refuses pictures, never a file");
  assert.equal(await refusedFor(admitImage(ref, 1, 1_000)), "unknown");
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
  await adjustImages(ref, [], 120, { since: Date.now() });
  assert.equal(await imagesHeld(ref), 0);
  await adjustImages(ref, [], 1, { since: Date.now() });
  assert.equal(await imagesHeld(ref), 0, "below zero is not given: higher, never lower");
  await adjustImages(ref, [], 0);
  await adjustImages(ref, [{ path, bytes: 5 }], 0);
  assert.equal(await imagesHeld(ref), 0, "nothing to settle once settled, nothing given without the moment of its deletion");
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

test("one pass every two days: not again sooner, and the listing finds what was deleted", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const old = await picture(ref, 700);
  const now = Date.now();
  await admitImage(ref, 100, 1_000, undefined, now);
  files.delete(old);
  assert.equal(await reconcileImages(ref, now + EVERY - 1), "skipped", "not twice within two days");
  assert.equal(await imagesHeld(ref), 800);
  assert.equal(await reconcileImages(ref, now + EVERY), "done");
  assert.equal(await imagesHeld(ref), 0, "the folder as listed (the 100 bytes were never written)");
  const ttl = Number(redis.run(["TTL", `nl:images:space:${await imageFolder(ref)}`]));
  assert.ok(ttl > IMAGE_SPACE_KEEP_SECONDS - 5 && ttl <= IMAGE_SPACE_KEEP_SECONDS, "kept a long while after, then gone");
});

test("a listing longer than a pass goes on where it stopped; pictures wait for it, files never do", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const folder = await imageFolder(ref);
  const count = IMAGE_LIST_PAGES * 1000 + 1;
  for (let i = 0; i < count; i += 1) files.set(`images/${folder}/${i.toString(16).padStart(32, "0")}.jpg`, { bytes: JPEG, contentType: "image/jpeg", size: 1 });
  const now = Date.now();
  assert.equal(await refusedFor(admitImage(ref, 1, 1e9, undefined, now)), "unknown", "the first pass lists IMAGE_LIST_PAGES pages and stops");
  const held = await spaceUsed(ref, 1e9);
  assert.deepEqual([held.available, held.bytes], [true, IMAGE_LIST_PAGES * 1000], "a file door counts what is listed so far, and is not refused");
  assert.equal(await reconcileImages(ref, now + 1), "skipped");
  assert.equal(await refusedFor(admitImage(ref, 1, 1e9, undefined, now + EVERY)), "admitted", "the next pass goes on from its cursor and finishes");
  assert.equal(await imagesHeld(ref), count + 1);
  assert.equal(await listImages(folder, "", 1, now - 1), null, "a listing past its deadline is not whole");
});

test("an unreadable counter refuses pictures until a pass makes it again", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const now = Date.now();
  await admitImage(ref, 10, 1_000, undefined, now);
  redis.run(["HSET", `nl:images:space:${await imageFolder(ref)}`, "held", "-5"]);
  assert.equal(await refusedFor(admitImage(ref, 10, 1_000, undefined, now)), "unknown");
  assert.equal((await spaceUsed(ref, 1_000)).available, true);
  assert.equal(await refusedFor(admitImage(ref, 10, 1_000, undefined, now + EVERY)), "admitted");
});

test("a file deleted with its size known gives its room to pictures at once, but not twice after a measurement", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const now = Date.now();
  await admitImage(ref, 1, 1_000, undefined, now);
  await noteFilesAuthorized(ref, 900, 0, now + 1);
  assert.equal(await refusedFor(admitImage(ref, 200, 1_000, undefined, now + 2)), "full");
  await adjustImages(ref, [], 0, { files: 400, since: now + 3 });
  assert.equal(await refusedFor(admitImage(ref, 200, 1_000, undefined, now + 4)), "admitted");
  // A measurement that began after a deletion already left it out: the give that follows is not taken off again.
  await noteFilesAuthorized(ref, 100, 0, now + 10 + 25 * 60 * 60 * 1000);
  await adjustImages(ref, [], 0, { files: 100, since: now + 5 });
  assert.equal(await field(ref, "files"), "100");
});
