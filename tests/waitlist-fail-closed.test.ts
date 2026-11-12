/**
 * A waitlist sign-up never reads an unknown Redis reply as a safe value (rule 24; Claude 7's LEVE findings on #2576,
 * lib/waitlist.ts): a list size that is not an exact count is not "under the cap", and a deletion mark that is neither
 * absent (an exact null) nor a whole number of seconds is not "not deleted". Either way the sign-up answers "error",
 * keeps no place with the address on it, gives back the room it took and sends nothing. Synthetic store (MemoryRedis),
 * simulated Resend; no other outside request.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { dataUsed } from "@/lib/store-data";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
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
  const placed = async (email: string) => ((await redis.pipeline([["HEXISTS", key, email]])) as number[])[0];
  return { store, product, key, used, join, placed, listId: store.listId! };
}

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);

  part("Control: a healthy sign-up with exact replies is sent");
  const healthy = await fixture();
  is("signed up", await healthy.join("dana@example.test"), "sent");
  is("its place is there", await healthy.placed("dana@example.test"), 1);

  for (const [label, reply] of [
    ["a word", "many"],
    ["a missing reply", undefined],
    ["null", null],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a number past the safe integers", 2 ** 53],
  ] as const) {
    part(`The list's size answered as ${label} is unknown, never under the cap`);
    const f = await fixture();
    const before = await f.used();
    redis.pipeline = (async (cs: (string | number)[][]) => {
      const replies = (await pipe(cs)) as unknown[];
      if (cs.length === 2 && cs[1][0] === "HLEN" && cs[1][1] === f.key) return [replies[0], reply];
      return replies;
    }) as typeof redis.pipeline;
    const answer = await f.join("dana@example.test").catch((error: Error) => error.name);
    redis.pipeline = pipe;
    is("the sign-up fails", answer, "error");
    is("no place is written", await f.placed("dana@example.test"), 0);
    is("no room is taken", (await f.used()) - before, 0);
    is("nothing is sent", sent.length, 0);
  }

  for (const [label, reply] of [
    ["a word", "soon"],
    ["a missing reply", undefined],
    ["a list", ["1"]],
    ["a number string with a fraction", "1.5"],
  ] as const) {
    part(`A deletion mark answered as ${label} is unknown, never "not deleted"`);
    const f = await fixture();
    const before = await f.used();
    redis.pipeline = (async (cs: (string | number)[][]) => {
      const replies = (await pipe(cs)) as unknown[];
      // The mark is read against Redis's clock in one script since Claude 1 cloud's LEVE on #2576 (ERASED_WITHIN):
      // the same unknown answers are given to that script's reply.
      if (cs.length === 1 && cs[0][0] === "EVAL" && String(cs[0][1]).startsWith("-- marktmorgen:erased-within:v1\n")) return [reply];
      return replies;
    }) as typeof redis.pipeline;
    const answer = await f.join("dana@example.test").catch((error: Error) => error.name);
    redis.pipeline = pipe;
    is("the sign-up fails", answer, "error");
    is("the place with the address is taken back", await f.placed("dana@example.test"), 0);
    is("its room is given back", (await f.used()) - before, 0);
    is("nothing is sent", sent.length, 0);
  }

  part("A deletion mark kept in another shape than whole seconds is unknown, never \"not deleted\"");
  const bad = await fixture();
  const badBefore = await bad.used();
  await pipe([["HSET", suppressedKey(bad.listId), suppressionPrint(bad.listId, "dana@example.test"), "soon"]]);
  is("the sign-up fails", await bad.join("dana@example.test"), "error");
  is("the place with the address is taken back", await bad.placed("dana@example.test"), 0);
  is("its room is given back", (await bad.used()) - badBefore, 0);
  is("nothing is sent", sent.length, 0);

  part("An old deletion mark (a whole number of seconds, long ago) lets the sign-up go on");
  const old = await fixture();
  // A real mark, at the second 1000 of Redis's clock: the script reads it against TIME.
  await pipe([["HSET", suppressedKey(old.listId), suppressionPrint(old.listId, "dana@example.test"), "1000"]]);
  const oldAnswer = await old.join("dana@example.test");
  is("signed up", oldAnswer, "sent");
  is("its place is there", await old.placed("dana@example.test"), 1);

  is("no outside request", outside, 0);
  done();
}
void main();
