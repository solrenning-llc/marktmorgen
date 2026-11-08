/**
 * A PayPal payout item is written into the affiliate book only on its own mark (CX-123 rule 24).
 *
 * settlePayPal takes nl:pp:item:<item> with SET NX before addPayout. "OK" is this run's mark and nil is a mark made
 * before it; any other answer (no envelope, an empty or odd value, an error) may have landed for nobody or for another
 * run. Such an answer is read back (lib/claim-mark.ts): the key holding this run's own value is ours, another value is
 * somebody else's, and anything else is unknown, so the payout is not written into the book this run and the affiliate
 * stays on their way to be read again. Synthetic store, synthetic PayPal stand-in.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
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

/** One affiliate owed $30, sent in one batch, reported SUCCESS by PayPal. */
async function seed(store: Store): Promise<void> {
  redis.pipeline = pipeline;
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: "aaaaaaaaaaaa", at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
  const sent = await payWithPayPal(store);
  if (!sent.ok) throw new Error(`not sent: ${sent.reason}`);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
}

const paidCents = async (store: Store) => (await readBook(store)).rows.find((r) => r.affiliate.email === "sara@example.com")?.paid ?? -1;

/** The item mark's SET NX answered with `reply`; `land` first writes it for real, as a reply lost after the write. */
function itemSetAnswers(reply: () => unknown[], land: boolean): void {
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === ITEM) {
      if (land) await pipeline(commands);
      return reply();
    }
    return pipeline(commands);
  };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_item_claim_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const store = shop();

  const shapes: [string, () => unknown[]][] = [
    ["no envelope", () => []],
    ["undefined", () => [undefined]],
    ["empty text", () => [""]],
    ["another word", () => ["QUEUED"]],
    ["a number", () => [1]],
    ["an object", () => [{ result: "OK" }]],
  ];

  part("An unknown answer, the mark not written: nothing in the book, still on their way");
  for (const [label, reply] of shapes) {
    await seed(store);
    itemSetAnswers(reply, false);
    const out = await settlePayPal(store);
    redis.pipeline = pipeline;
    is(`${label}: not counted paid, kept waiting`, out, { paid: 0, released: 0, waiting: 1 });
    is(`${label}: the book does not say paid`, await paidCents(store), 0);
    is(`${label}: still on their way`, (await onTheirWay(store)).size, 1);
    const again = await settlePayPal(store);
    is(`${label}: read again with a clean answer, paid once`, [again, await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
  }

  part("An unknown answer, the mark held by another run: never written twice");
  for (const [label, reply] of shapes) {
    await seed(store);
    await pipeline([["SET", ITEM, "BATCH1ABC", "EX", 3600]]);
    itemSetAnswers(reply, false);
    const out = await settlePayPal(store);
    redis.pipeline = pipeline;
    is(`${label}: another run's mark is not ours`, [out.paid, await paidCents(store)], [0, 0]);
  }

  part("A reply lost after the write: read back, ours, written once");
  for (const [label, reply] of shapes) {
    await seed(store);
    itemSetAnswers(reply, true);
    const out = await settlePayPal(store);
    redis.pipeline = pipeline;
    is(`${label}: our own mark, paid once`, [out, await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
    is(`${label}: asked again, nothing written twice`, [(await settlePayPal(store)).paid, await paidCents(store)], [0, 3000]);
  }

  part("Redis failing on the mark: nothing in the book, kept waiting");
  await seed(store);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === ITEM) throw new Error("synthetic Redis outage");
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ITEM) throw new Error("synthetic Redis outage");
    return pipeline(commands);
  };
  let outcome: unknown;
  try {
    outcome = await settlePayPal(store);
  } catch {
    outcome = "threw";
  }
  redis.pipeline = pipeline;
  is("the book does not say paid on an outage", await paidCents(store), 0);
  is("and the affiliate is still on their way", (await onTheirWay(store)).size, 1);
  is("the settling says so", outcome, { paid: 0, released: 0, waiting: 1 });

  part("Healthy controls");
  await seed(store);
  is("a clean OK writes the payout once", [await settlePayPal(store), await paidCents(store)], [{ paid: 1, released: 0, waiting: 0 }, 3000]);
  is("a clean nil (written before) writes nothing", [(await settlePayPal(store)).paid, await paidCents(store)], [0, 3000]);
  await seed(store);
  await pipeline([["SET", ITEM, "BATCH1ABC", "EX", 3600]]);
  const before = await settlePayPal(store);
  is("an item written into the book before: nil, nothing written, no longer waiting", [before, await paidCents(store)], [{ paid: 0, released: 0, waiting: 0 }, 0]);

  done();
}

void main();
