/**
 * Reviews read in an unknown shape (rule 24): never read as "no review",
 * "no reviews for this payment" or "no reviews to erase".
 *
 *   - a refund marks the reviews its payment paid for; an unknown answer
 *     used to mark none, and the refund pass then took the refund as seen;
 *   - a second review on the same payment used to overwrite the payment's
 *     list with itself alone, so a later refund missed the first;
 *   - a recount on an unknown list used to delete the product's stars;
 *   - erasing a buyer used to report no review on an unknown answer;
 *   - forgetting a product's reviews used to leave its photos and index.
 *
 * Synthetic only: the Redis stub and the test data room.
 */
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { dropReviews, forgetReviewsPerson, markRefunded, parseReview, readReview, reviewId, saveReview, summaries, summaryOf, visibleReviews } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const MALFORMED: [string, (c: Commands) => unknown[]][] = [
  ["no reply", () => []],
  ["undefined", () => [undefined]],
  ["a number", () => [5]],
  ["an object", () => [{}]],
  ["an extra reply", (c) => [null, ...c.map(() => null)]],
];

async function outcome<T>(match: (c: Commands) => boolean, reply: (c: Commands) => unknown[], body: () => Promise<T>): Promise<T | "rejected"> {
  let hit = false;
  redis.pipeline = (async (c: Commands) => {
    if (!hit && match(c)) {
      hit = true;
      return reply(c);
    }
    return real(c);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  const owner = "reviews-exact@example.com";
  await claimHandle(owner, "reviewsexact", "Reviews Exact", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const a = await addProduct(owner, "Bread Book", "", "19", null);
  const b = await addProduct(owner, "Cake Book", "", "19", null);
  if (!a.ok || !b.ok) throw new Error("no product");
  const pa = a.product.id, pb = b.product.id;
  const buyer = "buyer@example.com";
  const payKey = `nl:rev:pay:${statsId}`;
  const save = (productId: string, pi: string, email = buyer) =>
    saveReview(statsId, { productId, email, reference: `cs_test_${pi}`, pi, rating: 5, text: "A fictional review with enough words.", name: "Reader" }, ROOM);
  const hget = (key: string) => (c: Commands) => c.length === 1 && c[0][0] === "HGET" && c[0][1] === key;
  const raw = async (productId: string, id: string) => parseReview((await real([["HGET", `nl:rev:${statsId}:${productId}`, id]]))[0]);

  const first = await save(pa, "pi_one");
  if (first.state !== "created") throw new Error(`no review: ${first.state}`);
  const ida = first.review.id;
  const [payBefore] = await real([["HGET", payKey, "pi_one"]]);
  is("the payment lists its review", payBefore, `${pa}|${ida}`);

  for (const [label, reply] of MALFORMED) {
    part(`A second review on the same payment, its list answering ${label}`);
    await real([["HSET", payKey, "pi_one", `${pa}|${ida}`], ["HDEL", `nl:rev:${statsId}:${pb}`, reviewId(statsId, pb, buyer)]]);
    const second = await outcome(hget(payKey), reply, () => save(pb, "pi_one"));
    is("the save does not overwrite the list on a guess", second === "rejected" ? "rejected" : second.state, "rejected");
    is("the first review is still listed for the payment", String((await real([["HGET", payKey, "pi_one"]]))[0]).split(";").includes(`${pa}|${ida}`), true);

    part(`A refund, the payment's list answering ${label}`);
    await real([["HSET", payKey, "pi_one", `${pa}|${ida}`]]);
    is("the refund pass is told it is not known", await outcome(hget(payKey), reply, () => markRefunded(statsId, "pi_one")), "rejected");
    is("nothing marked", (await raw(pa, ida))?.refunded, false);

    part(`A refund, the review itself answering ${label}`);
    is("the refund pass is told it is not known", await outcome(hget(`nl:rev:${statsId}:${pa}`), reply, () => markRefunded(statsId, "pi_one")), "rejected");
    is("nothing marked", (await raw(pa, ida))?.refunded, false);

    part(`Erasing the buyer, their review answering ${label}`);
    const erased = await outcome((c) => c[0]?.[0] === "HGET" && c[0][1] === `nl:rev:${statsId}:${pa}`, (c) => c.length === 1 ? reply(c) : [...reply(c), null], () => forgetReviewsPerson(statsId, [pa], buyer, ROOM));
    is("never reported as no review", erased, "rejected");
    is("the review is still there to erase", (await raw(pa, ida)) !== null, true);

    part(`Reading, the answers in ${label}`);
    is("one review", await outcome(hget(`nl:rev:${statsId}:${pa}`), reply, () => readReview(statsId, pa, ida)), "rejected");
    is("a product's stars", await outcome(hget(`nl:rev:sum:${statsId}`), reply, () => summaryOf(statsId, pa)), "rejected");
    is("every product's stars", await outcome((c) => c[0]?.[0] === "HGETALL" && c[0][1] === `nl:rev:sum:${statsId}`, reply, () => summaries(statsId)), "rejected");
    is("the visible list", await outcome((c) => c[0]?.[0] === "ZREVRANGEBYSCORE", reply, () => visibleReviews(statsId, pa)), "rejected");
    is("the visible records", await outcome((c) => c[0]?.[0] === "HMGET", reply, () => visibleReviews(statsId, pa)), "rejected");

    part(`A recount, the product's reviews answering ${label}`);
    const before = (await real([["HGET", `nl:rev:sum:${statsId}`, pa]]))[0];
    const recount = await outcome((c) => c.length === 1 && c[0][0] === "HGETALL" && c[0][1] === `nl:rev:${statsId}:${pa}`, reply, () => save(pa, "pi_two", `other-${label.length}@example.com`));
    is("the save says it could not finish", recount === "rejected" ? "rejected" : recount.state, "rejected");
    is("the product's stars are not deleted", (await real([["HGET", `nl:rev:sum:${statsId}`, pa]]))[0] !== null, true);
    void before;
  }

  part("Forgetting a product's reviews, its list answering in an unknown shape");
  const photoKey = `nl:rev:${statsId}:${pb}`;
  const dropped = await outcome((c) => c[0]?.[0] === "HKEYS" && c[0][1] === photoKey, () => [undefined, undefined], () => dropReviews(statsId, pb));
  is("never forgotten on a guess", dropped, "rejected");

  part("Controls");
  is("a payment with no list: nothing to mark", await markRefunded(statsId, "pi_none"), 0);
  is("an absent review reads as none", await readReview(statsId, pa, "0".repeat(24)), null);
  is("the healthy review reads", (await readReview(statsId, pa, ida))?.id, ida);
  is("the refund marks it", await markRefunded(statsId, "pi_one"), 1);
  is("erasing a buyer with no review: none", (await forgetReviewsPerson(statsId, [pa], "nobody@example.com", ROOM)).records, 0);
  done();
}

void main();
