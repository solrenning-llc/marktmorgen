/**
 * The pre-review of claude5/images-count-storage @ 16edc6a536 (9 November 2026): each check failed on that head and
 * proves a finding (A: a picture taken whole lost by the pass that runs before its put; B: bytes given back twice
 * after a listing that already left the deleted picture out; C: one failed listing refusing file uploads; D: a file
 * deleted to make room not freeing it for pictures). Rule 23, kept as written but for: a pass now runs every two days
 * at the most, so B lists two days later; a pass answers "done" (before, true); and D deletes the file the way the
 * studio's routes do, giving its size back with the moment before the deletion (adjustImages), where the proof
 * deleted it behind every route's back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageFolder, storeFolder } from "@/lib/store";
import { adjustImages, admitImage, imagesHeld, reconcileImages, spaceUsed } from "@/lib/image-space";
import { files } from "./failure-cleanup-world";
import { store as redis } from "./redis-stub";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const DAY = 24 * 60 * 60 * 1000;
const passed = (ran: unknown) => ran === true || ran === "done";
let n = 1000;
const owner = () => `prerev.${++n}@example.com`;
const picture = async (ref: string, size: number) => {
  const path = `images/${await imageFolder(ref)}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  files.set(path, { bytes: JPEG, contentType: "image/jpeg", size });
  return path;
};
const real = async (ref: string) => {
  const prefix = `images/${await imageFolder(ref)}/`;
  return [...files].filter(([p]) => p.startsWith(prefix)).reduce((s, [, f]) => s + (f.size ?? f.bytes.length), 0);
};

test("A (MÉDIO): a whole picture taken on the day's reconciliation is lost from the counter before it is written", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const t0 = Date.now();
  await picture(ref, 100);
  await admitImage(ref, 1, 10_000, undefined, t0); // makes the counter (first reconciliation)
  // A day later a review photo of 400 bytes is admitted (TAKE, due): the reconciliation runs inside admitImage, before the put.
  await admitImage(ref, 400, 10_000, undefined, t0 + DAY);
  await picture(ref, 400); // the put that follows (lib/review-photo.ts)
  assert.equal(await imagesHeld(ref), await real(ref), "the counter must never be lower than what is stored");
});

test("B (LEVE): bytes given back after a reconciliation that already missed the deleted picture are taken off twice", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const t0 = Date.now();
  const p = await picture(ref, 500);
  await picture(ref, 800);
  await admitImage(ref, 1, 10_000, undefined, t0);
  // app/api/store/image: del(p) ... (a reconciliation elsewhere lists now) ... adjustImages(give=500)
  const since = Date.now();
  files.delete(p);
  assert.ok(passed(await reconcileImages(ref, t0 + 2 * DAY)));
  await adjustImages(ref, [], 500, { since });
  assert.equal(await imagesHeld(ref), await real(ref), "never lower than what is stored");
});

test("C (ALTO): one failed listing on a store's first reconciliation blocks its FILE uploads for a whole day", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const t0 = Date.now();
  await picture(ref, 100);
  // The listing of images/ fails once (here: an entry the listing refuses, as a 5xx or a timeout would): listImages is null.
  const broken = `images/${await imageFolder(ref)}/${"b".repeat(32)}.jpg`;
  files.set(broken, { bytes: JPEG, contentType: "image/jpeg", size: -1 });
  await reconcileImages(ref, t0);
  files.delete(broken);
  // Blob is back. A file door (app/api/store/file) asks an hour later: before this branch it measured files alone and went on.
  const held = await spaceUsed(ref, 10_000);
  assert.equal(held.available, true, "a file upload is refused as files_unavailable for 24 h after one failed picture listing");
});

test("D (MÉDIO): a file deleted to make room does not free room for a picture until the next day", async () => {
  redis.clear(); files.clear();
  const ref = owner();
  const t0 = Date.now();
  const big = `stores/${await storeFolder(ref)}/big.bin`;
  files.set(big, { bytes: JPEG, contentType: "application/octet-stream", size: 9_000 });
  await picture(ref, 500);
  await admitImage(ref, 1, 10_000, undefined, t0);
  const since = Date.now();
  files.delete(big); // the creator deletes the big file, as the studio tells them to
  await adjustImages(ref, [], 0, { files: 9_000, since }); // what every route that deletes a sold file now does
  await admitImage(ref, 2_000, 10_000, undefined, t0 + 60_000); // 501 + 2000 of 10000: must fit
});
