/**
 * Claude 5's LEVE 3 on #2844 (head 91815567): once a paid PayPal item is
 * booked idempotently (HSETNX under an id derived from the item), the old
 * mark nl:pp:item:<item> decides nothing. It is not written any more, so a
 * settle spends no command, no key kept 400 days and no failure point after
 * the booking on it; the registries no longer list it.
 *
 *   - a healthy settle books the item once and sends nothing to nl:pp:item:;
 *   - a settle whose booking HSETNX was applied and its answer lost throws,
 *     and the next settle books nothing again (no mark is needed for that);
 *   - a mark left by an older run never stops a payout not in the book from
 *     being booked, and never books one twice;
 *   - lib/data-families.ts and tests/store-data-registry.ts no longer name it.
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { addPayout, readBook } from "@/lib/affiliates";
import { CLOSING, COUNTED_FAMILIES, ELSEWHERE_FAMILIES } from "@/lib/data-families";
import type { Store } from "@/lib/store";
import { FAMILIES } from "./store-data-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsnomark1";
const AFF = "aaaaaaaaaaaa";
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

const store = {
  sid: "sidnomark01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
  statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
  affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
} as unknown as Store;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const seen: Commands = [];
let answer: ((commands: Commands) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Commands) => {
  seen.push(...commands);
  const replaced = answer?.(commands);
  return replaced ?? real(commands);
}) as typeof redis.pipeline;

async function sentAndPaid(): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await real([
    ["HSET", `nl:aff:${STATS}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: AFF, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
  itemStatus = { [AFF]: "SUCCESS" };
}
const row = async () => (await readBook(store)).rows.find((r) => r.affiliate.id === AFF);
const markCommands = () => seen.filter((c) => c.some((part) => String(part).startsWith("nl:pp:item:")));
const markKept = async () => (await real([["GET", "nl:pp:item:ITEMBATCH1ABC0"]]))[0];
async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
async function nothingMore(): Promise<void> {
  is("the next settle leaves nothing on its way", (await settlePayPal(store)).waiting, 0);
  is("in the book once", (await row())?.paid, 3000);
  is("nothing owed again", (await row())?.payable, 0);
  const again = await payWithPayPal(store);
  is("and no second PayPal batch is sent", [again.ok ? "sent" : again.reason, created.length], ["nothing", 1]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_nomark_only";
  console.error = () => {};

  part("A healthy settle books the paid item once and writes no item mark");
  await sentAndPaid();
  seen.length = 0;
  is("booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  is("no command names nl:pp:item:", markCommands(), []);
  is("no item mark is kept", await markKept(), null);
  seen.length = 0;
  await nothingMore();
  is("and none of the later runs write one either", markCommands(), []);

  part("The booking HSETNX is applied and its answer is lost: never booked twice, with no mark");
  await sentAndPaid();
  answer = (c) => (c.length === 1 && c[0][0] === "HSETNX" && c[0][1] === `nl:aff:${STATS}:payouts` ? real(c).then(() => [undefined]) : null);
  seen.length = 0;
  is("that settle is not said as done", await rejects(() => settlePayPal(store)), true);
  answer = null;
  is("in the book, once", (await row())?.paid, 3000);
  await nothingMore();
  is("no command named nl:pp:item:", markCommands(), []);

  part("A mark left by an older run, with no payout in the book: booked once");
  await sentAndPaid();
  await real([["SET", "nl:pp:item:ITEMBATCH1ABC0", "BATCH1ABC"]]);
  seen.length = 0;
  is("booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  is("the old mark is neither read nor written", markCommands(), []);
  await nothingMore();

  part("Control: booked before by its reference: not booked again");
  await sentAndPaid();
  await addPayout(store, { aff: AFF, cents: 3000, currency: "usd", date: "2026-11-01", reference: "PayPal ITEMBATCH1ABC0" });
  seen.length = 0;
  is("not booked here", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("no command names nl:pp:item:", markCommands(), []);
  await nothingMore();

  part("The registries no longer name the mark");
  is("not in lib/data-families.ts CLOSING", "nl:pp:item:" in CLOSING, false);
  is("not among the families counted or kept elsewhere", [COUNTED_FAMILIES.includes("nl:pp:item:"), ELSEWHERE_FAMILIES.includes("nl:pp:item:")], [false, false]);
  is("not in tests/store-data-registry.ts", Object.keys(FAMILIES).filter((k) => k.startsWith("nl:pp:item:")), []);

  done();
}

void main();
