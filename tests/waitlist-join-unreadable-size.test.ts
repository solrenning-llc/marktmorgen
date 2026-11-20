/**
 * A sign-up whose read of the list comes back in another shape is unknown, never "room left" (Claude 4 cloud R's
 * MEDIUM on #3707, lib/waitlist.ts joinWaitlist): an HLEN that is not a whole count used to become NaN, and
 * `NaN >= MAX_WAITLIST` is false, so the public list's ceiling was skipped and the address took room. A place read as
 * something other than a string or nothing is unknown too. Synthetic store (MemoryRedis), simulated Resend.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { dataUsed } from "@/lib/store-data";
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

async function fixture() {
  redis.clear();
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
  const used = async () => (await dataUsed(store))?.used ?? -1;
  const join = (email: string) => joinWaitlist({ store, product, email, consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" });
  return { key, used, join };
}

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  const isRead = (cs: (string | number)[][], key: string) => cs.length === 2 && cs[0][0] === "HGET" && cs[0][1] === key && cs[1][0] === "HLEN";

  part("Control: a healthy sign-up is sent");
  const healthy = await fixture();
  is("signed up", await healthy.join("dana@example.test"), "sent");

  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["an HLEN that is text", (r) => [r[0], "lots"]],
    ["an HLEN that is missing", (r) => [r[0], undefined]],
    ["an HLEN that is a fraction", (r) => [r[0], 1.5]],
    ["a pipeline that answers one reply", (r) => [r[0]]],
    ["a place read as a number", (r) => [7, r[1]]],
  ];
  for (const [what, bend] of shapes) {
    part(`A sign-up whose read comes back as ${what} is unknown`);
    const bent = await fixture();
    const before = await bent.used();
    redis.pipeline = (async (cs: (string | number)[][]) => {
      const replies = (await pipe(cs)) as unknown[];
      return isRead(cs, bent.key) ? bend(replies) : replies;
    }) as typeof redis.pipeline;
    const answer = await bent.join("erin@example.test").catch((error: Error) => `threw ${error.name}`);
    redis.pipeline = pipe;
    is(`${what}: the answer is an error`, answer, "error");
    const [placed] = (await redis.pipeline([["HEXISTS", bent.key, "erin@example.test"]])) as number[];
    is(`${what}: no place is written`, placed, 0);
    is(`${what}: no room is taken`, (await bent.used()) - before, 0);
    is(`${what}: no email is sent`, emails, 0);
  }
  is("no outside request", outside, 0);
  done();
}
void main();
