// Pre-review proof of claude5/reviews-recount-exact (9 November 2026), kept as its regression test. A product's numbers
// are marked as waiting for their recount in the same request as every change to its reviews, and the recount that
// follows replaces the mark. When that recount failed (a read lost for a moment), the mark stayed until the product's
// next change, which may never come: the product showed no stars, said as unread, for good. Now a daily pass of the
// hourly recount job (app/api/cron/recount) counts again, under the product's lock, the products whose numbers wait,
// at most REVIEW_RECOUNTS_PER_DAY of them from at most REVIEW_RECOUNT_STORES_PER_DAY stores, inside its deadline. The
// mark is replaced only by numbers read whole; anything unknown leaves it. The public pages never recount on a read.
// And the refund pass now refreshes the store's quotes when the only case it met was a damaged record.
// Synthetic Redis only (tests/redis-stub.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as reviews from "@/lib/reviews";
import { saveReview, setHidden, summaries, HIDE_REASONS } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Pass = { stores: number; recounted: number; unsure: number; busy: number; capped: boolean; complete: boolean };
const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const STATS = "e".repeat(32);
const OTHER_STATS = "f".repeat(32);
const PRODUCT = "prod0002";
const RECORDS = (s: string, p: string) => `nl:rev:${s}:${p}`;
const SUMMARY = (s: string) => `nl:rev:sum:${s}`;
const REASON = HIDE_REASONS[0].id;
const api = reviews as unknown as Record<string, unknown>;
const recountWaiting = api.recountWaiting as ((deadline: number) => Promise<Pass>) | undefined;
const CAP = api.REVIEW_RECOUNTS_PER_DAY as number | undefined;

async function seed(statsId = STATS, productId = PRODUCT): Promise<string[]> {
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const saved = await saveReview(
      statsId,
      { productId, email: `buyer${n}@example.com`, reference: `cs_test_${n}`, pi: `pi_${n}_${productId}`, rating: n === 1 ? 1 : 5, text: `Review ${n}`, name: `Buyer ${n}` },
      ROOM,
      1_700_000_000_000 + n * 1000,
    );
    if (saved.state === "created") ids.push(saved.review.id);
  }
  return ids;
}

/** The count and stars shown for a product, or what summaries() said instead. */
async function shown(statsId = STATS, productId = PRODUCT): Promise<unknown> {
  const one = (await summaries(statsId)).get(productId);
  return one && typeof one === "object" ? [one.count, one.stars] : one ?? "none";
}

/** Runs `work` with the recount's next read of `records` lost (an empty reply), as a passing failure does. */
async function withLostRecount<T>(records: string, work: () => Promise<T>): Promise<T> {
  let lost = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!lost && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === records) {
      lost = true;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  return quiet(work);
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = log;
    redis.pipeline = original;
  }
}

async function pass(deadline = Date.now() + 10_000): Promise<Pass | string> {
  if (!recountWaiting) return "no daily recount of the products whose numbers wait";
  try {
    return await quiet(() => recountWaiting(deadline));
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  part("A recount lost for a moment: the next daily pass counts the product again, with no change to its reviews");
  redis.clear();
  let ids = await seed();
  await withLostRecount(RECORDS(STATS, PRODUCT), () => setHidden(STATS, PRODUCT, ids[0], true, REASON));
  is("after the lost recount the product is unread", await shown(), "unread");
  is("a public read never counts it again: still unread", await shown(), "unread");
  const commands: Command[] = [];
  redis.pipeline = (async (batch: Command[]) => {
    commands.push(...batch);
    return original(batch);
  }) as typeof redis.pipeline;
  await summaries(STATS);
  redis.pipeline = original;
  is("a public read sends one HGETALL of the numbers and nothing else (no recount, no write)", commands, [["HGETALL", SUMMARY(STATS)]]);
  const first = await pass();
  is("the daily pass counts it again", typeof first === "object" ? first.recounted : first, 1);
  is("its numbers are read whole: one review counted (the hidden one counts, as the page says), 6 stars", await shown(), [2, 6]);

  part("A pass with nothing waiting writes no numbers");
  const quietPass = await pass();
  is("nothing recounted", typeof quietPass === "object" ? quietPass.recounted : quietPass, 0);
  is("the numbers stay as they were", await shown(), [2, 6]);

  part("Unknown leaves the mark: the pass's own read of the reviews lost");
  redis.clear();
  ids = await seed();
  await withLostRecount(RECORDS(STATS, PRODUCT), () => setHidden(STATS, PRODUCT, ids[1], true, REASON));
  let lost = 0;
  redis.pipeline = (async (batch: Command[]) => {
    if (batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS(STATS, PRODUCT)) {
      lost += 1;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  const unsure = await pass();
  redis.pipeline = original;
  is("the pass tried the product's reviews once", lost, 1);
  is("said as unsure, never as recounted", typeof unsure === "object" ? [unsure.recounted, unsure.unsure] : unsure, [0, 1]);
  is("the mark stays: unread, never numbers made up", await shown(), "unread");
  is("the mark itself is left in place", (await original([["HGET", SUMMARY(STATS), PRODUCT]]))[0], "recount");

  part("A damaged record in the product's hash: the mark stays, the record is never rewritten");
  await original([["HSET", RECORDS(STATS, PRODUCT), "rv_damaged01", "{not json"]]);
  const damaged = await pass();
  is("not recounted", typeof damaged === "object" ? damaged.recounted : damaged, 0);
  is("still unread", await shown(), "unread");
  is("the damaged record is left as it was", (await original([["HGET", RECORDS(STATS, PRODUCT), "rv_damaged01"]]))[0], "{not json");

  part("The store's numbers read in another shape: nothing written for that store");
  redis.clear();
  ids = await seed();
  await withLostRecount(RECORDS(STATS, PRODUCT), () => setHidden(STATS, PRODUCT, ids[0], true, REASON));
  redis.pipeline = (async (batch: Command[]) => {
    if (batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === SUMMARY(STATS)) return [["prod0002"]];
    return original(batch);
  }) as typeof redis.pipeline;
  const offShape = await pass();
  redis.pipeline = original;
  is("nothing recounted from an unread hash", typeof offShape === "object" ? offShape.recounted : offShape, 0);
  is("still unread", await shown(), "unread");

  part("The product's lock held by a change in progress: the pass leaves it to that change");
  await original([["SET", `nl:rev:lock:${STATS}:${PRODUCT}`, "someone-else", "EX", 10]]);
  const busy = await pass(Date.now() + 10_000);
  is("busy, not recounted", typeof busy === "object" ? [busy.recounted, busy.busy] : busy, [0, 1]);
  is("still unread", await shown(), "unread");
  await original([["DEL", `nl:rev:lock:${STATS}:${PRODUCT}`]]);

  part("A deadline already passed: the pass reads nothing and writes nothing");
  const late = await pass(Date.now() - 1);
  is("nothing recounted", typeof late === "object" ? [late.recounted, late.complete] : late, [0, false]);
  is("still unread", await shown(), "unread");

  part("Bounded: at most REVIEW_RECOUNTS_PER_DAY products a pass, the rest on the next pass");
  redis.clear();
  const many = (CAP ?? 0) + 2;
  is("a cap is declared, more than one", typeof CAP === "number" && CAP > 1, true);
  const products = Array.from({ length: many }, (_, i) => `prodw${String(i).padStart(4, "0")}`);
  for (const [i, productId] of products.entries()) {
    const statsId = i % 2 === 0 ? STATS : OTHER_STATS;
    await seed(statsId, productId);
    await original([["HSET", SUMMARY(statsId), productId, "recount"]]);
  }
  const capped = await pass();
  is("the first pass recounts exactly the cap and says it was capped", typeof capped === "object" ? [capped.recounted, capped.capped] : capped, [CAP, true]);
  const rest = await pass();
  is("the next pass recounts the rest", typeof rest === "object" ? rest.recounted : rest, 2);
  const left = [];
  for (const [i, productId] of products.entries()) if ((await shown(i % 2 === 0 ? STATS : OTHER_STATS, productId)) === "unread") left.push(productId);
  is("no product is left unread", left, []);

  part("Wired into a daily job, never into a page read");
  const root = process.cwd();
  const job = readFileSync(join(root, "app/api/cron/recount/route.ts"), "utf8");
  is("the hourly recount job runs the daily pass", /recountWaiting\(/.test(job), true);
  is("only at one hour of the UTC day", /REVIEW_RECOUNT_HOUR_UTC/.test(job), true);
  is("inside the job's cutoff", /withCutoff\(/.test(job), true);
  const lib = readFileSync(join(root, "lib/reviews.ts"), "utf8");
  const read = lib.slice(lib.indexOf("export async function summaries("), lib.indexOf("export async function summaryOf("));
  is("summaries() never recounts", /recount\(/.test(read), false);

  part("The refund pass refreshes the store's quotes when its only case was a damaged record");
  const proof = readFileSync(join(root, "lib/review-proof.ts"), "utf8");
  is("markRefundedReviews refreshes on a damaged record as on a marked one", /if \(marked > 0 \|\| damaged\) await refreshStoreQuotes\(store\)/.test(proof), true);
  redis.clear();
  const bad = await saveReview(STATS, { productId: PRODUCT, email: "buyer9@example.com", reference: "cs_test_9", pi: "pi_9", rating: 5, text: "Hurt", name: "B" }, ROOM, 1_700_000_001_000);
  const badId = bad.state === "created" ? bad.review.id : "";
  await original([["HSET", RECORDS(STATS, PRODUCT), badId, "{not json"]]);
  const seen: string[] = [];
  const markRefunded = reviews.markRefunded as (statsId: string, pi: string, onDamaged?: (productId: string) => void) => Promise<number>;
  const count = await quiet(() => markRefunded(STATS, "pi_9", (productId) => void seen.push(productId)));
  is("the damaged record is not said as marked", count, 0);
  is("its product is told to the caller, for the quotes", seen, [PRODUCT]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
