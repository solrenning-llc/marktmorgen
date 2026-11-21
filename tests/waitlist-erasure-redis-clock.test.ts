/**
 * A deletion that just began, judged on one clock (Claude 1 cloud's review of #2576 at 9a6c389f74, LEVE,
 * lib/waitlist.ts joinWaitlist): the deletion's mark is written in seconds of Redis's own clock (lib/suppression.ts
 * ERASED_PRINT), and it was compared with the instance's clock (startedAt), which lib/suppression.ts itself warns
 * against. With the instance's clock 20 minutes ahead of Redis's, an address deleted this very second read as deleted
 * "long ago": its place was written and its link sent. Now the mark is read against Redis's TIME in the same step.
 * Synthetic store (MemoryRedis, whose clock is moved apart from the instance's), simulated Resend.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outside = 0;
let emails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    emails++;
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

const MINUTE = 60_000;

async function fixture(redisBehindMs: number) {
  redis.clear();
  (redis as unknown as { now: () => number }).now = () => Date.now() - redisBehindMs;
  emails = 0;
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@example.test", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.test");
  await ensureListId("owner@example.test");
  const made = await addProduct("owner@example.test", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.test"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  const key = `nl:wl:${store.statsId}:${product.id}`;
  const join = (email: string) => joinWaitlist({ store, product, email, consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" });
  const erase = async (email: string, secondsAgo = 0) => {
    const at = Math.floor((Date.now() - redisBehindMs) / 1000) - secondsAgo;
    await redis.pipeline([secondsAgo ? suppressCommand(store.listId!, email, at) : suppressCommand(store.listId!, email)]);
  };
  const placed = async (email: string) => ((await redis.pipeline([["HEXISTS", key, email]])) as number[])[0];
  return { join, erase, placed };
}

async function main(): Promise<void> {
  for (const [what, behind] of [["the same clock", 0], ["Redis's clock 20 minutes behind the instance's", 20 * MINUTE], ["Redis's clock 20 minutes ahead of the instance's", -20 * MINUTE]] as const) {
    part(`An address deleted this second, ${what}`);
    const f = await fixture(behind);
    await f.erase("gus@example.test");
    is(`${what}: asked to try again later`, await f.join("gus@example.test"), "error");
    is(`${what}: no place is kept`, await f.placed("gus@example.test"), 0);
    is(`${what}: no link is sent`, emails, 0);
  }
  part("An address deleted an hour ago on Redis's clock may sign up again");
  const later = await fixture(20 * MINUTE);
  await later.erase("hana@example.test", 3_600);
  is("signed up", await later.join("hana@example.test"), "sent");
  part("Control: nobody deleted");
  const plain = await fixture(20 * MINUTE);
  is("signed up", await plain.join("ivo@example.test"), "sent");
  (redis as unknown as { now: () => number }).now = () => Date.now();
  is("no outside request", outside, 0);
  done();
}
void main();
