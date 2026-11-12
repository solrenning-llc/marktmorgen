/**
 * A product's stars counted again only from an exact read (rules 24 and 30; audit F2 of lib/, 12 November 2026).
 *
 * After every change to a review, recount (lib/reviews.ts) reads the product's reviews (HGETALL) and keeps the
 * numbers shown on its page: the average, the count, the stars. A reply that cannot be read is unknown: never
 * "no reviews", which would take the product's numbers away (HDEL) though its reviews are all still there. Checked
 * against the real code with an in-memory Redis:
 *
 *   - a readable product: hiding a review counts them again;
 *   - HGETALL answered in another shape (a string, null, a list with a key and no value, a key that is not text), or
 *     in its shape with one stored review that does not read, or that belongs to another key or product: the change is
 *     said as failed and the numbers shown stay as they were, for the next change to count again;
 *   - a deletion while another review of the product does not read: the deletion is done and said so (a person's
 *     erasure never waits on someone else's unreadable review), and the numbers are not lowered by leaving it out.
 */
import { deleteReview, saveReview, setHidden, summaryOf } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "f".repeat(32);
const PRODUCT = "mugs000003";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
function productRead(change: ((reply: unknown) => unknown) | null): void {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const replies = await realPipeline(commands);
    if (!change) return replies;
    return replies.map((reply, i) => (commands[i][0] === "HGETALL" && commands[i][1] === `nl:rev:${STATS}:${PRODUCT}` ? change(reply) : reply));
  };
}

async function main(): Promise<void> {
  redis.clear();
  const ids: string[] = [];
  for (const [n, rating] of [[1, 5], [2, 3], [3, 4]] as const) {
    const saved = await saveReview(STATS, { productId: PRODUCT, email: `buyer${n}@example.com`, reference: `cs_test_rc${n}`, pi: `pi_rc${n}`, rating, text: "Fine mug.", name: `B${n}` }, ROOM, 1_700_000_000_000 + n);
    if (saved.state !== "created") throw new Error(`review not written: ${saved.state}`);
    ids.push(saved.review.id);
  }
  part("A readable product");
  await setHidden(STATS, PRODUCT, ids[2], true, "unrelated");
  const shown = await summaryOf(STATS, PRODUCT);
  is("hiding one counts them again: three counted, two visible, one hidden", [shown.count, shown.visible, shown.hidden], [3, 2, 1]);

  part("A read that cannot be trusted");
  const cases: [string, (reply: unknown) => unknown][] = [
    ["a string", () => "OK"],
    ["null", () => null],
    ["a key with no value", (reply) => (reply as unknown[]).slice(0, 1)],
    ["a key that is not text", (reply) => (reply as unknown[]).map((one, i) => (i % 2 === 0 ? 7 : one))],
    // Well shaped (an even list of strings), but one stored review cannot be read: never counted as no review.
    ["one stored review that does not read", (reply) => (reply as unknown[]).map((one, i) => (i === 1 ? "{not a review" : one))],
    ["one stored review with no rating", (reply) => (reply as unknown[]).map((one, i) => (i === 1 ? JSON.stringify({ ...JSON.parse(one as string), rating: 9 }) : one))],
    // A review that reads, but under a key that is not its own id, or for another product.
    ["one review under another review's key", (reply) => (reply as unknown[]).map((one, i, all) => (i === 1 ? all[3] : one))],
    ["one review of another product", (reply) => (reply as unknown[]).map((one, i) => (i === 1 ? JSON.stringify({ ...JSON.parse(one as string), productId: "mugs000004" }) : one))],
  ];
  for (const [what, change] of cases) {
    productRead(change);
    let outcome: string;
    try {
      await setHidden(STATS, PRODUCT, ids[1], true, "unrelated");
      outcome = "done";
    } catch {
      outcome = "failed";
    }
    productRead(null);
    const after = await summaryOf(STATS, PRODUCT);
    is(`${what}: said as failed, the numbers shown stay`, [outcome, after], ["failed", shown]);
    await setHidden(STATS, PRODUCT, ids[1], false);
  }

  part("A deletion while another review does not read");
  {
    productRead((reply) => (reply as unknown[]).map((one, i) => (i === 1 ? "{not a review" : one)));
    const outcome = await deleteReview(STATS, PRODUCT, ids[0], ROOM);
    productRead(null);
    is("the deletion is done and said so", outcome, "deleted");
    is("the numbers are not lowered by leaving the unreadable review out", await summaryOf(STATS, PRODUCT), shown);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
