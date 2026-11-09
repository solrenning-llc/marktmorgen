// Pre-review proof of claude5/reviews-recount-exact (9 November 2026), kept as its regression test. When a product's
// recount was "unsure", the numbers kept before the change went on being shown as the product's stars and count,
// counting a review the creator had just hidden or a refund just marked. With one damaged record in the product's hash,
// every later recount was "unsure" too, so the false count never ended. And a refunded payment whose review record was
// damaged made markRefunded throw on every pass, so the refunds sweep (lib/review-proof.ts) stopped there for good and
// the later refunds' reviews went on counting. Now a change marks the product's numbers as waiting for a recount in
// the same request (no stars, never a number made up, until they are counted again), and a damaged record is skipped
// by the refund pass, logged by its id, with its product's numbers left unread.
// Synthetic Redis only (tests/redis-stub.ts).
import { deleteReview, markRefunded, saveReview, setHidden, summaries, summaryOf, HIDE_REASONS } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const STATS = "e".repeat(32);
const PRODUCT = "prod0002";
const RECORDS = `nl:rev:${STATS}:${PRODUCT}`;
const REASON = HIDE_REASONS[0].id;

async function seed(): Promise<string[]> {
  redis.clear();
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const saved = await saveReview(
      STATS,
      { productId: PRODUCT, email: `buyer${n}@example.com`, reference: `cs_test_${n}`, pi: `pi_${n}`, rating: n === 1 ? 1 : 5, text: `Review ${n}`, name: `Buyer ${n}` },
      ROOM,
      1_700_000_000_000 + n * 1000,
    );
    if (saved.state === "created") ids.push(saved.review.id);
  }
  return ids;
}

/** The count and stars shown for the product, or what summaries() said instead. */
async function shown(): Promise<unknown> {
  const one = (await summaries(STATS)).get(PRODUCT);
  return one && typeof one === "object" ? [one.count, one.stars] : one ?? "none";
}

async function quiet<T>(run: () => Promise<T>): Promise<T | string> {
  const log = console.error;
  console.error = () => {};
  try {
    return await run();
  } catch (error) {
    return `threw ${String(error)}`;
  } finally {
    console.error = log;
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("A one-star review hidden by the creator while the recount's read is lost");
  let ids = await seed();
  is("before: two reviews, 6 stars", await shown(), [2, 6]);
  let swapped = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!swapped && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
      swapped = true;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  await quiet(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
  is("after the hide, the page must not show the hidden review in the count (1 review, 5 stars) nor a number made up", await shown() === "unread" || JSON.stringify(await shown()) === "[1,5]", true);

  part("A refund marked while the recount's read is lost: marked, and its stars still counted");
  ids = await seed();
  swapped = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!swapped && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
      swapped = true;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  const marked = await quiet(() => markRefunded(STATS, "pi_1"));
  is("markRefunded says one review marked", marked, 1);
  is("the refunded review is not counted, nor a number made up", (await shown()) === "unread" || JSON.stringify(await shown()) === "[1,5]", true);

  part("One damaged record in the product's hash: every later change leaves the old count shown");
  ids = await seed();
  await original([["HSET", RECORDS, "rv_damaged01", "{not json"]]);
  await quiet(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
  await quiet(() => setHidden(STATS, PRODUCT, ids[1], true, REASON));
  is("both reviews hidden: no stars may be shown from them", (await shown()) === "unread" || (await shown()) === "none", true);
  part("A refunded payment whose review record is damaged: markRefunded throws on every pass, for good");
  ids = await seed();
  await original([["HSET", RECORDS, ids[0], "{not json"]]);
  const tries = [await quiet(() => markRefunded(STATS, "pi_1")), await quiet(() => markRefunded(STATS, "pi_1")), await quiet(() => markRefunded(STATS, "pi_1"))];
  is("a damaged record (waiting never changes it) is not a reason to refuse the refund pass for good", tries.every((t) => typeof t === "string" && t.startsWith("threw")), false);

  // Rule 30, the same flow's siblings: a recount whose read throws (a timeout) after the change was written, a buyer's
  // own deletion and a buyer's edit of the stars, each while the recount is lost; and a payment whose other review reads.
  part("The recount's read throws after the change was written: the old numbers are never shown");
  ids = await seed();
  redis.pipeline = (async (batch: Command[]) => {
    if (batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) throw new Error("Redis request timed out");
    return original(batch);
  }) as typeof redis.pipeline;
  await quiet(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
  is("the hide is written", JSON.parse(String((await original([["HGET", RECORDS, ids[0]]]))[0])).hidden, true);
  is("no stars from the review just hidden", await shown(), "unread");
  is("summaryOf says unknown, never the old numbers", await quiet(() => summaryOf(STATS, PRODUCT)), "threw UnknownReplyError: Redis answered a product's review numbers in an unknown shape");
  await quiet(() => setHidden(STATS, PRODUCT, ids[0], false));
  is("the next change counts them right again", await shown(), [2, 6]);

  part("A buyer deletes their own review while the recount's read is lost");
  ids = await seed();
  swapped = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!swapped && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
      swapped = true;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  is("deleted", await quiet(() => deleteReview(STATS, PRODUCT, ids[0], ROOM)), "deleted");
  is("the deleted review is not counted, nor a number made up", await shown(), "unread");

  part("A buyer changes their stars while the recount's read is lost");
  ids = await seed();
  swapped = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!swapped && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
      swapped = true;
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  await quiet(() =>
    saveReview(STATS, { productId: PRODUCT, email: "buyer1@example.com", reference: "cs_test_1", pi: "pi_1", rating: 5, text: "Review 1", name: "Buyer 1" }, ROOM, 1_700_000_100_000),
  );
  is("the old stars are not shown", await shown(), "unread");

  part("A refunded payment with a damaged record and a readable one");
  redis.clear();
  const other = "prod0003";
  const good = await saveReview(STATS, { productId: other, email: "buyer9@example.com", reference: "cs_test_9", pi: "pi_9", rating: 4, text: "Kept", name: "B" }, ROOM, 1_700_000_000_000);
  const bad = await saveReview(STATS, { productId: PRODUCT, email: "buyer9@example.com", reference: "cs_test_9", pi: "pi_9", rating: 5, text: "Hurt", name: "B" }, ROOM, 1_700_000_001_000);
  const goodId = good.state === "created" ? good.review.id : "";
  const badId = bad.state === "created" ? bad.review.id : "";
  await original([["HSET", RECORDS, badId, "{not json"]]);
  const lines: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let result: unknown;
  try {
    result = await markRefunded(STATS, "pi_9");
  } catch (error) {
    result = `threw ${String(error)}`;
  } finally {
    console.error = log;
  }
  is("the pass ends: only the readable review is said as marked", result, 1);
  is("the readable review is marked", JSON.parse(String((await original([["HGET", `nl:rev:${STATS}:${other}`, goodId]]))[0])).refunded, true);
  is("the damaged record's product shows no stars, never its old numbers", await shown(), "unread");
  is("the log names the damaged record by its id", lines.some((line) => line.includes(`${PRODUCT}|${badId}`)), true);
  is("the log names nobody", lines.some((line) => line.includes("@") || line.includes("buyer9")), false);
  is("the damaged record is left as it was (never rewritten from a guess)", (await original([["HGET", RECORDS, badId]]))[0], "{not json");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
