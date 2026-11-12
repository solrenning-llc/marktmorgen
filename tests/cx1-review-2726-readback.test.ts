import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, addProduct, setProductLink, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, startGift } from "@/lib/gifts";
import { handOverPreorder } from "@/lib/preorders";
import { importedKey } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

const pipeline = redis.pipeline.bind(redis);
globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;

async function result(run: () => Promise<unknown>): Promise<string> {
  try { return String(await run()); } catch { return "unconfirmed"; }
}

async function main() {
  redis.clear();
  const owner = "owner@cx1.example.test";
  await claimHandle(owner, "cx1gifts", "Synthetic gift shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestMarks0001", true);
  await setSubscription(owner, { customerId: "cus_Marks00001", subscriptionId: "sub_Marks00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic course", "", "25", null);
  if (!made.ok) throw new Error("Fixture product missing");
  await setProductLink(owner, made.product.id, "https://example.test/course");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = { base: "https://example.test/@cx1gifts", from: "hello@example.test", recordStart: async () => {}, ordersLink: async () => null };
  const granted = async (to: string) => typeof (await pipeline([["HGET", importedKey(store.statsId!, to), product.id]]))[0] === "string";
  const vectors: [string, (row: object) => unknown[]][] = [
    ["extra result", row => [JSON.stringify({ ...row, given: 1900000000 }), null]],
    ["boolean given", row => [JSON.stringify({ ...row, given: true })]],
    ["string given", row => [JSON.stringify({ ...row, given: "1900000000" })]],
    ["valid not-given control", row => [JSON.stringify(row)]],
    ["unreadable slot control", () => [[]]],
  ];
  let index = 0;
  for (const [name, reply] of vectors) {
    index++;
    const to = `gift${index}@cx1.example.test`;
    const madeGift = await startGift(store, product, { to, from: "Synthetic", message: "" });
    if (!madeGift.ok) throw new Error("Fixture gift missing");
    const gift = madeGift.gift;
    const giftKey = `nl:gift:${gift.id}`;
    const mark = `${giftKey}:giving`;
    await pipeline([["SET", mark, "another-run", "EX", 300]]);
    let reads = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === giftKey && ++reads === 2) return reply(gift);
      return pipeline(commands);
    };
    const outcome = await result(() => deliverGift({ store, product, ...deps, session: { id: `cs_test_cx1gift${String(index).padStart(8,"0")}`, created: 1900000000, metadata: { store: "cx1gifts", product: product.id, gift: gift.id } } }));
    redis.pipeline = pipeline;
    is(`gift ${name}: an unknown reread cannot confirm paid delivery`, [outcome, await granted(to), (await pipeline([["GET", mark]]))[0]], ["unconfirmed", false, "another-run"]);
  }
  index = 0;
  for (const [name, reply] of vectors) {
    index++;
    const to = `pre${index}@cx1.example.test`;
    const session = `cs_test_cx1pre${String(index).padStart(8,"0")}`;
    const row = { to, at: 1900000000, pi: `pi_cx1pre${String(index).padStart(8,"0")}` };
    const key = `nl:pre:${store.statsId}:${product.id}`;
    const mark = `nl:pre:give:${session}`;
    await pipeline([["HSET", key, session, JSON.stringify(row)], ["SET", mark, "another-run", "EX", 300]]);
    redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === key && commands[0][2] === session ? reply(row) : pipeline(commands);
    const outcome = await result(() => handOverPreorder(store, product as Listing, session, deps));
    redis.pipeline = pipeline;
    is(`preorder ${name}: an unknown reread cannot confirm paid delivery`, [outcome, await granted(to), (await pipeline([["GET", mark]]))[0]], ["unconfirmed", false, "another-run"]);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
