/**
 * A product deleted takes its reviews' hide marks with it (lib/reviews.ts dropReviews).
 *
 * A buyer's review the creator hid and the buyer then deleted leaves a mark (nl:rev:hid:<stats>:<product>) so that
 * writing it again cannot bring it back into view. When the product itself is deleted, dropReviews removed its
 * reviews, index and summary but left the mark until the store closed, and person erasure could not reach it
 * either (it passes only the products that still exist). In-memory Redis; synthetic ids.
 */
import { dropReviews } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const stats = "5".repeat(32);
  const product = "prodhidedrop01";
  const mark = `nl:rev:hid:${stats}:${product}`;
  const reviews = `nl:rev:${stats}:${product}`;
  await redis.pipeline([["HSET", mark, "r".repeat(32), "spam"], ["HSET", reviews, "q".repeat(32), "{}"]]);

  part("a deleted product's hide marks go with its reviews");
  await dropReviews(stats, product);
  is("its reviews are deleted (control)", (await redis.pipeline([["EXISTS", reviews]]))[0], 0);
  is("the hide mark is deleted", (await redis.pipeline([["EXISTS", mark]]))[0], 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
