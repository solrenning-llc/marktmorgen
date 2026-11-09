// Pre-review proof of claude5/reviews-recount-exact (9 November 2026), kept as its regression test. A change marks its
// product's numbers as waiting for their recount, and the recount that follows replaces the mark. The mark was the
// fixed text "recount" and the recount wrote its numbers unconditionally, so a recount from before another change could
// still write the numbers it counted over that change's mark: when the product's lock ran out under it (10 s; each
// request may take up to 5 s), or when a write that timed out on the client ran later on the server. The page then
// showed numbers that no longer were (here 6 stars from a review changed to 1). Now each change's mark carries a token
// of its own ("recount:<random>"), and a recount writes its numbers in one step only while the mark is still the one it
// counted for (a script, modelled by lib/redis-memory.ts and run on a real Redis by scripts/test_review_recount_redis.py);
// the daily pass does the same with the mark it read. Synthetic Redis only (tests/redis-stub.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveReview, setHidden, summaries, summaryOf, recountWaiting, HIDE_REASONS, UNREAD_NUMBERS } from "@/lib/reviews";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const STATS = "f".repeat(32);
const PRODUCT = "prod0009";
const RECORDS = `nl:rev:${STATS}:${PRODUCT}`;
const SUM = `nl:rev:sum:${STATS}`;
const LOCK = `nl:rev:lock:${STATS}:${PRODUCT}`;
const REASON = HIDE_REASONS[0].id;
const MARK = /^recount:[0-9a-f]{24}$/;

async function shown(): Promise<unknown> {
  const one = (await summaries(STATS)).get(PRODUCT);
  return one === UNREAD_NUMBERS ? "unread" : one && typeof one === "object" ? [one.count, one.stars] : one ?? "none";
}

const held = async () => (await original([["HGET", SUM, PRODUCT]]))[0];

async function seed(): Promise<string[]> {
  redis.clear();
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const s = await saveReview(STATS, { productId: PRODUCT, email: `b${n}@example.com`, reference: `cs_test_${n}`, pi: `pi_${n}`, rating: n === 1 ? 1 : 5, text: `R${n}`, name: `B${n}` }, ROOM, 1_700_000_000_000 + n);
    if (s.state === "created") ids.push(s.review.id);
  }
  return ids;
}

/** Buyer 2 moves from 5 stars to 1, while `when` holds: the change marks the numbers and counts them again itself. */
const buyerTwoToOne = () =>
  saveReview(STATS, { productId: PRODUCT, email: "b2@example.com", reference: "cs_test_2", pi: "pi_2", rating: 1, text: "R2", name: "B2" }, ROOM, 1_700_000_100_000);

async function main() {
  console.error = () => {};

  part("A recount from before another change never writes over that change's mark");
  {
    const ids = await seed();
    is("before", await shown(), [2, 6]);
    let paused = false;
    redis.pipeline = (async (batch: Command[]) => {
      if (!paused && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
        paused = true;
        const stale = await original(batch); // A's recount reads now (r1 hidden, r2 at 5 stars)
        redis.run(["DEL", LOCK]); // A's 10 s lock ran out
        redis.pipeline = original;
        await buyerTwoToOne(); // B: marks, writes and counts again
        redis.pipeline = (async (b: Command[]) => original(b)) as typeof redis.pipeline;
        return stale; // A's write of what it counted comes after
      }
      return original(batch);
    }) as typeof redis.pipeline;
    await setHidden(STATS, PRODUCT, ids[0], true, REASON); // A: hides r1
    redis.pipeline = original;
    is("after buyer 2 moved to 1 star: [2,2], never the 6 stars from before", await shown(), [2, 2]);
  }

  part("A recount's write that runs late on the server never writes over a newer change's mark");
  {
    const ids = await seed();
    // B's own recount read is lost for a moment, so B's mark stays waiting; then A's write (counted before B) arrives.
    let stale: Command[] | null = null;
    redis.pipeline = (async (batch: Command[]) => {
      const first = batch[0];
      if (!stale && first && (first[0] === "EVAL" || (first[0] === "HSET" && first[1] === SUM))) {
        stale = batch; // A's write times out on the client; the server runs it later
        return [];
      }
      return original(batch);
    }) as typeof redis.pipeline;
    await setHidden(STATS, PRODUCT, ids[0], true, REASON); // A: hides r1, its write held back
    let lost = false;
    redis.pipeline = (async (batch: Command[]) => {
      if (!lost && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
        lost = true;
        return [];
      }
      return original(batch);
    }) as typeof redis.pipeline;
    await buyerTwoToOne(); // B: marks; its recount's read lost
    redis.pipeline = original;
    const waiting = await held();
    is("B's mark waits, with a token of its own", typeof waiting === "string" && MARK.test(waiting), true);
    if (stale) await original(stale); // the server runs A's late write now
    is("A's late write left B's mark: unread, never the numbers A counted before it", await shown(), "unread");
    is("the mark is still B's", await held(), waiting);
    is("summaryOf takes it as unread, never as numbers", await summaryOf(STATS, PRODUCT).then(() => "numbers", (e) => (e instanceof UnknownReplyError ? "unread" : String(e))), "unread");
    const pass = await recountWaiting(Date.now() + 60_000);
    is("the daily pass counts it again from B's mark", [pass.recounted, pass.unsure, await shown()], [1, 0, [2, 2]]);
  }

  part("The daily pass never writes over a mark written after it read the store's numbers");
  {
    await seed();
    await original([["HSET", SUM, PRODUCT, "recount:" + "a".repeat(24)]]);
    let swapped = false;
    redis.pipeline = (async (batch: Command[]) => {
      if (!swapped && batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === RECORDS) {
        swapped = true;
        const read = await original(batch);
        await original([["HSET", SUM, PRODUCT, "recount:" + "b".repeat(24)]]); // a change marked meanwhile
        return read;
      }
      return original(batch);
    }) as typeof redis.pipeline;
    const pass = await recountWaiting(Date.now() + 60_000);
    redis.pipeline = original;
    is("not said as recounted", [pass.recounted, pass.unsure], [0, 1]);
    is("the newer mark stays", await held(), "recount:" + "b".repeat(24));
  }

  part("Every mark is a recount token; no reader takes it as numbers");
  {
    const source = readFileSync(join(process.cwd(), "lib/reviews.ts"), "utf8");
    is("no fixed mark is written", /RECOUNT_PENDING\s*=\s*"recount"/.test(source), false);
    is("the numbers are never written outside the script", /\["HSET", summaryKey\(statsId\), productId, JSON\.stringify/.test(source), false);
  }

  done();
}
void main();
