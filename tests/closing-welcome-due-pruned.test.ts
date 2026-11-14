/**
 * A closing store's queued welcome-offer reminders leave the company queue
 * with the rest of its records (Claude 3 cloud I, erasure audit 14/11/2026).
 *
 * Each member of nl:wo:due is JSON naming the store and holding the buyer's
 * address (lib/welcome-offer-send.ts): {"s":"<sid>","i":"<statsId>",...,"e":"<email>"}.
 * The walk that erases closed stores prunes company lists by splitting each
 * member on ":", "|" and ",", so a JSON member's ids keep their quotes and
 * never match the closing store's marks: the reminder, with the buyer's
 * address, stayed queued after the store was reported erased. Synthetic data only.
 */
import { walkPage } from "@/lib/closed-store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipe = redis.pipeline.bind(redis);
const member = (sid: string, statsId: string, email: string) => JSON.stringify({ s: sid, i: statsId, h: "h".repeat(16), e: email, t: "t".repeat(32) });

async function main(): Promise<void> {
  redis.clear();
  const closing = member("sid_closing", "a".repeat(32), "buyer@example.test");
  const staying = member("sid_staying", "b".repeat(32), "other@example.test");
  await pipe([["ZADD", "nl:wo:due", "2000000000", closing], ["ZADD", "nl:wo:due", "2000000001", staying]]);
  const owners = {
    byMark: new Map([["sid_closing", "closing@example.test"], ["a".repeat(32), "closing@example.test"]]),
    byHandle: new Map([["closing", "closing@example.test"]]),
    byRef: new Map([["closing@example.test", "closing@example.test"]]),
  };
  part("The walk prunes a closing store's welcome reminders from the queue");
  const result = await walkPage(["nl:wo:due"], new Map(), owners);
  const left = (await pipe([["ZRANGEBYSCORE", "nl:wo:due", "-inf", "+inf"]]))[0] as string[];
  is("the closing store's reminder, with the buyer's address, is gone", left.includes(closing), false);
  is("another store's reminder stays", left.includes(staying), true);
  is("one member pruned", result.pruned, 1);
}

void main().then(done).catch((error) => {
  console.error(error);
  process.exit(1);
});
