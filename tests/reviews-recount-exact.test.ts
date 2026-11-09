// A product's review numbers (nl:rev:sum:) are counted again from its reviews
// after every change. That recount read the reviews with HGETALL and took a
// lost or off-shape reply as "no reviews": it deleted the numbers the store
// shows (average and count), or wrote numbers counted without a review that
// did not read (rule 24; VR item 2). Now an unknown read writes nothing: the
// numbers are never deleted or counted from it, the recount is left for the
// next change and the log says so; meanwhile the product shows no stars (its
// numbers were marked as waiting with the change, tests/reviews-recount-unread.test.ts). The same file's other writes that rested on a tolerant read
// (rule 30) now fail closed too: a payment's list of reviews (its refunds),
// marking a refund, the creator's changes and dropping a removed product's
// reviews. The numbers' own readers (summaries, summaryOf) say "unknown"
// instead of "none", and the pages say the totals could not be read.
// Synthetic Redis only (tests/redis-stub.ts).
import { readFileSync } from "node:fs";
import {
  HIDE_REASONS,
  dropReviews,
  markOneRefunded,
  markRefunded,
  saveReview,
  setHidden,
  summaries,
  summaryOf,
  summarise,
  type Review,
  WRITE_NUMBERS_IF,
} from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

const STATS = "d".repeat(32);
const PRODUCT = "prod0001";
const SUM = `nl:rev:sum:${STATS}`;
const RECORDS = `nl:rev:${STATS}:${PRODUCT}`;
const PAY = `nl:rev:pay:${STATS}`;
const ALL = `nl:rev:all:${STATS}`;
const NEW = `nl:rev:new:${STATS}`;
const REASON = HIDE_REASONS[0].id;

/** Answers the first pipeline whose first command is `name` on `key` with `reply`; every other call reaches the stand-in. */
function swap(name: string, key: string, reply: unknown): { hit: () => boolean } {
  let hit = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!hit && batch[0]?.[0] === name && batch[0]?.[1] === key) {
      hit = true;
      return reply as unknown[];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  return { hit: () => hit };
}

/** What a call ended in, with what it wrote to the error log; the stand-in is put back after it. */
async function outcome(run: () => Promise<unknown>): Promise<{ result: unknown; logged: number }> {
  const log = console.error;
  let logged = 0;
  console.error = () => {
    logged += 1;
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

const sparse = (n: number): unknown[] => {
  const list: unknown[] = [];
  list.length = n;
  return list;
};

async function raw(command: Command): Promise<unknown> {
  const [reply] = await original([command]);
  return reply;
}

/** Two reviews of one product, from two payments: the numbers as kept, and the reviews' ids and records. */
async function seed(): Promise<{ ids: string[]; rows: string[]; sum: string }> {
  redis.clear();
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const saved = await saveReview(
      STATS,
      { productId: PRODUCT, email: `buyer${n}@example.com`, reference: `cs_test_${n}`, pi: `pi_${n}`, rating: n + 3, text: `Review ${n}`, name: `Buyer ${n}` },
      ROOM,
      1_700_000_000_000 + n * 1000,
    );
    if (saved.state === "created") ids.push(saved.review.id);
  }
  const rows = (await Promise.all(ids.map((id) => raw(["HGET", RECORDS, id])))) as string[];
  return { ids, rows, sum: (await raw(["HGET", SUM, PRODUCT])) as string };
}

const numbers = (count: number, stars: number, visible: number, hidden: number, refunded: number, dist: number[]) =>
  JSON.stringify({ count, stars, visible, hidden, refunded, dist });

async function main(): Promise<void> {
  part("Baseline: two reviews, their numbers kept");
  const first = await seed();
  is("two reviews written", first.ids.length, 2);
  is("their numbers as kept", first.sum, numbers(2, 9, 2, 0, 0, [0, 0, 0, 1, 1]));

  part("A recount whose read is lost or off-shape writes nothing and says so in the log");
  const offShape = (ids: string[], rows: string[]): [string, unknown][] => [
    ["no reply", []],
    ["nil", [null]],
    ["a text", ["text"]],
    ["an object", [{}]],
    ["a field without its value", [[ids[0]]]],
    ["numbers", [[1, 2]]],
    ["a hole", [sparse(2)]],
    ["a stored review that does not read", [[ids[0], rows[0], ids[1], "{not json"]]],
    ["a review under another's id", [[ids[0], rows[1], ids[1], rows[1]]]],
    ["a field that is not a review id", [["../x", rows[0], ids[1], rows[1]]]],
  ];
  for (const [label, reply] of offShape(first.ids, first.rows)) {
    const { ids, sum } = await seed();
    // Rule 23 (second pre-review of fc75f6a256): the recount reads, in the same request as the records, since when too
    // many did not read (one HGET of the set-aside hash): an answer of one reply to the records carries that one (nil).
    const read = swap("HGETALL", RECORDS, Array.isArray(reply) && reply.length === 1 ? [...reply, null] : reply);
    const { result, logged } = await outcome(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
    is(`${label}: the hide itself is written`, typeof result === "object" && result !== null && (result as Review).hidden === true, true);
    is(`${label}: the recount read it`, read.hit(), true);
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026): the numbers from before the hide were kept
    // and shown, still counting the review just hidden. Now the change marks them as waiting ("recount") in its own
    // request and an unsure recount leaves that mark: no stars, said as unread, never deleted or counted from the read.
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026, the race): the mark was the fixed text "recount"; each change's mark now carries a token of its own ("recount:<random>"), so a recount from before it never writes over it.
    is(`${label}: the numbers are never deleted or counted from it: they wait, unread`, /^recount:[0-9a-f]{24}$/.test(String(await raw(["HGET", SUM, PRODUCT]))), true);
    is(`${label}: they were there before the hide`, typeof sum === "string" && sum.startsWith("{"), true);
    is(`${label}: the log says the recount was left`, logged > 0, true);
  }

  part("A recount whose write answers in another shape is said in the log");
  for (const [label, reply] of [["no reply", []], ["a text", ["OK"]], ["two", [2]]] as [string, unknown][]) {
    const { ids } = await seed();
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026, the race): the numbers were written with a
    // plain HSET; they are now written by WRITE_NUMBERS_IF only over the change's own mark, so that EVAL's reply is swapped.
    const write = swap("EVAL", WRITE_NUMBERS_IF, reply);
    const { result, logged } = await outcome(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
    is(`${label}: the hide itself is written`, typeof result === "object" && result !== null, true);
    is(`${label}: the numbers' write was answered`, write.hit(), true);
    is(`${label}: the log says the numbers may not be kept`, logged > 0, true);
  }

  part("Recount: controls");
  {
    const { ids } = await seed();
    const { result, logged } = await outcome(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
    is("a healthy hide is written", typeof result === "object" && result !== null, true);
    is("its numbers are counted again", await raw(["HGET", SUM, PRODUCT]), numbers(2, 9, 1, 1, 0, [0, 0, 0, 1, 1]));
    is("and nothing is logged", logged, 0);
    // After an unknown read, the next change counts them right.
    swap("HGETALL", RECORDS, []);
    await outcome(() => setHidden(STATS, PRODUCT, ids[1], true, REASON));
    // Rule 23 (pre-review, 9 November 2026): "left stale" showed the numbers from before this hide; now they wait, unread.
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026, the race): the mark was the fixed text "recount"; each change's mark now carries a token of its own ("recount:<random>"), so a recount from before it never writes over it.
    is("left waiting (unread) after an unknown read, never stale", /^recount:[0-9a-f]{24}$/.test(String(await raw(["HGET", SUM, PRODUCT]))), true);
    await outcome(() => setHidden(STATS, PRODUCT, ids[0], false));
    is("and right again at the next change", await raw(["HGET", SUM, PRODUCT]), numbers(2, 9, 1, 1, 0, [0, 0, 0, 1, 1]));
    await outcome(() => setHidden(STATS, PRODUCT, ids[1], false));
    is("every review shown again", await raw(["HGET", SUM, PRODUCT]), numbers(2, 9, 2, 0, 0, [0, 0, 0, 1, 1]));
  }
  {
    // Only an exact empty hash is no reviews: the numbers go.
    const { ids } = await seed();
    swap("HGETALL", RECORDS, [[], null]); // Rule 23: with the set-aside hash's nil (see above).
    const { logged } = await outcome(() => setHidden(STATS, PRODUCT, ids[0], true, REASON));
    is("an exact empty read deletes the numbers", await raw(["HGET", SUM, PRODUCT]), null);
    is("without a log line", logged, 0);
  }

  part("The numbers' readers: an off-shape read is unknown, never none");
  const good = numbers(2, 9, 2, 0, 0, [0, 0, 0, 1, 1]);
  const badNumbers: [string, string][] = [
    ["not JSON", "{not json"],
    ["nil as JSON", "null"],
    ["a list", "[]"],
    ["a field missing", JSON.stringify({ count: 2, stars: 9, visible: 2, hidden: 0, dist: [0, 0, 0, 1, 1] })],
    ["a negative count", numbers(-1, 9, 2, 0, 0, [0, 0, 0, 1, 1])],
    ["a fraction", numbers(2, 9.5, 2, 0, 0, [0, 0, 0, 1, 1])],
    ["a short spread", numbers(2, 9, 2, 0, 0, [0, 0, 1, 1])],
    ["a spread that does not add up", numbers(2, 9, 2, 0, 0, [0, 0, 0, 1, 0])],
    ["stars that do not add up", numbers(2, 8, 2, 0, 0, [0, 0, 0, 1, 1])],
    ["shown and hidden that do not add up", numbers(2, 9, 3, 0, 0, [0, 0, 0, 1, 1])],
  ];
  for (const [label, reply] of [
    ["no reply", []],
    ["nil", [null]],
    ["a text", ["text"]],
    ["a field without its value", [[PRODUCT]]],
    ["numbers", [[PRODUCT, 2]]],
    ["a hole", [sparse(2)]],
    ["a field that is not a product", [["../x", good]]],
  ] as [string, unknown][]) {
    swap("HGETALL", SUM, reply);
    is(`summaries, ${label}: unknown`, (await outcome(() => summaries(STATS))).result, "unknown");
  }
  // Rule 23 (claude5/reviews-recount-exact, the per-product fix): one product's numbers not in their exact shape were
  // "unknown" for the whole store, which took every product's stars away; now only that product is unread (no stars,
  // never a number), and the reply's own shape is still unknown for all (above). tests/reviews-unread-isolated.test.ts.
  for (const [what, value] of badNumbers) {
    swap("HGETALL", SUM, [[PRODUCT, value]]);
    const read = (await outcome(() => summaries(STATS))).result;
    is(`summaries, numbers ${what}: that product is unread`, read instanceof Map ? [...(read as Map<string, unknown>)] : read, [[PRODUCT, "unread"]]);
  }
  for (const [label, reply] of [
    ["no reply", []],
    ["a number", [5]],
    ["an object", [{}]],
    ...badNumbers.map(([what, value]) => [`numbers ${what}`, [value]]),
  ] as [string, unknown][]) {
    swap("HGET", SUM, reply);
    is(`summaryOf, ${label}: unknown`, (await outcome(() => summaryOf(STATS, PRODUCT))).result, "unknown");
  }

  part("The numbers' readers: controls");
  await seed();
  swap("HGETALL", SUM, [[]]);
  is("summaries: an exact empty hash is none", [...((await outcome(() => summaries(STATS))).result as Map<string, unknown>)], []);
  is("summaries: as kept", [...((await outcome(() => summaries(STATS))).result as Map<string, unknown>)], [[PRODUCT, JSON.parse(good)]]);
  swap("HGET", SUM, [null]);
  is("summaryOf: nil is none", (await outcome(() => summaryOf(STATS, PRODUCT))).result, summarise([]));
  is("summaryOf: as kept", (await outcome(() => summaryOf(STATS, PRODUCT))).result, JSON.parse(good));

  part("A payment's list of reviews is never rewritten from an unknown read");
  for (const [label, reply] of [["no reply", []], ["a number", [5]], ["a list", [["a"]]]] as [string, unknown][]) {
    const { ids } = await seed();
    const before = await raw(["HGET", PAY, "pi_1"]);
    const read = swap("HGET", PAY, reply);
    const { result } = await outcome(() =>
      saveReview(STATS, { productId: "prod0002", email: "buyer1@example.com", reference: "cs_test_1", pi: "pi_1", rating: 5, text: "Also good", name: "Buyer 1" }, ROOM, 1_700_000_010_000),
    );
    is(`${label}: the list was read`, read.hit(), true);
    is(`${label}: the save says it is unknown`, result, "unknown");
    is(`${label}: the payment's list keeps the review it had`, await raw(["HGET", PAY, "pi_1"]), before);
    is(`${label}: which is the first review`, before, `${PRODUCT}|${ids[0]}`);
  }

  part("A refund is never taken as marked from an unknown read");
  for (const [label, reply] of [["no reply", []], ["a number", [5]]] as [string, unknown][]) {
    await seed();
    swap("HGET", PAY, reply);
    is(`payment's list, ${label}: unknown, so the refund pass tries again`, (await outcome(() => markRefunded(STATS, "pi_1"))).result, "unknown");
  }
  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["a stored review that does not read", ["{not json"]]] as [string, unknown][]) {
    const { ids } = await seed();
    const pass = swap("HGET", RECORDS, reply);
    // Rule 23 (pre-review, 9 November 2026): a stored review that does not read was "unknown" here, so every pass threw
    // and the refunds sweep stopped at it for good. It is damaged (waiting never changes it): skipped, never said as
    // marked (0), its product's numbers left waiting (unread). A reply lost or not text is still unknown.
    const damaged = label === "a stored review that does not read";
    is(`the review, ${label}: ${damaged ? "skipped, never said as marked" : "unknown, so the refund pass tries again"}`, (await outcome(() => markRefunded(STATS, "pi_1"))).result, damaged ? 0 : "unknown");
    is(`the review, ${label}: read`, pass.hit(), true);
    // Rule 23 (pre-review of claude5/reviews-recount-exact, 9 November 2026, the race): the mark was the fixed text "recount"; each change's mark now carries a token of its own ("recount:<random>"), so a recount from before it never writes over it.
    if (damaged) is(`the review, ${label}: its product's numbers wait, unread`, /^recount:[0-9a-f]{24}$/.test(String(await raw(["HGET", SUM, PRODUCT]))), true);
    swap("HGET", RECORDS, reply);
    is(`one refund, ${label}: unknown`, (await outcome(() => markOneRefunded(STATS, PRODUCT, ids[0]))).result, "unknown");
    swap("HGET", RECORDS, reply);
    is(`a hide, ${label}: unknown, never "missing"`, (await outcome(() => setHidden(STATS, PRODUCT, ids[0], true, REASON))).result, "unknown");
    is(`${label}: the review is not marked`, JSON.parse((await raw(["HGET", RECORDS, ids[0]])) as string).refunded, false);
  }

  part("Refunds and the creator's changes: controls");
  {
    const { ids } = await seed();
    is("a refund marks its review", (await outcome(() => markRefunded(STATS, "pi_1"))).result, 1);
    is("and its stars leave the numbers", await raw(["HGET", SUM, PRODUCT]), numbers(1, 5, 2, 0, 1, [0, 0, 0, 0, 1]));
    is("a payment with no list marks none", (await outcome(() => markRefunded(STATS, "pi_9"))).result, 0);
    swap("HGET", RECORDS, [null]);
    is("a review confirmed absent is missing", (await outcome(() => setHidden(STATS, PRODUCT, ids[1], true, REASON))).result, "missing");
  }

  part("A removed product's reviews are never dropped from an unknown read");
  // Read with one HGETALL (ids and records from one moment), no longer HKEYS then HVALS: the replies below are that
  // command's (rule 23, see the fix's commit).
  // Rule 23 (the per-product fix): "a stored review that does not read" and "a record under another id" left this list.
  // They were unknown and nothing was dropped, so a removed product's reviews stayed with no way out; such a record
  // answered in its exact place is damaged, not unknown, and is dropped with the others below (its photo cannot be
  // found, and the log says so). tests/reviews-unread-isolated.test.ts holds it with photos.
  for (const [label, reply] of [
    ["no reply", []],
    ["nil", [null]],
    ["an id without its record", "odd"],
    ["a field that is not a review id", "badfield"],
  ] as [string, unknown][]) {
    const { ids, rows } = await seed();
    // Rule 23 (pre-review of a8737e12a6): the removal reads the product's records set aside in the same request (a
    // second HGETALL), so an answer of one reply to the records carries the set-aside hash's own (empty) after it.
    const records = reply === "odd" ? [[ids[0], rows[0], ids[1]]] : reply === "badfield" ? [["../x", rows[0], ids[1], rows[1]]] : reply;
    const answer = Array.isArray(records) && records.length === 1 ? [...records, []] : records;
    const read = swap("HGETALL", RECORDS, answer);
    is(`${label}: unknown`, (await outcome(() => dropReviews(STATS, PRODUCT))).result, "unknown");
    is(`${label}: read`, read.hit(), true);
    is(`${label}: the reviews are kept`, await raw(["HLEN", RECORDS]), 2);
    is(`${label}: and the studio's list of them`, await raw(["ZCARD", ALL]), 2);
    is(`${label}: and the numbers`, typeof (await raw(["HGET", SUM, PRODUCT])), "string");
  }

  for (const [label, damaged] of [
    ["a stored review that does not read", (ids: string[], rows: string[]) => [ids[0], rows[0], ids[1], "{not json"]],
    ["a record under another id", (ids: string[], rows: string[]) => [ids[0], rows[1], ids[1], rows[0]]],
  ] as [string, (ids: string[], rows: string[]) => string[]][]) {
    const { ids, rows } = await seed();
    // Rule 23 (pre-review of a8737e12a6): with the set-aside hash's own (empty) reply after the records' (see above).
    swap("HGETALL", RECORDS, [damaged(ids, rows), []]);
    const { result, logged } = await outcome(() => dropReviews(STATS, PRODUCT));
    is(`${label}: dropped with the others, no photo taken from it`, result, []);
    is(`${label}: the log says so`, logged > 0, true);
    is(`${label}: the reviews are gone`, await raw(["HLEN", RECORDS]), 0);
    is(`${label}: and the studio's list of them`, await raw(["ZCARD", ALL]), 0);
    is(`${label}: and the numbers`, await raw(["HGET", SUM, PRODUCT]), null);
  }

  part("Dropping a removed product's reviews: control");
  await seed();
  is("a healthy drop has no photos to give back", (await outcome(() => dropReviews(STATS, PRODUCT))).result, []);
  is("its reviews are gone", await raw(["HLEN", RECORDS]), 0);
  is("and the studio's list of them", await raw(["ZCARD", ALL]), 0);
  is("and the queue", await raw(["ZCARD", NEW]), 0);
  is("and the numbers", await raw(["HGET", SUM, PRODUCT]), null);

  part("The pages say the totals could not be read, never that there are none");
  const studio = readFileSync("app/studio/reviews/page.tsx", "utf8");
  const reviewsPage = readFileSync("app/[handle]/p/[product]/reviews/page.tsx", "utf8");
  is("the studio keeps a failed read of the totals as unknown", studio.includes("summaries(store.statsId).catch((): null => null)"), true);
  is(
    "the studio says so in a live region",
    studio.includes('<p className="mt-2 text-sm text-ink-soft" role="status">The totals could not be read just now. Reload to try again; this does not mean there are none.</p>'),
    true,
  );
  is("the AI summaries are not drawn from totals that were not read", studio.includes("const aiSummaries = keptSummaries === null || numbers === null || (summed.length === 0 && unreadTotals > 0) ? null"), true);
  is("the reviews page keeps a failed read of the totals as unknown", reviewsPage.includes("summaryOf(store.statsId, product.id).catch((): null => null)"), true);
  is("and then reads no reviews, saying they could not be loaded", reviewsPage.includes("const reviews = summary === null ? null :"), true);
  is("and never says there are none to show", reviewsPage.includes("{summary !== null && summary.visible === 0 ?"), true);

  done();
}

void main();
