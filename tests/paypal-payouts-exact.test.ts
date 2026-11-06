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
import { addPayout, readBook } from "@/lib/affiliates";
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

  // ---- 2. Booking a paid item: once, whatever is lost on the way (rule 24; Revisor 1's GRAVE on 7bd48a58) ----
  const owedTo = async () => (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa")?.payable ?? -1;
  const payoutsWrite = (c: Commands) => c.some((cmd) => (cmd[0] === "HSET" || cmd[0] === "HSETNX") && cmd[1] === `nl:aff:${STATS}:payouts`);
  const sentOnce = async (): Promise<void> => {
    is("the next settle leaves nothing on its way", (await settlePayPal(store)).waiting, 0);
    is("booked exactly once", await paidTo(store), 3000);
    is("nothing owed again", await owedTo(), 0);
    const again = await payWithPayPal(store);
    is("and no second PayPal batch is sent", [again.ok ? "sent" : again.reason, created.length], ["nothing", 1]);
  };
  const sentAndPaid = async (): Promise<void> => {
    await seed(store);
    const paid = await payWithPayPal(store);
    if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  };

  part("Revisor 1, repro 1: the item's mark is written and its answer is lost");
  await sentAndPaid();
  is("that settle is not said as done", await intercepted(itemSet, async (c) => { await real(c); return [undefined]; }, () => rejects(() => settlePayPal(store))), true);
  await sentOnce();

  part("Revisor 1, repro 2: the mark would be written, and writing the payout into the book fails (a full data room)");
  await sentAndPaid();
  is("that settle is not said as done", await intercepted(payoutsWrite, async () => { throw new Error("Synthetic DataRoomError: the store's data room is full"); }, () => rejects(() => settlePayPal(store))), true);
  is("nothing is in the book yet", await paidTo(store), 0);
  is("and it is still on its way, never owed", [...(await onTheirWay(store))], ["aaaaaaaaaaaa"]);
  await sentOnce();

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
    part(`Booked before (by its reference, as before ids were derived), and the mark answers ${label}: never booked twice`);
    await sentAndPaid();
    await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: "PayPal ITEMBATCH1ABC0" });
    is("settling does not say it settled", await intercepted(itemSet, async (c) => { await real(c); return reply(); }, () => rejects(() => settlePayPal(store))), true);
    is("the book is not written again", await paidTo(store), 3000);
    await sentOnce();

    part(`The item is new, and the mark answers ${label}: booked once, never twice`);
    await sentAndPaid();
    is("settling does not say it settled", await intercepted(itemSet, async () => reply(), () => rejects(() => settlePayPal(store))), true);
    is("booked once, before the mark", await paidTo(store), 3000);
    await sentOnce();
  }

  part("Control: the mark already there and the payout in the book: nothing booked again");
  await sentAndPaid();
  await addPayout(store, { aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd", date: "2026-11-01", reference: "PayPal ITEMBATCH1ABC0" });
  await real([["SET", "nl:pp:item:ITEMBATCH1ABC0", "BATCH1ABC"]]);
  is("not booked here, nothing left on its way", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("in the book once", await paidTo(store), 3000);

  part("A mark with no payout in the book (left by a failure before this change) is booked, once");
  await sentAndPaid();
  await real([["SET", "nl:pp:item:ITEMBATCH1ABC0", "BATCH1ABC"]]);
  is("booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  await sentOnce();

  part("Control: a healthy settle books it once");
  await sentAndPaid();
  is("booked", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  await sentOnce();

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
