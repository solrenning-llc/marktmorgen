/**
 * Codex G's MEDIUM on #3143 (review 5815803865): listLetters (lib/letters.ts)
 * read an unknown reply as "no emails", so the store's published-emails page
 * said "No emails published yet" while one was published (rule 24, CX-123).
 * An answer of another shape, a cut envelope or a read that throws is now
 * unknown (null), never an empty list; only Redis's own empty list is "none".
 * A record that is simply gone (nil) is still skipped, as before.
 *
 * Synthetic store, in-memory Redis (tests/redis-stub.ts).
 */
import type { Broadcast } from "@/lib/broadcasts";
import { listLetters, publishLetter } from "@/lib/letters";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const realPipeline = redis.pipeline.bind(redis);
type Answer = (commands: (string | number)[][], real: unknown[]) => unknown;
let shape: Answer | null = null;
(redis as unknown as { pipeline: typeof realPipeline }).pipeline = async (commands) => {
  const real = await realPipeline(commands);
  return (shape ? shape(commands, real) : real) as Awaited<ReturnType<typeof realPipeline>>;
};

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Mara's Kitchen", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

function sentBroadcast(store: Store): Broadcast {
  const id = "a1".padStart(24, "0");
  const b = { id, listId: store.listId!, handle: store.handle, subject: "October notes", body: "The new workbook is out.", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1_760_000_000, sendAt: 1_760_000_100, finishedAt: 1_760_000_200, total: 1, sent: 1, note: "", failures: 0, listed: true, tagged: true, test: null } as unknown as Broadcast;
  redis.run(["SET", `nl:mail:bc:${id}`, JSON.stringify(b)]);
  return b;
}

async function main(): Promise<void> {
  redis.clear();
  const empty = await paidStore("empty@example.com", "emptykitchen");
  const store = await paidStore("letters@example.com", "marakitchen");
  const published = await publishLetter(store, sentBroadcast(store), Date.now());
  if (!published.ok) throw new Error(published.message);

  part("Control: what is there, and a store with none");
  is("the published email is listed", (await listLetters(store))?.length, 1);
  is("a store with none published: an empty list", await listLetters(empty), []);

  part("An unknown answer is not \"no emails\"");
  const isRange = (c: (string | number)[][]) => c[0]?.[0] === "ZREVRANGE";
  const isGet = (c: (string | number)[][]) => c[0]?.[0] === "MGET";
  const cases: [string, Answer][] = [
    ["the list's envelope cut short", (c, real) => (isRange(c) ? [] : real)],
    ["the list answered as nil, not a list", (c, real) => (isRange(c) ? [null] : real)],
    ["the list of another shape", (c, real) => (isRange(c) ? [42] : real)],
    // Codex G's MEDIUM on 7959db9e3: an id this code never writes was dropped,
    // so a list of only such ids read as "no emails".
    ["the list holding only an id this code never writes", (c, real) => (isRange(c) ? [["not-an-id"]] : real)],
    ["the list holding an empty id", (c, real) => (isRange(c) ? [[""]] : real)],
    ["the list holding \"__proto__\"", (c, real) => (isRange(c) ? [["__proto__"]] : real)],
    ["the list holding a written id and one this code never writes", (c, real) => (isRange(c) ? [[...(real[0] as string[]), "not-an-id"]] : real)],
    ["the records' envelope cut short", (c, real) => (isGet(c) ? [] : real)],
    ["the records answered as nil, not a list", (c, real) => (isGet(c) ? [null] : real)],
    ["fewer records than ids", (c, real) => (isGet(c) ? [[]] : real)],
    ["a record of another shape", (c, real) => (isGet(c) ? [[7]] : real)],
    ["a record that is not JSON", (c, real) => (isGet(c) ? [["{"]] : real)],
  ];
  for (const [name, answer] of cases) {
    shape = answer;
    is(`${name}: unknown (null), never []`, await listLetters(store), null);
  }
  shape = () => {
    throw new Error("Redis request timed out (test)");
  };
  is("a read that throws: unknown (null), never []", await listLetters(store), null);
  shape = null;
  is("and read whole again once Redis answers", (await listLetters(store))?.length, 1);

  part("A record that is gone (nil) is skipped, as before");
  shape = (c, real) => (isGet(c) ? [[null]] : real);
  is("the list is read, with nothing in it", await listLetters(store), []);
  shape = null;

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
