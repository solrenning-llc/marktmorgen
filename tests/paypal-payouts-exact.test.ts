/**
 * Redis answers the PayPal payouts read in an unknown shape (rule 24): never
 * read as "this call wrote it", "not connected" or "store gone".
 *
 *   - settling: a SET NX on a paid item that answers anything but "OK" or
 *     null books nothing, so the affiliate book is never counted twice, and
 *     the item stays on its way for the next run;
 *   - the daily job: a store whose record could not be read stays in the
 *     settle set (only a confirmed absent store leaves it);
 *   - the creator's PayPal link: an unknown answer is not "not connected"
 *     and not "auto-pay off".
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, onTheirWay, payWithPayPal, paysAutomatically, readPayPal, setAutoPay, settleAllPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsexact01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING" } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const items = created[Number(batch.slice(5, -3)) - 1].items as { sender_item_id: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: items.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidexact01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Answers `reply` (after running the commands, when `run`) for a pipeline `match` picks; the rest reach the stub. */
async function intercepted<T>(match: (commands: Commands) => boolean, reply: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => (match(commands) ? reply(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
const paidTo = async (store: Store) => (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa")?.paid ?? -1;
const itemSet = (commands: Commands) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:pp:item:");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_exact_only";
  console.error = () => {};
  const store = shop();

  // ---- 2. SET NX on a paid item ----
  const malformedNx: [string, () => unknown[]][] = [
    ["no reply at all", () => []],
    ["undefined", () => [undefined]],
    ["a number", () => [1]],
    ["an empty string", () => [""]],
    ["a list", () => [[]]],
    ["QUEUED", () => ["QUEUED"]],
    ["two replies", () => ["OK", "OK"]],
  ];
  for (const [label, reply] of malformedNx) {
    part(`Another settling already booked the item, and SET NX answers ${label}: never booked twice`);
    await seed(store);
    const paid = await payWithPayPal(store);
    if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
    // The other settling wrote the item first; this call's SET NX truly answers null, but garbled.
    await real([["SET", "nl:pp:item:ITEMBATCH1ABC0", "BATCH1ABC"]]);
    const failed = await intercepted(itemSet, async (c) => { await real(c); return reply(); }, () => rejects(() => settlePayPal(store)));
    is("settling does not say it settled", failed, true);
    is("the book is not written by this call", await paidTo(store), 0);

    part(`The item is new, and SET NX answers ${label}: nothing booked, still on its way`);
    await seed(store);
    const again = await payWithPayPal(store);
    if (!again.ok) throw new Error(`not sent: ${again.reason}`);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
    const failedNew = await intercepted(itemSet, async () => reply(), () => rejects(() => settlePayPal(store)));
    is("settling does not say it settled", failedNew, true);
    is("nothing booked", await paidTo(store), 0);
    is("still on its way, for the next run", [...(await onTheirWay(store))], ["aaaaaaaaaaaa"]);
    is("the next healthy run books it once", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
    is("paid once", await paidTo(store), 3000);
    is("asked again, never twice", [(await settlePayPal(store)).paid, await paidTo(store)], [0, 3000]);
  }

  part("Control: SET NX answering exactly null (another settling wrote it) books nothing and settles");
  await seed(store);
  await payWithPayPal(store);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  await real([["SET", "nl:pp:item:ITEMBATCH1ABC0", "BATCH1ABC"]]);
  is("not booked here, nothing left on its way", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("this call wrote nothing into the book", await paidTo(store), 0);

  // ---- 1. The daily job ----
  const SID = "0123456789abcdef0123456789abcdef";
  part("The daily job: a store whose record read throws stays in the settle set");
  redis.clear();
  await real([["SADD", "nl:pp:stores", SID]]);
  const sent: Commands = [];
  const storeRead = (c: Commands) => { sent.push(...c); return c[0]?.[0] === "GET" && c[0][1] === `nl:store:id:${SID}`; };
  const thrown = await intercepted(storeRead, async () => { throw new Error("Synthetic: Redis timed out"); }, () => settleAllPayPal(Date.now() + 60_000).then(() => false, () => true));
  is("the job itself goes on", thrown, false);
  is("no SREM was sent", sent.filter((c) => c[0] === "SREM").length, 0);
  is("the store is still in the set", await real([["SMEMBERS", "nl:pp:stores"]]), [[SID]]);

  part("Control: a store confirmed absent leaves the settle set");
  is("settled none", await settleAllPayPal(Date.now() + 60_000), 0);
  is("and it is gone from the set", await real([["SMEMBERS", "nl:pp:stores"]]), [[]]);

  // ---- 3. The creator's PayPal link ----
  const linkRead = (c: Commands) => c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:pp:${STATS}`;
  const malformedLink: [string, unknown[]][] = [
    ["no reply at all", []],
    ["undefined", [undefined]],
    ["a number", [42]],
    ["an object", [{}]],
    ["two replies", [null, null]],
    ["unreadable JSON", ["{"]],
    ["JSON without its Secret", [JSON.stringify({ client: CLIENT, at: 1, auto: true })]],
  ];
  for (const [label, reply] of malformedLink) {
    part(`The PayPal link answers ${label}: not "not connected", not "auto-pay off"`);
    await seed(store);
    await setAutoPay(store, true);
    const answer = async () => [...reply];
    is("the studio view rejects", await intercepted(linkRead, answer, () => rejects(() => readPayPal(store))), true);
    is("payday's auto-pay question rejects", await intercepted(linkRead, answer, () => rejects(() => paysAutomatically(store))), true);
    const pressed = await intercepted(linkRead, answer, () => payWithPayPal(store).then((r) => (r.ok ? "sent" : r.reason), () => "rejected"));
    is("a press is never told 'not connected'", pressed, "rejected");
    is("turning auto-pay off is not refused as 'not connected'", await intercepted(linkRead, answer, () => setAutoPay(store, false).then(String, () => "rejected")), "rejected");
    is("nothing sent", created.length, 0);
  }

  part("Controls: a healthy link and a confirmed absent one");
  await seed(store);
  await setAutoPay(store, true);
  is("healthy: the studio view", [(await readPayPal(store))?.client, await paysAutomatically(store)], ["AbCdEf…6789", true]);
  await real([["DEL", `nl:pp:${STATS}`]]);
  is("absent: not connected, auto-pay off", [await readPayPal(store), await paysAutomatically(store)], [null, false]);
  const press = await payWithPayPal(store);
  is("absent: a press says connect first", press.ok ? "sent" : press.reason, "not-connected");

  done();
}

void main();
