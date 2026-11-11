/**
 * Settling a PayPal payout batch writes "paid" in the affiliate book once per
 * PayPal item, and a line leaves the batch only when that is known (rule 24).
 *
 *   - the item's mark (SET NX) answered in another shape (cut short, a number,
 *     an object) is not "fresh": the mark is read back, and a payout already
 *     written for the item is never written a second time;
 *   - the payout's own write failing after the mark was taken does not drop
 *     the line: on the next run the line is still on its way, so the affiliate
 *     is never paid again by PayPal while the book still says "owed";
 *   - a payout that did land although its write answered badly is found in the
 *     book by its reference ("PayPal <item>") and is not written twice.
 *
 * Synthetic only: a stand-in for PayPal and the in-memory Redis.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsmark01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/services/invoicing https://uri.paypal.com/payments/payouts openid";
const ITEM_PREFIX = "nl:pp:item:";
const PAYOUTS = `nl:aff:${STATS}:payouts`;
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push(body);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const sent = created[Number(batch.slice(5, -3)) - 1].items as { sender_item_id: string; amount: unknown; receiver: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: sent.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id, amount: item.amount, receiver: item.receiver },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const shop = (): Store =>
  ({
    sid: "sidmark01",
    handle: "markshop",
    name: "Mark Shop",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestMarkShop01",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  }) as unknown as Store;

/** Sara (owed $30) and Tom (owed $15), both sent to PayPal in one batch, PayPal reporting nothing yet. */
async function sent(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) =>
    JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("not connected");
  const paid = await payWithPayPal(store);
  if (!paid.ok || paid.people !== 2) throw new Error(`not sent: ${JSON.stringify(paid)}`);
}

const book = async (store: Store) =>
  Object.fromEntries((await readBook(store)).rows.map((r) => [r.affiliate.email, [r.paid, r.payable]] as const).sort((a, b) => a[0].localeCompare(b[0])));
const payoutCount = async () => {
  const [all] = await redis.pipeline([["HLEN", PAYOUTS]]);
  return all;
};
const settled = async (store: Store) => settlePayPal(store).then((s) => s, (error: unknown) => (error instanceof Error ? `threw` : String(error)));

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
/** Answers the batches `pick` chooses with `answer` (run or not first), every other batch as it is. */
function answering(pick: (batch: Batch) => boolean, answer: (batch: Batch, run: () => Promise<unknown[]>) => Promise<unknown[]>): void {
  redis.pipeline = (async (batch: Batch) => (pick(batch) ? answer(batch, () => pipeline(batch)) : pipeline(batch))) as typeof redis.pipeline;
}
const itemMark = (batch: Batch) => batch.length === 1 && batch[0][0] === "SET" && String(batch[0][1]).startsWith(ITEM_PREFIX);
const payoutWrite = (batch: Batch) => batch.some((c) => c[0] === "HSET" && c[1] === PAYOUTS);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_settle_mark_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const store = shop();

  part("Healthy: written once, as before");
  await sent(store);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  is("Sara paid, Tom still on his way", await settlePayPal(store), { paid: 1, released: 0, waiting: 1 });
  is("the book says paid once", await book(store), { "sara@example.com": [3000, 0], "tom@example.com": [0, 1500] });
  is("asked again, nothing is written twice", [(await settlePayPal(store)).paid, await payoutCount()], [0, 1]);

  // The item was already written by an earlier run, whose own end (keeping the batch without Sara) never landed:
  // the line is still in the open batch and the item's mark is held. A mark answered in another shape is not "fresh".
  for (const [label, reply] of [
    ["cut short", [] as unknown[]],
    ["a number", [7]],
    ["wrapped in an object", [{ result: "OK" }]],
  ] as [string, unknown[]][]) {
    part(`The item's mark answered ${label}, with the payout already written`);
    await sent(store);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
    await settlePayPal(store);
    const [open] = await pipeline([["HGETALL", `nl:pp:open:${STATS}`]]);
    const before = await payoutCount();
    // Put Sara's line back, as if the run that wrote her payout stopped before it kept the batch without her.
    const batch = String((open as string[])[0]);
    const kept = JSON.parse(String((open as string[])[1])) as { at: number; currency: string; lines: { a: string; c: number }[] };
    await pipeline([["HSET", `nl:pp:open:${STATS}`, batch, JSON.stringify({ ...kept, lines: [{ a: "aaaaaaaaaaaa", c: 3000 }, ...kept.lines] })]]);
    answering(itemMark, async () => reply);
    const result = await settled(store);
    redis.pipeline = pipeline;
    is("no second payout is written for the same PayPal item", [await payoutCount(), (await book(store))["sara@example.com"]], [before, [3000, 0]]);
    is("the run did not count Sara as paid again", typeof result === "string" ? result : result.paid, typeof result === "string" ? "threw" : 0);
  }

  part("The payout's own write fails after the item's mark was taken");
  await sent(store);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  // Nothing written: the HSET never reaches Redis and the answer is cut short.
  answering(payoutWrite, async () => []);
  is("the run stops on the unknown write", await settled(store), "threw");
  redis.pipeline = pipeline;
  is("(nothing was written)", await payoutCount(), 0);
  const next = await settled(store);
  is("the next run writes Sara's payout once", [typeof next === "string" ? next : next.paid, await payoutCount()], [1, 1]);
  is("the book says paid once", await book(store), { "sara@example.com": [3000, 0], "tom@example.com": [0, 1500] });
  const sentBefore = created.length;
  const again = await payWithPayPal(store);
  is("PayPal is never asked to pay Sara again", [again.ok ? "sent" : again.reason, created.length - sentBefore], ["nothing", 0]);

  part("The payout's write lands but answers badly");
  await sent(store);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
  answering(payoutWrite, async (_batch, run) => {
    await run();
    return [];
  });
  is("the run stops on the unknown write", await settled(store), "threw");
  redis.pipeline = pipeline;
  is("(it was written once)", await payoutCount(), 1);
  const later = await settled(store);
  is("the next run finds it by its reference and writes nothing", [typeof later === "string" ? later : later.paid, await payoutCount()], [0, 1]);
  is("the book says paid once", await book(store), { "sara@example.com": [3000, 0], "tom@example.com": [0, 1500] });
  is("Sara is no longer on her way, Tom still is", [...(await onTheirWay(store))], ["bbbbbbbbbbbb"]);
  const sentAfter = created.length;
  const none = await payWithPayPal(store);
  is("PayPal is never asked to pay Sara again", [none.ok ? "sent" : none.reason, created.length - sentAfter], ["nothing", 0]);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
