/**
 * Three readings of a license key's records that took "not known" for a known answer (#5285 rows 1-3 of
 * 7160521419, pre-existing, found by the money audit of #5318):
 *
 *   1. the public check of a key (checkKey) answered "unknown", which says "never given", when the key's record
 *      was there but did not read; a buyer who paid would be told the key does not exist. It now throws, and the
 *      check answers "could not check right now" (app/api/store/licence/route.ts). No record at all is still
 *      "never given";
 *   2. an upload's serving of waiting buyers (serveWaiting) read a reply of the waiting list in another shape as
 *      "nobody waiting": the keys stayed in the pool for the next new buyer, and the buyer who had paid was not
 *      told apart. It now says the list could not be read (waitingUnknown), and gives nobody a key from it;
 *   3. a waiting buyer whose record did not read was given a key on an empty address: no email, and no line on
 *      their orders page, which finds keys by the address. They now keep their place and are counted (unread), so
 *      the creator is told.
 *
 * Synthetic store; replies injected per case; no network.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { readListing } from "@/lib/catalog";
import { addKeys, checkKey, keyForSale } from "@/lib/licence-keys";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** A reply put in place of the waiting list's HGETALL, or undefined for the real one. */
let waitingReply: unknown = undefined;
redis.pipeline = (async (batch: Command[]) => {
  const replies = await real(batch);
  if (waitingReply === undefined) return replies;
  return replies.map((reply, i) => (batch[i][0] === "HGETALL" && String(batch[i][1]).endsWith(":waiting") ? waitingReply : reply));
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_stand_in" }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_licence_unreadable_stand_in";
  process.env.RESEND_API_KEY = "re_test_licence_unreadable_stand_in";
  redis.clear();
  const owner = "licence-unreadable@example.test";
  await claimHandle(owner, "licenceunread", "Licence Unread", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_LicUnread001", subscriptionId: "sub_LicUnread001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1LicUnread0001", true);
  const made = async (title: string) => {
    const app = await addProduct(owner, title, "A synthetic app.", "40", null);
    if (!app.ok) throw new Error("key product fixture");
    await setProductLink(owner, app.product.id, `https://example.test/${app.product.id}`);
    const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" });
    if (!keyed.ok) throw new Error("keys fixture");
    const store = (await storeForEmail(owner))!;
    return { store, product: (await readListing(store, app.product.id))! };
  };

  part("1. The public check of a key whose record does not read is not 'never given'");
  {
    const { store, product } = await made("Checked app");
    await real([["RPUSH", `nl:keys:${store.statsId}:${product.id}:pool`, "CHECK-AAAA-BBBB-CCCC"]]);
    const sale = await keyForSale(store, product, `cs_test_check${"a".repeat(20)}`, "buyer@example.test");
    is("the key is given", sale?.state, "issued");
    is("a record that reads: valid", await checkKey(store, product, "CHECK-AAAA-BBBB-CCCC"), "valid");
    is("no record at all: never given, as before", await checkKey(store, product, "CHECK-ZZZZ-ZZZZ-ZZZZ"), "unknown");
    await real([["HSET", `nl:keys:${store.statsId}:${product.id}:info`, "CHECK-AAAA-BBBB-CCCC", "{not json"]]);
    const read = await checkKey(store, product, "CHECK-AAAA-BBBB-CCCC").then((status) => status, () => "threw");
    is("a record that does not read: throws (the route says it could not check), never 'unknown'", read, "threw");
  }

  part("2. A waiting list read in another shape is not 'nobody waiting'");
  {
    const { store, product } = await made("Waited app");
    const sale = await keyForSale(store, product, `cs_test_wait1${"b".repeat(20)}`, "waiting@example.test");
    is("a paid buyer waits on an empty pool", sale?.state, "waiting");
    waitingReply = "OK";
    const up = await addKeys(store, product, ["WAIT-1111-2222-3333"]);
    waitingReply = undefined;
    is("the upload says the waiting list could not be read", up.waitingUnknown, true);
    is("and serves nobody from it", up.served, 0);
    waitingReply = ["cs_test_wait1" + "b".repeat(20)];
    const odd = await addKeys(store, product, ["WAIT-4444-5555-6666"]);
    waitingReply = undefined;
    is("a list of an odd length is not read either", [odd.waitingUnknown, odd.served], [true, 0]);
    const plain = await addKeys(store, product, ["WAIT-7777-8888-9999"]);
    is("a list that reads: the buyer is served, and nothing is unknown", [plain.served, plain.waitingUnknown, plain.unread], [1, false, 0]);
  }

  part("3. A waiting buyer whose record does not read keeps their place, and is counted");
  {
    const { store, product } = await made("Queued app");
    const first = `cs_test_queue1${"c".repeat(20)}`;
    const second = `cs_test_queue2${"d".repeat(20)}`;
    is("two paid buyers wait", [(await keyForSale(store, product, first, "first@example.test"))?.state, (await keyForSale(store, product, second, "second@example.test"))?.state], ["waiting", "waiting"]);
    const waiting = `nl:keys:${store.statsId}:${product.id}:waiting`;
    await real([["HSET", waiting, first, "{not json"]]);
    const up = await addKeys(store, product, ["QUEUE-1111-2222-3333", "QUEUE-4444-5555-6666"]);
    is("the readable buyer is served", [up.served, (await keyForSale(store, product, second, "second@example.test"))?.state], [1, "issued"]);
    is("the unreadable one is counted, not given a key on an empty address", up.unread, 1);
    const [still] = await real([["HEXISTS", waiting, first]]);
    is("and keeps their place in the line", still, 1);
    is("their key is still in the pool, for them", up.left, 1);
    await real([["HSET", waiting, first, JSON.stringify({ e: 7, at: 1 })]]);
    const again = await addKeys(store, product, ["QUEUE-7777-8888-9999"]);
    is("a record whose address is not text is not read either", [again.unread, again.served], [1, 0]);
    await real([["HSET", waiting, first, JSON.stringify({ e: "first@example.test", at: 1 })]]);
    const fixed = await addKeys(store, product, ["QUEUE-AAAA-BBBB-CCCC"]);
    is("once it reads, they are served", [fixed.served, fixed.unread], [1, 0]);
  }

  delete process.env.RESEND_API_KEY;
  done();
}

void main();
