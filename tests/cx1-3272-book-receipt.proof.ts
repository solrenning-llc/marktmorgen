/**
 * A PayPal payout item is written into the affiliate book once, and a line leaves the open batch only when the book
 * is confirmed to hold it (CX-123 rule 24; Claude 2 on #3272, finding 1).
 *
 * The book write is the once-only record: the payout's id is derived from the PayPal item and written with HSETNX,
 * read exactly. 1 is written, 0 is in the book already; any other answer, an error or a data room that is full keeps
 * the affiliate on their way, so the line is never sent to PayPal again and is read again next time. A mark taken by
 * an earlier run (nl:pp:item:<item>, written before this change) drops a line only when the book holds a payout with
 * that item's reference. One line that cannot be written never stops the others. Synthetic store, synthetic PayPal
 * stand-in; every scenario counts the PayPal batches made, which must stay at one for one commission.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook, removePayout } from "@/lib/affiliates";
import { createHash } from "node:crypto";
// Same stable provider identity in the old and new product graphs, including before this export existed.
const payoutIdForItem = (item: string) => createHash("sha256").update(`paypal-payout-item|${item}`).digest("hex").slice(0, 12);
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsclaim1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let itemStatus: Record<string, string> = {};
const created: { body: Record<string, unknown> }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AAtoken") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push({ body });
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const sent = created[Number(batch.slice(5, -3)) - 1].body.items as { sender_item_id: string; amount: unknown; receiver: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: sent.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        payout_batch_id: batch,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id, amount: item.amount, receiver: item.receiver },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidclaim0001",
    handle: "claimharbor",
    name: "Claim Harbor",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestClaim00001",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const pipeline = redis.pipeline.bind(redis);
const ITEM = "nl:pp:item:ITEMBATCH1ABC0";
const PAYOUTS = `nl:aff:${STATS}:payouts`;
const SARA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";

/** Affiliates owed $30 each (Sara, and Ben when `two`), sent in one batch, reported SUCCESS by PayPal. */
async function seed(store: Store, two = false): Promise<void> {
  redis.pipeline = pipeline;
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false });
  await pipeline([
    ["HSET", `nl:aff:${STATS}:people`, SARA, person(SARA, "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", SARA)],
  ]);
  if (two) {
    await pipeline([
      ["HSET", `nl:aff:${STATS}:people`, BEN, person(BEN, "ben@example.com", "ben")],
      ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", BEN)],
    ]);
  }
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
  const sent = await payWithPayPal(store);
  if (!sent.ok) throw new Error(`not sent: ${sent.reason}`);
  itemStatus = two ? { [SARA]: "SUCCESS", [BEN]: "SUCCESS" } : { [SARA]: "SUCCESS" };
}

const paidOf = async (store: Store, email: string) => (await readBook(store)).rows.find((r) => r.affiliate.email === email)?.paid ?? -1;
const paidCents = (store: Store) => paidOf(store, "sara@example.com");
/** The payouts written in the book, by id. */
const bookIds = async () => {
  const flat = (await pipeline([["HGETALL", PAYOUTS]]))[0] as string[];
  return flat.filter((_, i) => i % 2 === 0);
};
/** Settled, or "threw" when settlePayPal let an error out. */
const settle = (store: Store) => settlePayPal(store).catch(() => "threw" as const);

/** Is this one command the book write of a payout for `aff` (HSET before this change, HSETNX after)? */
function bookWriteFor(commands: (string | number)[][], aff?: string): boolean {
  if (commands.length !== 1) return false;
  const [name, key, , value] = commands[0];
  if ((name !== "HSET" && name !== "HSETNX") || key !== PAYOUTS) return false;
  if (!aff) return true;
  try {
    return (JSON.parse(String(value)) as { aff?: unknown }).aff === aff;
  } catch {
    return false;
  }
}

/** The book write answered with `reply`; `land` first writes it for real, as a reply lost after the write. */
function bookWriteAnswers(reply: () => unknown[], land: boolean): void {
  redis.pipeline = async (commands) => {
    if (bookWriteFor(commands)) {
      if (land) await pipeline(commands);
      return reply();
    }
    return pipeline(commands);
  };
}

/** The store's data room answers full for the payouts slot (lib/store-data.ts TAKE_DATA: [0, used]). */
function roomFull(): void {
  redis.pipeline = async (commands) => {
    // ["EVAL", script, 1, key, room, always, month, "a", slot, bytes]
    const [name, , , , , always] = commands[0] ?? [];
    if (commands.length === 1 && name === "EVAL" && always === "0" && commands[0].includes("aff:payouts")) return [[0, 999_999_999]];
    return pipeline(commands);
  };
}

/** CX1-only scenarios, derived from the author's fixture; no product substitution. */
async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_item_claim_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const store = shop();
  part("Control: a real recorded payout survives a stale batch without another payment");
  await seed(store);
  const savedOpen = (await pipeline([["HGETALL", `nl:pp:open:${STATS}`]]))[0] as string[];
  await settle(store);
  await pipeline([["HSET", `nl:pp:open:${STATS}`, ...savedOpen]]);
  await settle(store);
  await payWithPayPal(store);
  is("a valid record means one payment and one batch", [await paidCents(store), created.length], [3000, 1]);
  part("An existing field with an unreadable payout is not a confirmed book record");
  for (const [label, raw] of [["invalid JSON", "not json"], ["empty text", ""]] as const) {
    await seed(store);
    const id = payoutIdForItem("ITEMBATCH1ABC0");
    // The record is unknown, not proof that this payout was written. HEXISTS truthfully says 1.
    await pipeline([["HSET", PAYOUTS, id, raw]]);
    const result = await settle(store);
    is(label + ": unconfirmed book entry keeps the affiliate waiting", result, {paid:0,released:0,waiting:1});
    is(label + ": book has no readable paid amount", await paidCents(store), 0);
    await payWithPayPal(store);
    console.log("CX1 receipt observation", label, JSON.stringify({result,batches:created.length,paid:await paidCents(store)}));
    is(label + ": no second PayPal batch for the same commission", created.length, 1);
  }
  done();
}
void main();

