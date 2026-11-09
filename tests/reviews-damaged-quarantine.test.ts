/**
 * A damaged review record is set aside and the product is counted again from the others (owner's decision 11,
 * 9 November 2026: "quarentena e recontagem", option C).
 *
 * Before: one record in a product's hash that answered as text but did not read as its review (damaged, or another
 * review's under its field) made every recount of that product "unsure", so the product showed no stars, said as
 * unread, for good: waiting never changes a damaged record. The studio's overview (reviewsSince) refused to draw
 * while it was among the reviews it read.
 *
 * Now the recount (after each change, and the daily pass over the products whose numbers wait) moves each damaged
 * record out of the product's hash and lists into its product's hash of records set aside (nl:rev:bad:<store>:<product>,
 * field its id; no time of its own since the pre-review of a8737e12a6), and counts the readable ones, so the product
 * shows stars again. The record is never rewritten from a guess and never lost: it is moved in one step, only while it
 * is still the text read. An unknown answer on the way leaves the product unread (its mark), never numbers made up.
 * Rule 23 (pre-review of a8737e12a6): the probes read the record set aside with HGET of that hash (they read a key of
 * its own with GET); it has no TTL (it had 30 days); the unknown answer is the move's own (it was the SET's); and the
 * erasure case adds a fourth review, since two damaged records of three are now too many to move (REVIEW_ASIDE_MOST).
 *
 * A buyer's own delete and a person's erasure find their record where it was set aside, and delete it there.
 * Another person's record set aside is never touched. The log names ids, never anything personal.
 * Synthetic Redis only (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as reviews from "@/lib/reviews";
import { reviewId, reviewsSince, saveReview, setHidden, setReviewPhoto, summaries, HIDE_REASONS, UNREAD_NUMBERS } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Command = (string | number)[];
type Pass = { stores: number; recounted: number; unsure: number; busy: number; capped: boolean; complete: boolean };
const api = reviews as unknown as Record<string, unknown>;
const recountWaiting = api.recountWaiting as (deadline: number) => Promise<Pass>;
const deleteOwnReview = api.deleteOwnReview as (s: string, p: string, id: string, room: typeof ROOM) => Promise<unknown>;
const forgetReviewsPerson = api.forgetReviewsPerson as (s: string, p: string[], email: string, room: typeof ROOM, files?: string[]) => Promise<{ records: number; photos: string[] }>;

const STATS = "abcdef0123456789abcdef0123456789";
const P1 = "qrnp1aaaaa";
const A = "quarantine-a@example.test";
const B = "quarantine-b@example.test";
const C = "quarantine-c@example.test";
const REASON = HIDE_REASONS[0].id;
const productKey = `nl:rev:${STATS}:${P1}`;
const visKey = `nl:rev:vis:${STATS}:${P1}`;
const allKey = `nl:rev:all:${STATS}`;
const newKey = `nl:rev:new:${STATS}`;
const sumKey = `nl:rev:sum:${STATS}`;
const aside = (id: string) => redis.run(["HGET", `nl:rev:bad:${STATS}:${P1}`, id]);
const realPipeline = redis.pipeline.bind(redis);
const idA = reviewId(STATS, P1, A);
const idB = reviewId(STATS, P1, B);
const idC = reviewId(STATS, P1, C);

async function save(email: string, rating: number, at: number): Promise<void> {
  const saved = await saveReview(STATS, { productId: P1, email, reference: `cs_test_${rating}${at}`, pi: `pi_Quarantine${rating}${at}`, rating, text: "Synthetic words", name: "Synthetic Buyer" }, ROOM, at);
  assert.ok(saved.state === "created");
}

/** A rates 5, B rates 1, C rates 4; then B's record is damaged as `make` says. */
async function setup(make: (json: string) => string = () => "{not json"): Promise<void> {
  redis.pipeline = realPipeline;
  redis.clear();
  await save(A, 5, 1_700_000_001_000);
  await save(B, 1, 1_700_000_002_000);
  await save(C, 4, 1_700_000_003_000);
  const raw = redis.run(["HGET", productKey, idB]);
  assert.equal(typeof raw, "string");
  redis.run(["HSET", productKey, idB, make(raw as string)]);
}

async function shown(): Promise<unknown> {
  const one = (await summaries(STATS)).get(P1);
  return one === UNREAD_NUMBERS ? "unread" : one && typeof one === "object" ? [one.count, one.stars] : one ?? "none";
}

async function logged<T>(work: () => Promise<T>): Promise<{ value: T | Error; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await work().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))), lines };
  } finally {
    console.error = original;
    redis.pipeline = realPipeline;
  }
}

const members = (key: string) => redis.run(["ZRANGEBYSCORE", key, "-inf", "+inf"]) as string[];

test("a change to another review: the damaged record is set aside and the product shows stars from the others", async () => {
  await setup();
  const { lines } = await logged(() => setHidden(STATS, P1, idC, true, REASON));
  // A (5) and C (4, hidden: the numbers count it, as the page says) are read; B's damaged record is not counted.
  assert.deepEqual(await shown(), [2, 9], "stars again, from the readable records");
  assert.equal(redis.run(["HGET", productKey, idB]), null, "the damaged record left the product's hash");
  assert.equal(aside(idB), "{not json", "it was set aside as it was, never rewritten");
  assert.equal(redis.run(["TTL", `nl:rev:bad:${STATS}:${P1}`]), -1, "no time of its own: it goes with its person, product or store");
  assert.ok(!members(visKey).includes(idB), "off the product's page list");
  assert.ok(!members(allKey).includes(`${P1}|${idB}`), "off the studio's list");
  assert.ok(!members(newKey).includes(`${P1}|${idB}`), "off the creator's queue");
  assert.equal(typeof redis.run(["HGET", productKey, idA]), "string", "A's record is untouched");
  assert.ok(lines.some((line) => line.includes(`${P1}|${idB}`)), "the log names the record by its ids");
  assert.ok(!lines.some((line) => /quarantine-b@|Synthetic Buyer|Synthetic words/.test(line)), "nothing personal in the log");
});

test("a record under another review's id is set aside the same way", async () => {
  await setup(() => redis.run(["HGET", productKey, idA]) as string);
  await logged(() => setHidden(STATS, P1, idC, true, REASON));
  assert.deepEqual(await shown(), [2, 9]);
  assert.equal(redis.run(["HGET", productKey, idB]), null);
  assert.equal(typeof aside(idB), "string");
});

test("the daily pass sets aside a damaged record whose product waits, and shows its stars again", async () => {
  await setup();
  // The product's numbers marked as waiting (as markRefunded does when it meets a damaged record).
  redis.run(["HSET", sumKey, P1, `recount:${"0".repeat(24)}`]);
  assert.equal(await shown(), "unread");
  const { value } = await logged(() => recountWaiting(Date.now() + 10_000));
  assert.ok(!(value instanceof Error), String(value));
  assert.equal((value as Pass).recounted, 1, "counted again, never unsure for good");
  assert.deepEqual(await shown(), [2, 9]);
  assert.equal(aside(idB), "{not json");
});

test("the studio's overview reads again once the damaged record is set aside", async () => {
  await setup();
  await logged(() => setHidden(STATS, P1, idC, true, REASON));
  const read = await reviewsSince(STATS, 0).catch((error: unknown) => String(error));
  assert.equal(typeof read, "object", String(read));
  assert.deepEqual((read as { reviews: { id: string }[] }).reviews.map((review) => review.id).sort(), [idA, idC].sort());
});

test("unknown on the way: the aside write answered in another shape leaves the record in place and the product unread", async () => {
  await setup();
  redis.pipeline = (async (batch: Command[]) => {
    if (batch.some((command) => command[0] === "EVAL" && String(command[1]).includes("review-set-aside"))) return [];
    return realPipeline(batch);
  }) as typeof redis.pipeline;
  await logged(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(await shown(), "unread", "never numbers made up");
  assert.equal(redis.run(["HGET", productKey, idB]), "{not json", "the record is never taken out before it is set aside");
});

test("a buyer's own delete finds their record where it was set aside, and deletes it there", async () => {
  await setup();
  await logged(() => setHidden(STATS, P1, idC, true, REASON));
  const { value } = await logged(() => deleteOwnReview(STATS, P1, idB, ROOM));
  assert.equal(typeof value, "object", String(value));
  assert.equal((value as { state: string }).state, "deleted");
  assert.equal(aside(idB), null, "gone from where it was set aside");
  assert.deepEqual(await shown(), [2, 9], "the numbers never counted it");
});

test("a person's erasure finds their record set aside, its photo too, and leaves another person's alone", async () => {
  await setup();
  await save("quarantine-d@example.test", 3, 1_700_000_004_000);
  const path = await reviewPhotoPath("quarantine-owner@example.test", "image/jpeg");
  assert.equal(typeof (await setReviewPhoto(STATS, P1, idA, { path, width: 1200, height: 900 })), "object");
  // A's record damaged too, its last character cut: what the record keeps still says whose photo it is.
  const rawA = redis.run(["HGET", productKey, idA]) as string;
  redis.run(["HSET", productKey, idA, rawA.slice(0, -1)]);
  await logged(() => setHidden(STATS, P1, idC, true, REASON));
  assert.equal(typeof aside(idA), "string", "A's record was set aside");
  assert.equal(typeof aside(idB), "string", "B's record was set aside");
  const files: string[] = [];
  const { value } = await logged(() => forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.ok(!(value instanceof Error), String(value));
  assert.equal((value as { records: number }).records, 1, "A's record erased");
  assert.deepEqual((value as { photos: string[] }).photos, [path], "its photo found where it was set aside");
  assert.deepEqual(files, [path]);
  assert.equal(aside(idA), null, "A's record is gone");
  assert.equal(aside(idB), "{not json", "B's record is never touched");
  const again = await logged(() => forgetReviewsPerson(STATS, [P1], A, ROOM));
  assert.equal((again.value as { records: number }).records, 0, "a retry finds nothing left");
});

// Rule 23 (pre-review of a8737e12a6): held a time set aside of at most 30 days; a record set aside now has none, and
// what is bounded is how many one recount may move (REVIEW_ASIDE_MOST, tests/reviews-aside-prerev.test.ts R5).
test("how many records one recount may set aside is bounded", () => {
  assert.equal(typeof api.REVIEW_ASIDE_MOST, "number");
  assert.ok((api.REVIEW_ASIDE_MOST as number) > 0 && (api.REVIEW_ASIDE_MOST as number) <= 10);
});
