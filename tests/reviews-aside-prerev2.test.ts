/**
 * Second pre-review of claude5/reviews-recount-exact @ fc75f6a256 (9 November 2026), kept as its regression test, from
 * the reviewer's proofs (scratchpad prerev-reviews-recount-exact-2-proof.test.ts, X0 to X4):
 *   X1  a second record of the same buyer set aside never writes over the first: each gets a field of its own
 *       (<id>, <id>:1 ... <id>:9), and the erasure finds them all, with their photos;
 *   X2  a record set aside that its buyer deletes gives no room back: its size as stored is the damaged text's, not
 *       what its review took ("a damaged record's size is unknown: it stays counted");
 *   X3  more records that do not read than may be set aside: after REVIEW_UNREAD_SHOWN_AFTER_DAYS (7) of the same
 *       reason, the product shows the stars of the records that read, with "N reviews could not be read", and the
 *       records that do not read stay where they are; before that, unread;
 *   X4  a product removed hands over the photo a damaged record still in its hash names (ownRecord), as one set aside;
 *   X0  control: a wholly unreadable record set aside is found by its field and erased.
 * Synthetic Redis only (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as reviews from "@/lib/reviews";
import { reviewId, saveReview, setHidden, setReviewPhoto, summaries, HIDE_REASONS, UNREAD_NUMBERS } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { dataUsed } from "@/lib/store-data";
import { wordsIn } from "@/lib/buyer-words";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Pass = { stores: number; recounted: number; unsure: number };
const api = reviews as unknown as Record<string, unknown>;
const forgetReviewsPerson = api.forgetReviewsPerson as (s: string, p: string[], email: string, room: typeof ROOM, files?: string[]) => Promise<{ records: number; photos: string[] }>;
const deleteOwnReview = api.deleteOwnReview as (s: string, p: string, id: string, room: typeof ROOM) => Promise<unknown>;
const recountWaiting = api.recountWaiting as (deadline: number) => Promise<Pass>;
const dropReviews = api.dropReviews as (s: string, p: string) => Promise<string[]>;
const STATS = "abcdef0123456789abcdef0123456789";
const P1 = "qrnp1aaaaa";
const A = "proof-a@example.test";
const B = "proof-b@example.test";
const C = "proof-c@example.test";
const REASON = HIDE_REASONS[0].id;
const productKey = `nl:rev:${STATS}:${P1}`;
const asideKey = `nl:rev:bad:${STATS}:${P1}`;
const sumKey = `nl:rev:sum:${STATS}`;
const idA = reviewId(STATS, P1, A);
const idB = reviewId(STATS, P1, B);
const idC = reviewId(STATS, P1, C);
const quiet = async <T>(work: () => Promise<T>) => {
  const o = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = o;
  }
};

async function save(email: string, rating: number, at: number, text = "Synthetic words") {
  const saved = await saveReview(STATS, { productId: P1, email, reference: `cs_test_${rating}${at}`, pi: `pi_Proof${rating}${at}`, rating, text, name: "Synthetic Buyer" }, ROOM, at);
  assert.equal(saved.state, "created");
}
function damage(id: string) {
  const raw = JSON.parse(redis.run(["HGET", productKey, id]) as string);
  raw.rating = 9;
  redis.run(["HSET", productKey, id, JSON.stringify(raw)]);
}

test("X1: a second record of the same buyer set aside keeps the first; the erasure finds both photos", async () => {
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  await save("proof-d@example.test", 4, 1_700_000_004_000);
  const old = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: old, width: 1200, height: 900 })), "object");
  damage(idA);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(typeof redis.run(["HGET", asideKey, idA]), "string", "first set aside");
  await save(A, 3, 1_700_000_009_000);
  const fresh = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: fresh, width: 1200, height: 900 })), "object");
  damage(idA);
  await quiet(() => setHidden(STATS, P1, idC, false, REASON));
  assert.equal(redis.run(["HGET", productKey, idA]), null, "second set aside");
  assert.equal(typeof redis.run(["HGET", asideKey, `${idA}:1`]), "string", "under a field of its own");
  const files: string[] = [];
  const done = await quiet(() => forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual([...done.photos].sort(), [fresh, old].sort(), JSON.stringify(done));
  assert.equal(redis.run(["HGET", asideKey, idA]), null);
  assert.equal(redis.run(["HGET", asideKey, `${idA}:1`]), null);
});

test("X1b: the buyer's own delete finds every record of theirs set aside and answers every photo", async () => {
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  await save("proof-d@example.test", 4, 1_700_000_004_000);
  const old = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: old, width: 1200, height: 900 })), "object");
  damage(idA);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  await save(A, 3, 1_700_000_009_000);
  const fresh = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: fresh, width: 1200, height: 900 })), "object");
  damage(idA);
  await quiet(() => setHidden(STATS, P1, idC, false, REASON));
  const done = (await quiet(() => deleteOwnReview(STATS, P1, idA, ROOM))) as { photo: string | null; alsoPhotos?: string[] };
  assert.deepEqual([done.photo, ...(done.alsoPhotos ?? [])].sort(), [fresh, old].sort(), JSON.stringify(done));
  assert.equal(redis.run(["HLEN", asideKey]), 0, "none left (the stand-in keeps an emptied hash; Redis drops it)");
});

test("X2: a record set aside that its buyer deletes gives no room back", async () => {
  redis.clear();
  await save(A, 5, 1_700_000_001_000, "Long words ".repeat(150));
  await save(B, 1, 1_700_000_002_000, "Short");
  await save(C, 4, 1_700_000_003_000);
  redis.run(["HSET", productKey, idB, redis.run(["HGET", productKey, idA]) as string]);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(typeof redis.run(["HGET", asideKey, idB]), "string");
  const before = (await dataUsed(ROOM))?.used as number;
  await quiet(() => deleteOwnReview(STATS, P1, idB, ROOM));
  assert.equal((await dataUsed(ROOM))?.used, before, "its size is unknown: it stays counted");
});

test("X3: too many records that do not read: unread for a week, then the readable ones' stars with a note", async () => {
  redis.clear();
  const emails = Array.from({ length: 10 }, (_, i) => `proof-many-${i}@example.test`);
  for (const [i, email] of emails.entries()) await save(email, 4, 1_700_000_100_000 + i * 1000);
  for (const email of emails.slice(0, 4)) redis.run(["HSET", productKey, reviewId(STATS, P1, email), "{broken"]);
  redis.run(["HSET", sumKey, P1, `recount:${"0".repeat(24)}`]);
  const days = api.REVIEW_UNREAD_SHOWN_AFTER_DAYS as number;
  assert.equal(days, 7);
  const realNow = Date.now;
  try {
    const start = realNow();
    for (const day of [0, 1, 6]) {
      Date.now = () => start + day * 86_400_000;
      const pass = await quiet(() => recountWaiting(Date.now() + 10_000));
      assert.equal(pass.unsure, 1, `day ${day}: unsure`);
      assert.equal((await summaries(STATS)).get(P1), UNREAD_NUMBERS, `day ${day}: unread`);
    }
    Date.now = () => start + 7 * 86_400_000 + 1000;
    const pass = await quiet(() => recountWaiting(Date.now() + 10_000));
    assert.equal(pass.recounted, 1, "counted from the records that read");
    const shown = (await summaries(STATS)).get(P1) as { count: number; stars: number; unread?: number };
    assert.equal(typeof shown, "object");
    assert.deepEqual([shown.count, shown.stars, shown.unread], [6, 24, 4]);
  } finally {
    Date.now = realNow;
  }
  assert.equal(redis.run(["HGET", productKey, reviewId(STATS, P1, emails[0])]), "{broken", "the records that do not read stay where they are");
  assert.equal(redis.run(["HLEN", asideKey]) ?? 0, 1, "only the time it began is kept beside them");
  assert.equal(wordsIn("en").reviewsUnreadKept(4), "4 reviews could not be read");
  assert.equal(wordsIn("en").reviewsUnreadKept(1), "1 review could not be read");
  for (const language of ["de", "es", "fr", "it", "nl", "pt"] as const) assert.match(wordsIn(language).reviewsUnreadKept(2), /^2\b/, language);
  assert.match(readFileSync("components/review-list.tsx", "utf8"), /w\.reviewsUnreadKept\(summary\.unread\)/);
});

test("X4: a product removed hands over the photo a damaged record still in its hash names", async () => {
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  const path = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path, width: 1200, height: 900 })), "object");
  damage(idA);
  const photos = await quiet(() => dropReviews(STATS, P1));
  assert.ok(photos.includes(path), JSON.stringify(photos));
});

test("X0 (control): a wholly unreadable record set aside is found by its field and erased", async () => {
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(B, 1, 1_700_000_002_000);
  await save(C, 4, 1_700_000_003_000);
  redis.run(["HSET", productKey, idB, "\u0000garbage"]);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(redis.run(["HGET", asideKey, idB]), "\u0000garbage");
  const done = await quiet(() => forgetReviewsPerson(STATS, [P1], B, ROOM, []));
  assert.equal(done.records, 1);
  assert.equal(redis.run(["HGET", asideKey, idB]), null);
  assert.equal(typeof redis.run(["HGET", productKey, idA]), "string");
});
