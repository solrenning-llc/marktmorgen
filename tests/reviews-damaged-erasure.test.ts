/**
 * The right to erasure is never stuck on one damaged review record (coordinator's decision, 9 Nov 2026).
 *
 * A person's erasure (forgetReviewsPerson, lib/person-erasure.ts) and the buyer's own delete (deleteOwnReview, the
 * review route) used to throw when the record under the person's own review id answered in its exact place but did
 * not read: waiting never changes a damaged record, so the erasure could never finish. Now:
 *
 *   - a damaged record under the person's own id (the field is reviewId(store, product, their address): the field is
 *     the proof it is theirs) is deleted with its index entries, the AI summary that may have counted it, and the
 *     product's numbers counted again after;
 *   - its photo and its payment are looked for where a record keeps them (its JSON's own fields, or, in text cut
 *     short, the fields after its own id and product), only when the record says it is that review; when they cannot
 *     be found it is deleted anyway, the log says so with the review's id and nothing personal, and nothing claims
 *     the photo was deleted;
 *   - a record that reads as ANOTHER review (another id or product under the person's field) is deleted from the
 *     person's field, but its photo is never handed over: it may be another person's;
 *   - another person's record, damaged or not, is never touched;
 *   - a reply in another shape (not text, not nil) is still unknown and throws (tests/r24-reviews-erase-exact.test.ts);
 *   - the damaged path sends no more commands than a healthy deletion (the erasure's per-product cost, lib/erasure-rules.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as reviews from "@/lib/reviews";
import { reviewId, saveReview, setReviewPhoto } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Command = (string | number)[];
type Own = { state: "deleted"; photo: string | null; photoFound: boolean; damaged: boolean; recounted: boolean } | "missing" | "busy";
const deleteOwnReview = (reviews as unknown as { deleteOwnReview?: (s: string, p: string, id: string, room: typeof ROOM) => Promise<Own> }).deleteOwnReview;

const STATS = "fedcba9876543210fedcba9876543210";
const P1 = "dmgp1aaaaa";
const P2 = "dmgp2bbbbb";
const A = "damaged-a@example.test";
const B = "damaged-b@example.test";
const C = "damaged-c@example.test";
const PI_A = "pi_DamagedSyntheticA1";
const PI_B = "pi_DamagedSyntheticB1";
const productKey = (p: string) => `nl:rev:${STATS}:${p}`;
const payKey = `nl:rev:pay:${STATS}`;
const sumKey = `nl:rev:sum:${STATS}`;
const allKey = `nl:rev:all:${STATS}`;
const themesKey = (p: string) => `nl:rsum:${STATS}:${p}:themes`;
const realPipeline = redis.pipeline.bind(redis);

const idA1 = reviewId(STATS, P1, A);
const idA2 = reviewId(STATS, P2, A);
const idB1 = reviewId(STATS, P1, B);
const idB2 = reviewId(STATS, P2, B);
const idC1 = reviewId(STATS, P1, C);

const stored = (p: string, id: string) => redis.run(["HGET", productKey(p), id]);
const pay = (pi: string) => redis.run(["HGET", payKey, pi]);
const numbers = (p: string) => {
  const raw = redis.run(["HGET", sumKey, p]);
  return typeof raw === "string" ? (JSON.parse(raw) as { count: number }).count : raw;
};
const used = async () => (await dataUsed(ROOM))?.used;

async function save(p: string, email: string, pi: string, rating = 4) {
  const saved = await saveReview(STATS, { productId: p, email, reference: `cs_test_${pi}`, pi, rating, text: "Synthetic words", name: "Synthetic Buyer" }, ROOM);
  assert.ok(saved.state === "created" || saved.state === "updated");
}

async function photoOn(p: string, id: string, owner: string): Promise<string> {
  const path = await reviewPhotoPath(owner, "image/jpeg");
  const put = await setReviewPhoto(STATS, p, id, { path, width: 1200, height: 900 });
  assert.equal(typeof put, "object");
  return path;
}

/** A, B and C each review P1; A and B also review P2. A's and B's P1 reviews share no payment with anyone else. */
async function setup(): Promise<void> {
  redis.pipeline = realPipeline;
  redis.clear();
  await save(P1, A, PI_A);
  await save(P2, A, PI_A);
  await save(P1, B, PI_B);
  await save(P2, B, PI_B);
  await save(P1, C, "pi_DamagedSyntheticC1", 2);
  redis.run(["ZADD", themesKey(P1), 1, "a theme"]);
}

/** Captures what is logged while `work` runs. */
async function logged<T>(work: () => Promise<T>): Promise<{ value: T | Error; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await work().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))), lines };
  } finally {
    console.error = original;
  }
}

/** Replaces a stored record with `make(the record as it reads)`, as damage would. */
function damage(p: string, id: string, make: (json: string) => string): void {
  const raw = stored(p, id);
  assert.equal(typeof raw, "string");
  redis.run(["HSET", productKey(p), id, make(raw as string)]);
}

test("not JSON at all, under the person's own id: the erasure finishes, the record and its index entries go, the log names the id only", async () => {
  await setup();
  damage(P1, idA1, () => "{not json");
  const files: string[] = [];
  const { value, lines } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1, P2], A, ROOM, files));
  assert.ok(!(value instanceof Error), `the erasure finished (${value instanceof Error ? value.message : ""})`);
  assert.deepEqual(value, { records: 2, photos: [] });
  assert.equal(stored(P1, idA1), null);
  assert.equal(stored(P2, idA2), null);
  assert.equal(redis.run(["ZSCORE", allKey, `${P1}|${idA1}`]), null, "its studio entry goes with it");
  const said = lines.join("\n");
  assert.match(said, new RegExp(`${P1}\\|${idA1}`), "the log names the review's id");
  assert.match(said, /photo could not be found/);
  assert.doesNotMatch(said, /damaged-a@example|Synthetic Buyer|Synthetic words/, "nothing personal in the log");
  assert.equal(files.length, 0, "no photo is claimed");
});

test("JSON that does not read as a review but says it is the person's: its photo and its payment are found and go", async () => {
  await setup();
  const path = await photoOn(P1, idA1, "damaged-owner@example.test");
  damage(P1, idA1, (json) => json.replace(/"rating":\d/, '"rating":9'));
  assert.equal(reviews.parseReview(stored(P1, idA1)), null, "the record no longer reads");
  const files: string[] = [];
  const { value } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual(value, { records: 1, photos: [path] });
  assert.deepEqual(files, [path]);
  assert.equal(stored(P1, idA1), null);
  assert.equal(pay(PI_A), `${P2}|${idA2}`, "only its own member leaves its payment's list");
});

test("text cut short after its photo: the photo and payment are read from its own fields and go", async () => {
  await setup();
  const path = await photoOn(P1, idA1, "damaged-owner@example.test");
  damage(P1, idA1, (json) => json.slice(0, json.indexOf('"photo":') + 90));
  assert.ok(String(stored(P1, idA1)).includes(path), "the cut text still holds the photo's path");
  const files: string[] = [];
  const { value } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual(value, { records: 1, photos: [path] });
  assert.equal(pay(PI_A), `${P2}|${idA2}`);
});

test("text cut short before its photo: deleted anyway, the photo is said as not found, no file is claimed", async () => {
  await setup();
  await photoOn(P1, idA1, "damaged-owner@example.test");
  damage(P1, idA1, (json) => json.slice(0, 60));
  const files: string[] = [];
  const { value, lines } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual(value, { records: 1, photos: [] });
  assert.equal(stored(P1, idA1), null);
  assert.deepEqual(files, []);
  assert.match(lines.join("\n"), /photo could not be found/);
});

test("a record under the person's field that reads as ANOTHER person's review: the person's field goes, the other's photo and record never do", async () => {
  await setup();
  const pathB = await photoOn(P1, idB1, "damaged-owner@example.test");
  const copyOfB = stored(P1, idB1) as string;
  redis.run(["HSET", productKey(P1), idA1, copyOfB]);
  const files: string[] = [];
  const { value } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1], A, ROOM, files));
  assert.deepEqual(value, { records: 1, photos: [] });
  assert.equal(stored(P1, idA1), null);
  assert.equal(stored(P1, idB1), copyOfB, "B's own review is untouched");
  assert.ok(!files.includes(pathB), "B's photo is never handed to A's erasure");
  assert.equal(pay(PI_B), `${P1}|${idB1};${P2}|${idB2}`, "B's payment list is untouched");
});

test("another person's damaged record is never touched by this person's erasure", async () => {
  await setup();
  damage(P1, idB1, () => "{B's record, damaged");
  const before = { b1: stored(P1, idB1), b2: stored(P2, idB2), payB: pay(PI_B) };
  const { value } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1, P2], A, ROOM));
  assert.deepEqual(value, { records: 2, photos: [] });
  assert.deepEqual({ b1: stored(P1, idB1), b2: stored(P2, idB2), payB: pay(PI_B) }, before);
  assert.notEqual(redis.run(["ZSCORE", allKey, `${P1}|${idB1}`]), null, "B's studio entry stays");
});

test("the buyer's own delete of their damaged record: deleted, counted again after, the AI summary goes, no room given back", async () => {
  assert.equal(typeof deleteOwnReview, "function", "deleteOwnReview is exported");
  await setup();
  damage(P1, idA1, () => "{not json");
  const before = await used();
  const { value, lines } = await logged(() => deleteOwnReview!(STATS, P1, idA1, ROOM));
  assert.deepEqual(value, { state: "deleted", photo: null, photoFound: false, damaged: true, recounted: true });
  assert.equal(stored(P1, idA1), null);
  assert.equal(numbers(P1), 2, "the numbers are counted again from B's and C's reviews");
  assert.equal(redis.run(["EXISTS", themesKey(P1)]), 0, "the AI summary that may have counted it goes");
  assert.equal(await used(), before, "its size is unknown: its room stays counted, more than used, never less");
  assert.match(lines.join("\n"), new RegExp(`${P1}\\|${idA1}.*photo could not be found`));
  assert.equal(await reviews.deleteReview(STATS, P1, idA1, ROOM), "missing");
});

test("the buyer's own delete when another record of the product is damaged too: deleted, and said as not counted again", async () => {
  assert.equal(typeof deleteOwnReview, "function");
  await setup();
  damage(P1, idA1, () => "{not json");
  damage(P1, idB1, () => "{B's record, damaged");
  const value = await deleteOwnReview!(STATS, P1, idA1, ROOM);
  assert.equal(typeof value, "object");
  assert.equal((value as Exclude<Own, string>).recounted, false, "the numbers could not be counted again, and the answer says so");
  assert.equal(stored(P1, idA1), null);
  assert.equal(typeof stored(P1, idB1), "string", "B's damaged record is never touched");
});

test("a healthy delete answers its photo, found, from the record it deleted", async () => {
  assert.equal(typeof deleteOwnReview, "function");
  await setup();
  const path = await photoOn(P1, idA1, "damaged-owner@example.test");
  const used0 = await used();
  const value = await deleteOwnReview!(STATS, P1, idA1, ROOM);
  assert.deepEqual(value, { state: "deleted", photo: path, photoFound: true, damaged: false, recounted: true });
  assert.ok((await used())! < used0!, "a review that read gives its room back");
});

test("the damaged path sends no more commands than a healthy deletion (the erasure's per-product cost)", async () => {
  const count = async (prepare: () => void): Promise<number> => {
    await setup();
    prepare();
    let commands = 0;
    redis.pipeline = (async (list: Command[]) => {
      commands += list.length;
      return realPipeline(list);
    }) as typeof redis.pipeline;
    const { value } = await logged(() => reviews.forgetReviewsPerson(STATS, [P1], A, ROOM));
    redis.pipeline = realPipeline;
    assert.ok(!(value instanceof Error));
    return commands;
  };
  const healthy = await count(() => undefined);
  const damaged = await count(() => damage(P1, idA1, () => "{not json"));
  assert.ok(damaged <= healthy, `damaged ${damaged} <= healthy ${healthy}`);
});

test("the review route deletes through deleteOwnReview, drops the photo it answered, and says when the average was not counted again", () => {
  const route = readFileSync("app/api/store/review/route.ts", "utf8");
  assert.match(route, /deleteOwnReview\(statsId, productId, id, store\)/);
  assert.match(route, /dropReviewPhoto\(done\.photo/);
  assert.match(route, /done\.recounted \? "deleted" : "deletedUncounted"/);
  for (const [language, words] of Object.entries(GIVING_WORDS)) {
    const said = (words.reviewNotices as Record<string, string>).deletedUncounted;
    assert.equal(typeof said, "string", `${language} says it`);
    assert.doesNotMatch(said, /photo|foto|Foto/, `${language} claims nothing about a photo`);
  }
  assert.match(GIVING_WORDS.en.reviewNotices.deletedUncounted, /may still count/);
});
