/**
 * A waitlist place's room is given back only when Redis answered an exact 0 (Claude 5's second review of #2576,
 * item 4 and its two siblings): an answer that is not exact may mean the place WAS written, so its room stays taken,
 * and a changed place whose write is uncertain counts what it grew by. Synthetic store (MemoryRedis), simulated
 * Resend; no other outside request.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, setSoon } from "@/lib/waitlist";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outside = 0;
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    sent.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function fixture() {
  redis.clear();
  sent.length = 0;
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
  return { store, product, key, used, join };
}

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);

  part("Control: a healthy sign-up counts its place");
  const healthy = await fixture();
  const start = await healthy.used();
  is("signed up", await healthy.join("dana@example.test"), "sent");
  const one = (await healthy.used()) - start;
  is("its place takes room", one > 0, true);

  part("The place is written but its answer is lost");
  const lost = await fixture();
  const before = await lost.used();
  redis.pipeline = (async (cs: (string | number)[][]) => {
    const replies = await pipe(cs);
    return cs.length === 1 && cs[0][0] === "HSETNX" && cs[0][1] === lost.key ? [null] : replies;
  }) as typeof redis.pipeline;
  const answer = await lost.join("dana@example.test").catch((error: Error) => error.name);
  redis.pipeline = pipe;
  const [kept] = (await redis.pipeline([["HEXISTS", lost.key, "dana@example.test"]])) as number[];
  is("the place is there", kept, 1);
  is("the sign-up goes on", answer, "sent");
  is("its room stays counted, exactly as a healthy one", (await lost.used()) - before, one);

  part("A confirmation whose swap is written but its answer is lost still counts what the place grew by");
  const reference = await fixture();
  await reference.join("erin@example.test");
  const refJoined = await reference.used();
  is("reference: confirmed", (await confirmSpot(tokenIn(sent.join("\n")), reference.store)).ok, true);
  const grows = (await reference.used()) - refJoined;
  is("a confirmation grows the place", grows > 0, true);
  const again = await fixture();
  await again.join("erin@example.test");
  const againJoined = await again.used();
  let swaps = 0;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    const replies = await pipe(cs);
    if (cs.length === 1 && cs[0][0] === "EVAL" && String(cs[0][1]).startsWith("-- marktmorgen:hash-swap-if:v1") && cs[0][3] === again.key && swaps++ === 0) return [null];
    return replies;
  }) as typeof redis.pipeline;
  const confirmed = await confirmSpot(tokenIn(sent.join("\n")), again.store);
  redis.pipeline = pipe;
  is("the lost answer was injected once", swaps, 1);
  is("the press is confirmed", confirmed.ok, true);
  is("what it grew by is counted, exactly as a healthy one", (await again.used()) - againJoined, grows);
  is("no outside request", outside, 0);
  done();
}
void main();
