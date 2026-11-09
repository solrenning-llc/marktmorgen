// One product's unreadable review record must never take the rest of the store with it (rule 24; VR item 2).
//
// After the exact reads of lib/reviews.ts (claude5/reviews-recount-exact), one product whose kept numbers did not
// read made `summaries` throw for the whole store, so the stars went from every product, the store's own stars and
// the media kit until that product's next recount; and one stored review that did not read made a removed product's
// reviews impossible to drop, failed the studio's list of reviews for the whole page it was on, and stopped a refund
// from marking the other reviews its payment paid for. Now:
// - summaries reads each product's numbers on its own: one that does not read is "unread" (no stars, never a number
//   made up), the others are shown; the store's own numbers, which add every listed product's, are unknown (null)
//   while one of them is unread. Only a reply in another shape (or a field that is not a product) is unknown for all.
// - a recount rebuilds numbers that did not read from the reviews when they read (any change of one of its reviews).
// - dropReviews still drops every review of a removed product when one record does not read: the ids are the hash's
//   own fields; only the photos of the records that read are given back, and the log names the others.
// - studioReviews lists the reviews that read and says how many on the page did not (`unreadable`).
// - markRefunded marks every other review of the payment before it says the unreadable one is unknown.
// Synthetic Redis only (tests/redis-stub.ts).
import { readFileSync } from "node:fs";
import {
  HIDE_REASONS,
  dropReviews,
  markRefunded,
  saveReview,
  setHidden,
  setReviewPhoto,
  studioReviews,
  summaries,
  type Review,
} from "@/lib/reviews";
import * as numbersModule from "@/lib/review-summary";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

const STATS = "e".repeat(32);
const ONE = "prod0001";
const TWO = "prod0002";
const SUM = `nl:rev:sum:${STATS}`;
const records = (product: string) => `nl:rev:${STATS}:${product}`;
const ALL = `nl:rev:all:${STATS}`;
const NEW = `nl:rev:new:${STATS}`;
const PHOTO = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`, width: 100, height: 100 };

async function raw(command: Command): Promise<unknown> {
  const [reply] = await original([command]);
  return reply;
}

/** What a call ended in, with what it wrote to the error log. */
async function outcome(run: () => Promise<unknown>): Promise<{ result: unknown; logged: string[] }> {
  const log = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), logged };
  } catch (error) {
    return { result: error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`, logged };
  } finally {
    console.error = log;
    redis.pipeline = original;
  }
}

/** Two products with reviews: ONE has two (one paid by pi_1, one by pi_2), TWO has one, paid by pi_1 too. */
async function seed(): Promise<{ one: string[]; two: string }> {
  redis.clear();
  const write = async (product: string, n: number, pi: string, rating: number) => {
    const saved = await saveReview(
      STATS,
      { productId: product, email: `buyer${n}@example.com`, reference: `cs_test_${n}`, pi, rating, text: `Review ${n}`, name: `Buyer ${n}` },
      ROOM,
      1_700_000_000_000 + n * 1000,
    );
    if (saved.state !== "created") throw new Error("fixture");
    return saved.review.id;
  };
  const one = [await write(ONE, 1, "pi_1", 4), await write(ONE, 2, "pi_2", 5)];
  const two = await write(TWO, 1, "pi_1", 3);
  return { one, two };
}

const corrupt = async (key: string, field: string, value: string) => {
  await raw(["HSET", key, field, value]);
};

async function main(): Promise<void> {
  const numbersOf = (numbersModule as Record<string, unknown>).numbersOf as
    | ((each: Map<string, unknown>, id: string) => unknown)
    | undefined;
  const storeSummary = numbersModule.storeSummary as (each: Map<string, unknown>, listed: string[]) => unknown;

  part("summaries: one product's numbers that do not read leave the others' stars");
  {
    await seed();
    const two = await raw(["HGET", SUM, TWO]);
    await corrupt(SUM, ONE, "{not json");
    const { result } = await outcome(() => summaries(STATS));
    const map = result instanceof Map ? (result as Map<string, unknown>) : null;
    is("the store's numbers are read, not thrown", map !== null, true);
    is("the product whose numbers did not read is unread, never a number", map?.get(ONE), "unread");
    is("the other product's stars are shown as kept", JSON.stringify(map?.get(TWO)), two);
    is("numbersOf gives no stars for the unread product", typeof numbersOf === "function" && map ? numbersOf(map, ONE) : "missing", null);
    is("numbersOf gives the other product's numbers", typeof numbersOf === "function" && map ? JSON.stringify(numbersOf(map, TWO)) : "missing", two);
    is("numbersOf gives none for a product without numbers", typeof numbersOf === "function" && map ? numbersOf(map, "prod0003") : "missing", null);
    is("the store's own numbers are unknown while one listed product is unread", map ? storeSummary(map, [ONE, TWO]) : "missing", null);
    is("but known when the unread product is not listed", map ? (storeSummary(map, [TWO]) as { count?: number } | null)?.count : "missing", 1);
  }
  for (const [label, value] of [
    ["numbers that do not add up", JSON.stringify({ count: 2, stars: 1, visible: 2, hidden: 0, refunded: 0, dist: [0, 0, 0, 1, 1] })],
    ["nil as JSON", "null"],
  ] as [string, string][]) {
    await seed();
    await corrupt(SUM, ONE, value);
    const { result } = await outcome(() => summaries(STATS));
    is(`${label}: only that product is unread`, result instanceof Map ? [...(result as Map<string, unknown>).entries()].map(([k, v]) => [k, v === "unread" ? "unread" : "read"]) : result, [
      [ONE, "unread"],
      [TWO, "read"],
    ]);
  }
  for (const [label, reply] of [
    ["no reply", []],
    ["a field that is not a product", [["../x", "{}"]]],
    ["a value that is not text", [[ONE, 5]]],
    ["a field without its value", [[ONE]]],
  ] as [string, unknown][]) {
    redis.pipeline = (async (batch: Command[]) => (batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === SUM ? reply : original(batch))) as typeof redis.pipeline;
    is(`a reply in another shape, ${label}: still unknown for the whole store`, (await outcome(() => summaries(STATS))).result, "unknown");
  }

  part("A recount rebuilds numbers that did not read, from reviews that read");
  {
    const { one } = await seed();
    const kept = await raw(["HGET", SUM, ONE]);
    await corrupt(SUM, ONE, "{not json");
    const { result, logged } = await outcome(() => setHidden(STATS, ONE, one[0], true, HIDE_REASONS[0].id));
    is("the creator's change is written", typeof result === "object" && result !== null && (result as Review).hidden === true, true);
    is("without a log line", logged, []);
    const now = JSON.parse((await raw(["HGET", SUM, ONE])) as string);
    is("the numbers are counted again from both reviews", [now.count, now.stars, now.visible, now.hidden], [2, 9, 1, 1]);
    is("as they were before, but for the hide", { ...now, visible: 2, hidden: 0 }, JSON.parse(kept as string));
    const read = await outcome(() => summaries(STATS));
    is("and the product's stars read again", (read.result as Map<string, unknown>).get(ONE) === "unread", false);
  }

  part("A removed product's reviews are dropped even when one record does not read");
  {
    const { one } = await seed();
    await setReviewPhoto(STATS, ONE, one[1], PHOTO);
    await corrupt(records(ONE), one[0], "{not json");
    const { result, logged } = await outcome(() => dropReviews(STATS, ONE));
    is("the photos of the records that read are given back", result, [PHOTO.path]);
    is("every record of the product is gone", await raw(["HLEN", records(ONE)]), 0);
    is("and from the studio's list, the unreadable one too", await raw(["ZREVRANGE", ALL, 0, -1]), [`${TWO}|${(await raw(["HKEYS", records(TWO)]) as string[])[0]}`]);
    is("and from the queue", ((await raw(["ZREVRANGE", NEW, 0, -1])) as string[]).some((m) => m.startsWith(`${ONE}|`)), false);
    is("and its numbers", await raw(["HGET", SUM, ONE]), null);
    is("the log names the record that did not read", logged.some((line) => line.includes(one[0])), true);
  }
  {
    const { one } = await seed();
    await corrupt(records(ONE), one[0], (await raw(["HGET", records(ONE), one[1]])) as string);
    const { result } = await outcome(() => dropReviews(STATS, ONE));
    is("a record under another's id is dropped too, its photo never taken as its own", result, []);
    is("every record of the product is gone (another's id)", await raw(["HLEN", records(ONE)]), 0);
  }

  part("The studio's list shows the reviews that read and says how many did not");
  {
    const { one, two } = await seed();
    await corrupt(records(ONE), one[0], "{not json");
    const { result } = await outcome(() => studioReviews(STATS, { queue: false, offset: 0, limit: 20 }));
    const list = result as { rows?: Review[]; total?: number; unreadable?: number };
    is("the page is read, not refused", Array.isArray(list?.rows), true);
    is("the reviews that read are listed", (list.rows ?? []).map((r) => r.id).sort(), [one[1], two].sort());
    is("the total stays the index's", list.total, 3);
    is("and the page says one did not read", list.unreadable, 1);
    const clean = await studioReviews(STATS, { queue: false, offset: 0, limit: 1 });
    is("a page without one says nothing of it", "unreadable" in clean, false);
  }

  part("A refund marks every other review its payment paid for");
  {
    const { one, two } = await seed();
    await corrupt(records(ONE), one[0], "{not json");
    const { result } = await outcome(() => markRefunded(STATS, "pi_1"));
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026): the pass was "unknown" here, so it threw on
    // every pass and the refunds sweep (lib/review-proof.ts) stopped at this damaged record for good. A damaged record is
    // now skipped and never said as marked: one review marked (the other), the damaged one's product left unread.
    is("the pass ends, the damaged record never said as marked", result, 1);
    is("the damaged record's product shows no stars", await raw(["HGET", SUM, ONE]), "recount");
    is("the other review of that payment is marked", JSON.parse((await raw(["HGET", records(TWO), two])) as string).refunded, true);
    is("and its stars leave its numbers", JSON.parse((await raw(["HGET", SUM, TWO])) as string).count, 0);
  }

  part("The pages draw no stars for an unread product and no store stars while one is unread");
  const storePage = readFileSync("app/[handle]/page.tsx", "utf8");
  const collection = readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8");
  const kit = readFileSync("app/[handle]/media-kit/page.tsx", "utf8");
  const studio = readFileSync("app/studio/reviews/page.tsx", "utf8");
  is("the store page's cards read through numbersOf", storePage.includes("rating={numbersOf(rated, product.id)}"), true);
  is("the store page's own stars only when known", storePage.includes("storeRating !== null && showsRating(storeRating)"), true);
  is("the collection's cards read through numbersOf", collection.includes("rating={numbersOf(rated, product.id)}"), true);
  is("the media kit's stars only when known", kit.includes("rating !== null && showsRating(rating)"), true);
  is(
    "the studio says which product's totals did not read, in a live region",
    studio.includes("Its totals could not be read, so no stars are shown for it on your pages. They are counted again from its reviews the next time one of them changes. This does not mean it has none."),
    true,
  );
  is("the studio says how many reviews on the page did not read", studio.includes("current.unreadable"), true);

  done();
}

void main();
