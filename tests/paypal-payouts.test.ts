/**
 * Paying affiliates from the creator's own PayPal.
 *
 * What is checked, against a stand-in for PayPal's API shaped by its
 * published OpenAPI description (payments_payouts_batch_v1):
 *
 *   - an app is kept only when PayPal accepts it and has Payouts on, and its
 *     Secret is never stored readable;
 *   - one press sends everyone owed and cleared, from the creator's PayPal,
 *     with PayPal's own idempotency key, and nobody is sent twice while a
 *     payment is on its way;
 *   - a balance that does not cover it sends nothing;
 *   - the book says "paid" only for what PayPal reports as SUCCESS, once;
 *     what PayPal could not pay goes back to owed;
 *   - payday can pay by itself, and says what happened.
 */
import { connectPayPal, disconnectPayPal, onTheirWay, payWithPayPal, paysAutomatically, readPayPal, setAutoPay, settlePayPal } from "@/lib/paypal-payouts";
import { autoPayEmail } from "@/lib/affiliate-payday";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsid1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let scope = "https://uri.paypal.com/services/invoicing https://uri.paypal.com/payments/payouts openid";
let tokenStatus = 200;
let funds = true;
let itemStatus: Record<string, string> = {};
const created: { body: Record<string, unknown>; requestId: string | null }[] = [];
let fetches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fetches += 1;
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    if (tokenStatus !== 200) return json({ error: "invalid_client" }, tokenStatus);
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope, expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AAtoken") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    if (!funds) return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push({ body, requestId: headers.get("paypal-request-id") });
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
    sid: "sidharbor01",
    handle: "harbor",
    name: "Harbor Kitchen",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestHarbor0001",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) =>
    JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) =>
    JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
}

const owed = async (store: Store) => new Map((await readBook(store)).rows.map((r) => [r.affiliate.email, [r.paid, r.payable]] as const).sort((a, b) => a[0].localeCompare(b[0])));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_payouts_only";
  process.env.RESEND_API_KEY = "re_test_only";
  await seed();
  const store = shop();

  part("Connecting the creator's own PayPal app");
  is("not a Client ID", (await connectPayPal(store, "short", SECRET)).ok ? "kept" : "refused", "refused");
  tokenStatus = 401;
  const wrong = await connectPayPal(store, CLIENT, SECRET);
  is("PayPal refuses it", wrong.ok ? "kept" : wrong.reason, "refused");
  tokenStatus = 200;
  scope = "https://uri.paypal.com/services/invoicing openid";
  const noPayouts = await connectPayPal(store, CLIENT, SECRET);
  is("an app without Payouts on", noPayouts.ok ? "kept" : noPayouts.reason, "no-payouts");
  scope = "https://uri.paypal.com/services/invoicing https://uri.paypal.com/payments/payouts openid";
  is("an app with Payouts on", (await connectPayPal(store, CLIENT, SECRET)).ok, true);
  const [raw] = await redis.pipeline([["GET", `nl:pp:${STATS}`]]);
  is("the Secret is not stored readable", String(raw).includes(SECRET), false);
  const view = await readPayPal(store);
  is("the studio sees only a shortened Client ID", [view?.client, view?.broken, view?.auto], ["AbCdEf…6789", false, false]);

  part("One press");
  await redis.pipeline([["SET", `nl:pp:${STATS}:lock`, "another-payout", "EX", 60]]);
  const fetchedBefore = fetches;
  const held = await payWithPayPal(store);
  await redis.pipeline([["DEL", `nl:pp:${STATS}:lock`]]);
  is("another payout holding the lock: busy, never an error, and nothing asked of PayPal or Stripe", [held.ok ? "sent" : held.reason, fetches - fetchedBefore, created.length], ["busy", 0, 0]);
  funds = false;
  const short = await payWithPayPal(store);
  is("a balance that does not cover it sends nothing", [short.ok ? "sent" : short.reason, (await onTheirWay(store)).size], ["funds", 0]);
  funds = true;
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
  is("everyone owed, in one batch", [paid.people, paid.cents], [2, 4500]);
  const body = created[0].body as { sender_batch_header: Record<string, string>; items: Record<string, unknown>[] };
  is("with PayPal's idempotency key, the batch's own id", created[0].requestId, body.sender_batch_header.sender_batch_id);
  is("each by email, in the store's currency, as PayPal writes amounts", body.items.map((i) => [i.recipient_type, i.receiver, i.amount, i.sender_item_id]), [
    ["EMAIL", "sara@example.com", { currency: "USD", value: "30.00" }, "aaaaaaaaaaaa"],
    ["EMAIL", "tom@example.com", { currency: "USD", value: "15.00" }, "bbbbbbbbbbbb"],
  ]);
  const allowedHeader = ["sender_batch_id", "recipient_type", "email_subject", "email_message", "note"];
  const allowedItem = ["recipient_type", "amount", "note", "receiver", "sender_item_id", "recipient_wallet", "alternate_notification_method", "notification_language", "application_context", "purpose"];
  is(
    "only fields PayPal's description has",
    [Object.keys(body.sender_batch_header).every((k) => allowedHeader.includes(k)), body.items.every((i) => Object.keys(i).every((k) => allowedItem.includes(k)))],
    [true, true],
  );
  is("both on their way", (await onTheirWay(store)).size, 2);
  const again = await payWithPayPal(store);
  is("nobody is sent twice while on their way", again.ok ? "sent" : again.reason, "nothing");
  is("the book does not say paid yet", Object.fromEntries(await owed(store)), { "sara@example.com": [0, 3000], "tom@example.com": [0, 1500] });

  part("Unavailable pending records never start a new payment");
  const pipeline = redis.pipeline.bind(redis);
  const openKey = `nl:pp:open:${STATS}`;
  const [savedOpen] = await pipeline([["HGETALL", openKey]]);
  for (const broken of [undefined, null, ["BROKEN"], {BROKEN:"{"}, {BROKEN:JSON.stringify({at:1,currency:"usd",lines:[{a:"a",c:-1}]})}]) {
    redis.pipeline = async (commands) => commands.some((cmd) => cmd[0] === "HGETALL" && cmd[1] === openKey)
      ? [broken] : pipeline(commands);
    const sentBefore = created.length;
    let blocked = false;
    try { await onTheirWay(store); } catch { blocked = true; }
    is("unknown pending exposure rejects the read", blocked, true);
    const refused = await payWithPayPal(store);
    is("unknown pending exposure refuses a new batch", refused.ok ? "sent" : refused.reason, "error");
    is("no provider batch is dispatched", created.length, sentBefore);
    let settlementBlocked = false;
    try { await settlePayPal(store); } catch { settlementBlocked = true; }
    is("invalid storage is not cleared by settlement", settlementBlocked, true);
  }
  redis.pipeline = pipeline;
  is("saved pending records were not changed", await pipeline([["HGETALL", openKey]]), [savedOpen]);
  is("valid pending records recover immediately", (await onTheirWay(store)).size, 2);

  part("What PayPal reports");
  itemStatus = { aaaaaaaaaaaa: "SUCCESS", bbbbbbbbbbbb: "UNCLAIMED" };
  is("paid, and still waiting to be claimed", await settlePayPal(store), { paid: 1, released: 0, waiting: 1 });
  is("the book says paid for SUCCESS only", Object.fromEntries(await owed(store)), { "sara@example.com": [3000, 0], "tom@example.com": [0, 1500] });
  is("asked again, nothing is written twice", (await settlePayPal(store)).paid, 0);
  is("still counted as paid once", (await owed(store)).get("sara@example.com"), [3000, 0]);
  itemStatus = { aaaaaaaaaaaa: "SUCCESS", bbbbbbbbbbbb: "RETURNED" };
  is("not claimed in time: back to owed", await settlePayPal(store), { paid: 0, released: 1, waiting: 0 });
  is("nobody on their way any more", (await onTheirWay(store)).size, 0);
  const retry = await payWithPayPal(store);
  is("and they can be paid again", retry.ok ? [retry.people, retry.cents] : retry.reason, [1, 1500]);

  part("Payday by itself");
  is("off until asked", await paysAutomatically(store), false);
  await setAutoPay(store, true);
  is("on when asked", await paysAutomatically(store), true);
  const sentEmail = autoPayEmail({ ok: true, batch: "BATCH9ABC", people: 2, cents: 4500 }, "usd");
  is("the email says what was sent, from where", [sentEmail.subject, sentEmail.text.includes("from your own PayPal")], ["$45 sent to 2 affiliates from your PayPal", true]);
  const failedEmail = autoPayEmail({ ok: false, reason: "funds" }, "usd");
  is("and when nothing could be sent, why", [failedEmail.subject, failedEmail.text.includes("did not cover it")], ["Your affiliates were not paid today", true]);

  part("Taken away");
  await disconnectPayPal(store);
  const gone = await payWithPayPal(store);
  is("nothing is sent without it", [await readPayPal(store), gone.ok ? "sent" : gone.reason], [null, "not-connected"]);

  done();
}

void main();
