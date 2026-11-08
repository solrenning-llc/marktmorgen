/**
 * Codex J's residual M3 on #2844 (head 2921d3bc): a payout in the book whose
 * reference is missing, or not text, was read as reference "" (parsePayout's
 * fallback for showing it). bookedPayouts then lost the "PayPal <item>" that
 * proves a payout booked before ids were derived from the item, so
 * bookPayPalPayout took the item as never booked: settlePayPal booked it a
 * second time (6000 cents in two entries for one 3000-cent payment) and took
 * it off its way.
 *
 * A reference the book cannot read is not proof of anything, so settling
 * refuses (UnknownReplyError) before any booking: the book keeps one entry of
 * 3000, the item stays on its way, nothing is owed again and no second PayPal
 * batch goes out. That holds whether only the HGETALL answer is changed (as in
 * Codex J's repro) or the stored entry itself lacks it, and on the item's own
 * derived id too.
 *
 * Controls: a whole legacy entry is found by its reference (paid 0, one entry);
 * a payout the creator wrote down with an empty reference ("" is what
 * addPayout writes when the field is left blank, never what a PayPal booking
 * writes) is a real, readable payout and does not stop the item being booked
 * once; an empty book books it once.
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { addPayout, paypalPayoutId, readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsrefunk01";
const AFF = "aaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbb";
const ITEM = "ITEMBATCH1ABC0";
const LEDGER = `nl:aff:${STATS}:payouts`;
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
  sid: "sidrefunk01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
  statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
  affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
} as unknown as Store;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
let answer: ((commands: Commands) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Commands) => answer?.(commands) ?? real(commands)) as typeof redis.pipeline;

/** One batch sent to Sara for her 3000 cents, and PayPal now says the item was paid. */
async function sentAndPaid(): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  answer = null;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  await real([
    ["HSET", `nl:aff:${STATS}:people`, AFF, person(AFF, "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, OTHER, person(OTHER, "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: AFF, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
  itemStatus = { [AFF]: "SUCCESS" };
}

async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
const row = async () => (await readBook(store)).rows.find((r) => r.affiliate.id === AFF);
const entries = () => redis.run(["HLEN", LEDGER]);
const isAll = (c: Commands) => c.length === 1 && c[0][0] === "HGETALL" && c[0][1] === LEDGER;

/** What is written under the reference: a number, nothing, null, a list, an object, true. */
const BROKEN: [string, (row: Record<string, unknown>) => void][] = [
  ["a number", (r) => { r.reference = 42; }],
  ["missing", (r) => { delete r.reference; }],
  ["null", (r) => { r.reference = null; }],
  ["a list", (r) => { r.reference = [`PayPal ${ITEM}`]; }],
  ["an object", (r) => { r.reference = { text: `PayPal ${ITEM}` }; }],
  ["true", (r) => { r.reference = true; }],
];

/** The settle refused: one entry of 3000 in the book, still on its way, nothing owed, no second batch. */
async function keptOnce(what: string): Promise<void> {
  is(`${what}: the book holds one entry`, entries(), 1);
  is(`${what}: 3000 counted as paid, once`, (await row())?.paid, 3000);
  is(`${what}: still on its way`, [...(await onTheirWay(store))], [AFF]);
  is(`${what}: nothing owed again`, (await row())?.payable, 0);
  const again = await payWithPayPal(store);
  is(`${what}: no second PayPal batch`, [again.ok ? "sent" : again.reason, created.length], ["nothing", 1]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_refunk_only";
  console.error = () => {};

  for (const [kind, spoil] of BROKEN) {
    part(`A legacy payout's reference read back as ${kind} (HGETALL answer only): settling refuses`);
    await sentAndPaid();
    await addPayout(store, { aff: AFF, cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
    let reached = 0;
    answer = (c) => {
      if (!isAll(c)) return null;
      return real(c).then((reply) => {
        const flat = reply[0] as string[];
        if (flat.length !== 2) return reply;
        reached += 1;
        const written = JSON.parse(flat[1]) as Record<string, unknown>;
        spoil(written);
        return [[flat[0], JSON.stringify(written)]];
      });
    };
    const refused = await rejects(() => settlePayPal(store));
    answer = null;
    is(`${kind}: the changed answer was read`, reached, 1);
    is(`${kind}: settling refuses`, refused, true);
    await keptOnce(kind);
  }

  for (const [kind, spoil] of BROKEN.slice(0, 2)) {
    part(`A legacy payout stored with its reference ${kind}: settling refuses`);
    await sentAndPaid();
    const payout = await addPayout(store, { aff: AFF, cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
    if (!payout) throw new Error("legacy payout not written");
    const written = { ...payout } as unknown as Record<string, unknown>;
    spoil(written);
    await real([["HSET", LEDGER, payout.id, JSON.stringify(written)]]);
    is(`${kind}: settling refuses`, await rejects(() => settlePayPal(store)), true);
    await keptOnce(`stored ${kind}`);
  }

  part("The item's own derived id holding a payout with no reference: settling refuses");
  await sentAndPaid();
  const id = paypalPayoutId(ITEM);
  await real([["HSET", LEDGER, id, JSON.stringify({ id, aff: AFF, cents: 3000, currency: "usd", date: "2026-11-01", at: 1 })]]);
  is("derived id, no reference: settling refuses", await rejects(() => settlePayPal(store)), true);
  await keptOnce("derived id, no reference");

  part("Control: a whole legacy payout is found by its reference and not booked again");
  await sentAndPaid();
  await addPayout(store, { aff: AFF, cents: 3000, currency: "usd", date: "2026-11-01", reference: `PayPal ${ITEM}` });
  is("not booked here", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("one entry", entries(), 1);
  is("3000 once", (await row())?.paid, 3000);
  is("off its way", [...(await onTheirWay(store))], []);

  part("Control: a payout written down with an empty reference does not stop the paid item being booked once");
  await sentAndPaid();
  const manual = await addPayout(store, { aff: OTHER, cents: 1200, currency: "usd", date: "2026-10-01", reference: "   " });
  is("the creator's blank reference is written as \"\"", manual?.reference, "");
  is("booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  is("two entries: the manual one and the item", entries(), 2);
  is("3000 once for Sara", (await row())?.paid, 3000);
  is("the next settle books nothing again", await settlePayPal(store), { paid: 0, released: 0, waiting: 0 });
  is("still two entries", entries(), 2);

  part("Control: an empty book books the paid item once");
  await sentAndPaid();
  is("booked by this settle", await settlePayPal(store), { paid: 1, released: 0, waiting: 0 });
  is("one entry", entries(), 1);
  is("3000 once", (await row())?.paid, 3000);
  is("off its way", [...(await onTheirWay(store))], []);

  done();
}

void main();
