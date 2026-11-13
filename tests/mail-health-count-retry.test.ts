/**
 * j-mail-9 (Claude 3 cloud J, email audit): a bounce or a spam report counts once toward the store's pause
 * (lib/mail-health.ts heardFromSender). The address was marked counted for the week before its count was written,
 * so a count that failed (an unwell Redis) was never written: the route answered 500, Amazon or Resend sent the
 * notice again, and the retry found the mark and said "ignored". A bad list could stay under the pause line.
 * Synthetic only: Redis is tests/redis-stub.ts.
 */
import { heardFromSender, listHealth } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  const id = "a".repeat(32);
  const healthy = redis.pipeline;
  part("The count fails once; the notice comes again");
  let failing = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (failing && commands.some((c) => String(c[0]).toUpperCase() === "HINCRBY")) throw new Error("synthetic Redis outage");
    return healthy.call(redis, commands);
  }) as typeof redis.pipeline;
  let threw = false;
  try { await heardFromSender({ kind: "bounced", permanent: true, to: "gone@example.com", store: id, list: "" }); } catch { threw = true; }
  failing = false;
  redis.pipeline = healthy;
  is("the failed count is a failure, so the sender sends the notice again", threw, true);
  // The sender's next try, twenty seconds on.
  redis.advance(21_000);
  const again = await heardFromSender({ kind: "bounced", permanent: true, to: "gone@example.com", store: id, list: "" });
  redis.now = () => Date.now();
  is("the notice sent again is counted, once", [again, (await listHealth(id)).bounced], ["counted", 1]);
  is("and the same address again is one bad address, not two", [await heardFromSender({ kind: "bounced", permanent: true, to: "gone@example.com", store: id, list: "" }), (await listHealth(id)).bounced], ["ignored", 1]);
  done();
}
void main();
