/**
 * CX-123 rule 24 (Claude 6 audit, round 2): a person's erasure of their reviews (forgetReviewsPerson, registered in
 * lib/person-erasure.ts) and the buyer's own delete (deleteReview) read every Redis reply in its exact shape.
 *
 * Only a confirmed absent field (null) means "no review". A reply in another shape throws UnknownReplyError: the
 * review (name, words, photo) is kept for the retry and the erasure is never reported as done. A stored review under
 * the person's own id that does not read is damaged and is deleted (tests/reviews-damaged-erasure.test.ts). Each deletion reply is checked exactly (an integer in range, "OK" for the summary's version), and
 * a payment's list of reviews is never wiped on an unknown read. The healthy and confirmed-empty paths are unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteReview, forgetReviewsPerson, reviewId, saveReview, setReviewPhoto } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const STATS = "0123456789abcdef0123456789abcdef";
const P1 = "erasep1aaaa";
const P2 = "erasep2bbbb";
const BUYER = "erase-buyer@example.test";
const PI = "pi_EraseSynthetic01";
const productKey = (p: string) => `nl:rev:${STATS}:${p}`;
const payKey = `nl:rev:pay:${STATS}`;
const realPipeline = redis.pipeline.bind(redis);

async function setup(): Promise<{ id1: string; id2: string }> {
  redis.pipeline = realPipeline;
  redis.clear();
  for (const p of [P1, P2]) {
    const saved = await saveReview(STATS, { productId: p, email: BUYER, reference: "cs_test_EraseSynthetic01", pi: PI, rating: 4, text: "Synthetic words", name: "Synthetic Buyer" }, ROOM);
    assert.equal(saved.state, "created");
  }
  return { id1: reviewId(STATS, P1, BUYER), id2: reviewId(STATS, P2, BUYER) };
}

const stored = (p: string, id: string) => redis.run(["HGET", productKey(p), id]);
const payEntry = () => redis.run(["HGET", payKey, PI]);
const used = async () => (await dataUsed(ROOM))?.used;

/** Answers `shape` (without running anything) for the first request that `matches`; every other request runs. */
function answerOnce(matches: (commands: Command[]) => boolean, shape: unknown): Command[][] {
  const seen: Command[][] = [];
  let done = false;
  redis.pipeline = (async (commands: Command[]) => {
    seen.push(commands);
    if (!done && matches(commands)) {
      done = true;
      return shape as unknown[];
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  return seen;
}

/** Runs the first request that `matches`, then answers its replies as `mangle` makes them. */
function mangleOnce(matches: (commands: Command[]) => boolean, mangle: (replies: unknown[]) => unknown): void {
  let done = false;
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await realPipeline(commands);
    if (!done && matches(commands)) {
      done = true;
      return mangle(replies) as unknown[];
    }
    return replies;
  }) as typeof redis.pipeline;
}

const readsReviews = (commands: Command[]) => commands.length > 0 && commands.every((c) => c[0] === "HGET" && String(c[1]).startsWith(`nl:rev:${STATS}:`));
const readsPay = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === payKey;
const writesPay = (commands: Command[]) => commands.length === 1 && (commands[0][0] === "HSET" || commands[0][0] === "HDEL") && commands[0][1] === payKey;
const deletesReview = (commands: Command[]) => commands.some((c) => c[0] === "HDEL" && String(c[1]).startsWith(`nl:rev:${STATS}:`));
// What the erasure writes to the reviews' records (the product's lock, taken and let go of around it, is not one).
const wrote = (seen: Command[][]) =>
  seen.flat().some((c) => ["HDEL", "ZREM", "DEL", "HSET", "SET", "ZREMRANGEBYSCORE"].includes(String(c[0])) && String(c[1]).startsWith("nl:r") && !String(c[1]).startsWith("nl:rev:lock:"));
const unknown = (error: unknown) => error instanceof UnknownReplyError;

test("healthy control: the person's review, its index entries and its payment member go; nothing else does", async () => {
  const { id1, id2 } = await setup();
  const before = await used();
  const done = await forgetReviewsPerson(STATS, [P1], BUYER, ROOM);
  assert.deepEqual(done, { records: 1, photos: [] });
  assert.equal(stored(P1, id1), null);
  assert.notEqual(stored(P2, id2), null);
  assert.equal(payEntry(), `${P2}|${id2}`);
  assert.ok((await used())! < before!);
  assert.deepEqual(await forgetReviewsPerson(STATS, [P1, P2], BUYER, ROOM), { records: 1, photos: [] });
  assert.equal(payEntry(), null, "the payment's last member goes with its entry");
});

test("confirmed empty control: nobody's review is 0 records and no write", async () => {
  await setup();
  const seen = answerOnce(() => false, null);
  assert.deepEqual(await forgetReviewsPerson(STATS, [P1, P2], "nobody@example.test", ROOM), { records: 0, photos: [] });
  assert.equal(wrote(seen), false);
  assert.equal(await deleteReview(STATS, P1, reviewId(STATS, P1, "nobody@example.test"), ROOM), "missing");
});

for (const [name, shape] of [
  ["[undefined]", [undefined]],
  ["a number", [42]],
  ["an object", [{}]],
  ["a list", [["x"]]],
  ["too few replies", []],
  ["not a list", { 0: null }],
] as [string, unknown][]) {
  test(`the erasure's read answered ${name}: thrown as unknown, the review kept, nothing deleted`, async () => {
    const { id1 } = await setup();
    const seen = answerOnce(readsReviews, shape);
    await assert.rejects(forgetReviewsPerson(STATS, [P1], BUYER, ROOM), unknown);
    assert.equal(wrote(seen), false);
    assert.notEqual(stored(P1, id1), null);
    assert.equal(payEntry(), `${P1}|${id1};${P2}|${reviewId(STATS, P2, BUYER)}`);
  });

  test(`the buyer's delete read answered ${name}: thrown as unknown, never "missing", the review kept`, async () => {
    const { id1 } = await setup();
    const seen = answerOnce(readsReviews, shape);
    await assert.rejects(deleteReview(STATS, P1, id1, ROOM), unknown);
    assert.equal(wrote(seen), false);
    assert.notEqual(stored(P1, id1), null);
  });
}

// Changed 9 Nov 2026 (rule 23; coordinator's decision): a stored review under the person's own id that does not read
// is damaged, not unknown. Waiting never changes it, and deleting the person's own field is the safe side of their
// erasure: it is deleted, never kept for a retry that can never finish (tests/reviews-damaged-erasure.test.ts).
test("a stored review under the person's own id that does not read is damaged: erased and deleted, never 'no review'", async () => {
  const { id1 } = await setup();
  redis.run(["HSET", productKey(P1), id1, "{not json"]);
  const quiet = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await forgetReviewsPerson(STATS, [P1], BUYER, ROOM), { records: 1, photos: [] });
    assert.equal(stored(P1, id1), null);
    redis.run(["HSET", productKey(P1), id1, "{not json"]);
    assert.equal(await deleteReview(STATS, P1, id1, ROOM), "deleted");
    assert.equal(stored(P1, id1), null);
  } finally {
    console.error = quiet;
  }
});

for (const [name, mangle] of [
  ["the review's HDEL as text", (r: unknown[]) => r.map((x, i) => (i === r.length - 1 || i === 0 ? String(x) : x))],
  ["one reply short", (r: unknown[]) => r.slice(0, -1)],
  ["a ZREM as 2", (r: unknown[]) => r.map((x, i) => (i === 1 ? 2 : x))],
  ["the summary's SET as null", (r: unknown[]) => r.map((x) => (x === "OK" ? null : x))],
] as [string, (r: unknown[]) => unknown][]) {
  test(`a deletion that ran but was answered with ${name}: read again, confirmed gone, "deleted", no room given back`, async () => {
    const { id1 } = await setup();
    const before = await used();
    mangleOnce(deletesReview, mangle);
    assert.equal(await deleteReview(STATS, P1, id1, ROOM), "deleted");
    assert.equal(stored(P1, id1), null);
    assert.equal(await used(), before, "only an exact 1 from its own HDEL gives the room back");
  });
}

/** A photo on the person's review of P1, as the buyer's own photo is kept (lib/review-photo.ts). */
async function withPhoto(id1: string): Promise<string> {
  const path = await reviewPhotoPath("erase-owner@example.test", "image/jpeg");
  const put = await setReviewPhoto(STATS, P1, id1, { path, width: 1200, height: 900 });
  assert.equal(typeof put, "object");
  return path;
}

/** One ZREM reply of the delete request turned into text (Claude 2's probe on #3224): the request ran, its reply is unknown. */
const zremAsText = (r: unknown[]) => r.map((x, i) => (i === 1 ? String(x) : x));

/** The erasure as lib/person-erasure.ts runs it, then once more: every photo path it was handed, on either run. */
async function eraseTwice(): Promise<{ first: unknown; handed: Set<string> }> {
  const files: string[] = [];
  const handed = new Set<string>();
  const first = await forgetReviewsPerson(STATS, [P1], BUYER, ROOM, files).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (!(first instanceof Error)) for (const path of first.photos) handed.add(path);
  for (const path of files) handed.add(path);
  redis.pipeline = realPipeline;
  const again = await forgetReviewsPerson(STATS, [P1], BUYER, ROOM, files);
  for (const path of [...again.photos, ...files]) handed.add(path);
  return { first, handed };
}

test("the erasure's delete ran but its reply is unknown: the photo path still reaches the eraser, the room is not given back", async () => {
  const { id1 } = await setup();
  const path = await withPhoto(id1);
  const before = await used();
  mangleOnce(deletesReview, zremAsText);
  const { handed } = await eraseTwice();
  assert.equal(stored(P1, id1), null);
  assert.ok(handed.has(path), "the photo is handed to the eraser on the first run or the retry, never lost");
  assert.equal(await used(), before);
});

test("the buyer's delete ran but its reply is unknown: \"deleted\" (so the route drops the photo), the room is not given back", async () => {
  const { id1 } = await setup();
  await withPhoto(id1);
  const before = await used();
  mangleOnce(deletesReview, zremAsText);
  // app/api/store/review/route.ts drops the review's photo exactly when this answers "deleted".
  assert.equal(await deleteReview(STATS, P1, id1, ROOM), "deleted");
  assert.equal(stored(P1, id1), null);
  assert.equal(await used(), before);
});

test("a delete answered oddly that did not run: read again, still there, thrown as unknown, the review and its room kept", async () => {
  const { id1 } = await setup();
  const before = await used();
  answerOnce(deletesReview, ["1"]);
  await assert.rejects(deleteReview(STATS, P1, id1, ROOM), unknown);
  assert.notEqual(stored(P1, id1), null);
  assert.equal(await used(), before);
});

test("the delete's reply and its read again both unknown: thrown, yet the erasure was handed the photo before it tried", async () => {
  const { id1 } = await setup();
  const path = await withPhoto(id1);
  const before = await used();
  let step: "delete" | "read again" | "done" = "delete";
  redis.pipeline = (async (commands: Command[]) => {
    if (step === "read again" && readsReviews(commands)) {
      step = "done";
      return [42] as unknown[];
    }
    const replies = await realPipeline(commands);
    if (step === "delete" && deletesReview(commands)) {
      step = "read again";
      return zremAsText(replies) as unknown[];
    }
    return replies;
  }) as typeof redis.pipeline;
  const { first, handed } = await eraseTwice();
  assert.ok(unknown(first), "never said as done on an unknown read");
  assert.ok(handed.has(path));
  assert.equal(await used(), before);
});

for (const [name, shape] of [
  ["[undefined]", [undefined]],
  ["a number", [7]],
  ["too few replies", []],
] as [string, unknown][]) {
  test(`the payment's list read answered ${name}: thrown as unknown, the other review's member never wiped, the review kept`, async () => {
    const { id1, id2 } = await setup();
    const kept = payEntry();
    answerOnce(readsPay, shape);
    await assert.rejects(forgetReviewsPerson(STATS, [P1], BUYER, ROOM), unknown);
    assert.equal(payEntry(), kept);
    assert.ok(String(payEntry()).includes(`${P2}|${id2}`));
    assert.notEqual(stored(P1, id1), null, "the review stays for the retry, which finds it again");
    redis.pipeline = realPipeline;
    assert.deepEqual(await forgetReviewsPerson(STATS, [P1], BUYER, ROOM), { records: 1, photos: [] });
    assert.equal(payEntry(), `${P2}|${id2}`);
  });
}

test("the payment's list write answered oddly: thrown as unknown, the review kept for the retry", async () => {
  const { id1 } = await setup();
  mangleOnce(writesPay, () => ["1"]);
  await assert.rejects(forgetReviewsPerson(STATS, [P1], BUYER, ROOM), unknown);
  assert.notEqual(stored(P1, id1), null);
  redis.pipeline = realPipeline;
  assert.deepEqual(await forgetReviewsPerson(STATS, [P1], BUYER, ROOM), { records: 1, photos: [] });
});
