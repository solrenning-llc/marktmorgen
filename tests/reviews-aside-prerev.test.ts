/**
 * Pre-review of claude5/reviews-recount-exact @ a8737e12a6 (9 November 2026), kept as its regression test. The proofs
 * (scratchpad prerev-reviews-recount-exact-proof.test.ts, R1 to R4) read a record set aside under a key of its own; a
 * record set aside is now a field of its product's hash of records set aside (nl:rev:bad:<store>:<product>, field the
 * review's id), so the probes read it with HGET. What they hold:
 *   R1  a record set aside never runs out by itself: an erasure after 30 days still finds it, and its photo;
 *   R2  a buyer who wrote again after their record was set aside: the erasure and their own delete hand over both photos;
 *   R3  a product removed takes its records set aside with it, and hands over their photos;
 *   R4  setting aside is one step that moves a record only while it is still the text read (a review written meanwhile stays);
 *   R5  more than REVIEW_ASIDE_MOST records, or more than half of a product's, that look damaged: nothing moved, unsure;
 *   R6  a record set aside that is deleted gives its room back.
 * Synthetic Redis only (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as reviews from "@/lib/reviews";
import { reviewId, saveReview, setHidden, setReviewPhoto, dropReviews, summaries, HIDE_REASONS, UNREAD_NUMBERS } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const api = reviews as unknown as Record<string, unknown>;
const forgetReviewsPerson = api.forgetReviewsPerson as (s: string, p: string[], email: string, room: typeof ROOM, files?: string[]) => Promise<{ records: number; photos: string[] }>;
const deleteOwnReview = api.deleteOwnReview as (s: string, p: string, id: string, room: typeof ROOM) => Promise<{ photo: string | null; alsoPhoto?: string } | string>;
const STATS = "abcdef0123456789abcdef0123456789";
const P1 = "qrnp1aaaaa";
const A = "proof-a@example.test";
const C = "proof-c@example.test";
const REASON = HIDE_REASONS[0].id;
const productKey = `nl:rev:${STATS}:${P1}`;
const asideKey = `nl:rev:bad:${STATS}:${P1}`;
const idA = reviewId(STATS, P1, A);
const idC = reviewId(STATS, P1, C);
const aside = (id: string) => redis.run(["HGET", asideKey, id]);
const realPipeline = redis.pipeline.bind(redis);
const quiet = async <T>(work: () => Promise<T>) => {
  const o = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = o;
    redis.pipeline = realPipeline;
  }
};

async function save(email: string, rating: number, at: number, product = P1) {
  const saved = await saveReview(STATS, { productId: product, email, reference: `cs_test_${rating}${at}`, pi: `pi_Proof${rating}${at}`, rating, text: "Synthetic words", name: "Synthetic Buyer" }, ROOM, at);
  assert.equal(saved.state, "created");
}

/** A's review with a photo, damaged so it no longer reads (its rating out of range) but still says whose photo it is; set aside by a recount. */
async function asideWithPhoto(): Promise<string> {
  redis.pipeline = realPipeline;
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  const path = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path, width: 1200, height: 900 })), "object");
  const raw = JSON.parse(redis.run(["HGET", productKey, idA]) as string);
  raw.rating = 9;
  redis.run(["HSET", productKey, idA, JSON.stringify(raw)]);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(redis.run(["HGET", productKey, idA]), null);
  assert.equal(typeof aside(idA), "string", "set aside");
  return path;
}

test("R1: a record set aside never runs out by itself; an erasure after 30 days finds it and its photo", async () => {
  const path = await asideWithPhoto();
  assert.equal(redis.run(["TTL", asideKey]), -1, "no time of its own");
  redis.advance(31 * 86_400_000);
  const files: string[] = [];
  const done = await quiet(() => forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual(done.photos, [path], JSON.stringify(done));
  assert.equal(aside(idA), null);
});

test("R2: a new review by the same buyer: the erasure hands over the old record's photo too, and deletes both", async () => {
  const old = await asideWithPhoto();
  await save(A, 3, 1_700_000_009_000);
  const fresh = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: fresh, width: 1200, height: 900 })), "object");
  const files: string[] = [];
  const done = await quiet(() => forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.equal(aside(idA), null, "the record set aside is deleted");
  assert.equal(redis.run(["HGET", productKey, idA]), null, "the new review is deleted");
  assert.deepEqual([...done.photos].sort(), [fresh, old].sort(), JSON.stringify(done));
  assert.deepEqual([...files].sort(), [fresh, old].sort());
});

test("R2b: the buyer's own delete, with a new review and the old one set aside, answers the old photo", async () => {
  const path = await asideWithPhoto();
  await save(A, 3, 1_700_000_009_000);
  const done = await quiet(() => deleteOwnReview(STATS, P1, idA, ROOM));
  assert.equal(typeof done, "object");
  const photos = [(done as { photo: string | null }).photo, (done as { alsoPhoto?: string }).alsoPhoto].filter(Boolean);
  assert.deepEqual(photos, [path], JSON.stringify(done));
  assert.equal(aside(idA), null);
});

test("R2c: the buyer's own delete with two photos answers both", async () => {
  const old = await asideWithPhoto();
  await save(A, 3, 1_700_000_009_000);
  const fresh = await reviewPhotoPath("proof-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path: fresh, width: 1200, height: 900 })), "object");
  const done = (await quiet(() => deleteOwnReview(STATS, P1, idA, ROOM))) as { photo: string | null; alsoPhoto?: string };
  assert.deepEqual([done.photo, done.alsoPhoto].sort(), [fresh, old].sort(), JSON.stringify(done));
});

test("R3: a product removed takes its records set aside with it, and hands over their photos", async () => {
  const path = await asideWithPhoto();
  const photos = await quiet(() => dropReviews(STATS, P1));
  assert.equal(redis.run(["HGET", productKey, idC]), null, "the product's reviews are gone");
  assert.equal(redis.run(["EXISTS", asideKey]), 0, "and its records set aside");
  assert.ok(photos.includes(path), JSON.stringify(photos));
});

test("R4: a review written while it is set aside is never deleted", async () => {
  redis.pipeline = realPipeline;
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  redis.run(["HSET", productKey, idA, "{not json"]);
  const fresh = JSON.stringify({ id: idA, productId: P1, reference: "cs_test_new", pi: "pi_New", rating: 2, text: "New words", name: "Synthetic Buyer", createdAt: 1_700_000_010_000, editedAt: 0, hidden: false, hiddenReason: null, refunded: false, reply: null, photo: null });
  redis.pipeline = (async (batch: Command[]) => {
    // The lock (10 s) ran out during a slow request: the buyer's save took it and wrote a fresh review in the field.
    if (batch.some((c) => (c[0] === "HDEL" && c[1] === productKey) || (c[0] === "EVAL" && String(c[1]).includes("review-set-aside")))) redis.run(["HSET", productKey, idA, fresh]);
    return realPipeline(batch);
  }) as typeof redis.pipeline;
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(redis.run(["HGET", productKey, idA]), fresh, "the fresh review stays where it was written");
  assert.equal(aside(idA), null, "and nothing was set aside in its place");
});

test("R5: too many records that look damaged: nothing is moved, the product is left unread", async () => {
  const most = api.REVIEW_ASIDE_MOST as number;
  assert.equal(typeof most, "number");
  // Half or more of a small product's records.
  redis.pipeline = realPipeline;
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(C, 4, 1_700_000_003_000);
  await save("proof-d@example.test", 3, 1_700_000_004_000);
  const idD = reviewId(STATS, P1, "proof-d@example.test");
  redis.run(["HSET", productKey, idA, "{not json"]);
  redis.run(["HSET", productKey, idD, "{not json either"]);
  await quiet(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(redis.run(["HGET", productKey, idA]), "{not json", "left in place");
  assert.equal(redis.run(["EXISTS", asideKey]), 0, "nothing set aside");
  assert.equal((await summaries(STATS)).get(P1), UNREAD_NUMBERS, "unread, never numbers from a guess");
  // More than REVIEW_ASIDE_MOST of a large product's records.
  redis.clear();
  const emails = Array.from({ length: most * 4 }, (_, i) => `proof-many-${i}@example.test`);
  for (const [i, email] of emails.entries()) await save(email, 4, 1_700_000_100_000 + i * 1000);
  for (const email of emails.slice(0, most + 1)) redis.run(["HSET", productKey, reviewId(STATS, P1, email), "{broken"]);
  await quiet(() => setHidden(STATS, P1, reviewId(STATS, P1, emails[emails.length - 1]), true, REASON));
  assert.equal(redis.run(["EXISTS", asideKey]), 0, "nothing set aside");
  assert.equal((await summaries(STATS)).get(P1), UNREAD_NUMBERS);
});

test("R6: a record set aside that its buyer deletes gives its room back", async () => {
  await asideWithPhoto();
  const before = (await dataUsed(ROOM))?.used as number;
  await quiet(() => deleteOwnReview(STATS, P1, idA, ROOM));
  const after = (await dataUsed(ROOM))?.used as number;
  assert.ok(after < before, `room given back: ${before} -> ${after}`);
});

test("R7: another product's records are untouched by this one's removal", async () => {
  await asideWithPhoto();
  await save(A, 4, 1_700_000_020_000, "qrnp2bbbbb");
  await quiet(() => dropReviews(STATS, P1));
  assert.equal(typeof redis.run(["HGET", `nl:rev:${STATS}:qrnp2bbbbb`, reviewId(STATS, "qrnp2bbbbb", A)]), "string");
});
