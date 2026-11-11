/**
 * An offer's claim (lib/upsell.ts, takeUpsell) is written before anything else, as a pending record that names
 * neither the creator's customer nor a payment. The charge is asked of Stripe only after that record is written
 * again naming the customer. So a pending record with neither a customer nor a payment, left behind when the claim's
 * reply came back garbled (refused as unknown) or when the write naming the customer failed, was never sent to Stripe.
 *
 * Such an orphan must not be shown as "checking" forever: once older than a request in flight could still be, the
 * thanks page's settling (settleUpsells) releases it, without asking Stripe and without charging, and the buyer can
 * answer the offer again, charged once in all. Younger, it is left alone (its own request may still be on its way).
 * A pending offer that did name a customer, whose Stripe state cannot be read, stays pending: never paid, never let go.
 *
 * Each press goes through the real route (POST /api/store/upsell) with the paying browser's own cookie, against a
 * stand-in for the creator's Stripe account.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey, readUpsell, settleUpsells } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_orphan_claim_only";
process.env.RESEND_API_KEY = "re_test_upsell_orphan_claim_only";

const OWNER = "orphanpotter@example.com";
const HANDLE = "orphanwork";
const ACCOUNT = "acct_1TestUpOrphan";
const NOW = Math.floor(Date.now() / 1000);

type Command = (string | number)[];

/** The offer's claim for this session is applied, but its reply is lost on the way back (garbled). */
let garble: { session: string; reply: unknown[] } | null = null;
/** For this session, the write that names the customer before Stripe is asked fails (Redis down a moment). */
let failCustomerWrite: string | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const one = batch.length === 1 && batch[0][0] === "SET" ? batch[0] : null;
  const claim = garble && one && String(one[1]).startsWith(`nl:upsell:${garble.session}`) && one.includes("NX") && String(one[2]).includes('"pending"');
  if (claim && garble) {
    await real(batch);
    return garble.reply;
  }
  const naming =
    failCustomerWrite && one && String(one[1]).startsWith(`nl:upsell:${failCustomerWrite}`) && !one.includes("NX") && String(one[2]).includes('"pending"') && String(one[2]).includes('"customer"');
  if (naming) throw new Error("Redis request failed with status 503");
  return real(batch);
}) as typeof redis.pipeline;

const charges: URLSearchParams[] = [];
/** Stripe reads of the customer's payments, and whether that list answers with Stripe's own failure. */
let reads = 0;
let listDown = false;
/** The clock moved on, for an answer to outlast the time a request in flight could still take. */
let later = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + later;
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charges.push(body);
    return answer({
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    });
  }
  if (path === "/payment_intents" && method === "GET") {
    reads += 1;
    return listDown ? answer({ error: { message: "Stripe is down" } }, 500) : answer({ object: "list", data: [], has_more: false });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function paidCheckout(id: string, product: string, fingerprint: string): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer07",
    currency: "usd",
    metadata: { store: HANDLE, product, upsell_key: fingerprint },
    customer_details: { email: "orphanbuyer@example.com" },
    payment_intent: { id: "pi_test_front00007", payment_method: { id: "pm_test_card0007", type: "card", customer: "cus_TestBuyer07" } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Orphanwork", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00008", subscriptionId: "sub_Owner00008", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Wheel Throwing Course", "49");
  const upsell = await add("Glaze Recipes Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "glaze1", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted: one offer after paying", saved.ok, true);

  const browser = newUpsellKey();
  const press = async (session: string) => {
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", await shownRef((await storeForEmail(OWNER))!, "glaze1"));
    form.set("answer", "yes");
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const charged = charges.length;
    let upsellNote: string | null;
    try {
      const response = await upsellRoute(
        new NextRequest("https://marktmorgen.com/api/store/upsell", {
          method: "POST",
          body: form,
          headers: { host: "marktmorgen.com", cookie: `${UPSELL_COOKIE}=${browser.secret}` },
        }),
      );
      upsellNote = new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell");
    } catch {
      upsellNote = "refused";
    }
    return { upsell: upsellNote, charges: charges.length - charged };
  };
  const shape = async (session: string) => {
    const record = await readUpsell(session);
    return record ? { state: record.state, customer: record.customer ?? null, pi: record.pi ?? null } : null;
  };
  /** The thanks page's settling, as it runs before the page is drawn: what it read of Stripe and charged. */
  const settle = async (session: string) => {
    const read = reads;
    const charged = charges.length;
    await settleUpsells((await storeForEmail(OWNER))!, session);
    return { reads: reads - read, charges: charges.length - charged };
  };
  const orphan = { state: "pending", customer: null, pi: null };

  const cases: [string, string, () => void][] = [
    ["the claim was written but its reply came back garbled", "cs_test_orphanclaim00001", () => (garble = { session: "cs_test_orphanclaim00001", reply: [1] })],
    ["the write naming the customer failed after the claim", "cs_test_orphanclaim00002", () => (failCustomerWrite = "cs_test_orphanclaim00002")],
  ];
  for (const [what, session, fault] of cases) {
    part(`An orphan claim: ${what}`);
    later = 0;
    fault();
    is("the press is refused and charges nothing", await press(session), { upsell: "refused", charges: 0 });
    garble = null;
    failCustomerWrite = null;
    is("left: pending, with neither a customer nor a payment", await shape(session), orphan);

    is("settled at once: nothing read of Stripe, nothing charged", await settle(session), { reads: 0, charges: 0 });
    is("young, it is left alone: its own request may still be on its way", await shape(session), orphan);

    later = 11 * 60 * 1000;
    is("settled once it is older than a request could take: nothing read of Stripe, nothing charged", await settle(session), { reads: 0, charges: 0 });
    is("released, never left checking", await shape(session), null);

    is("answered again: charged once, done", await press(session), { upsell: "done", charges: 1 });
    is("written as paid", (await shape(session))?.state, "paid");
    is("pressed once more: nothing charged again", await press(session), { upsell: "done", charges: 0 });
    is("one charge for this order's offer in all", charges.filter((c) => c.get("metadata[parent]") === session).length, 1);
  }

  part("An offer that named the customer and whose Stripe state cannot be read stays unknown");
  const unknown = "cs_test_orphanclaim00003";
  later = 0;
  // Stripe's answer to the charge lost: the press says checking, the record names the customer.
  const lose = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/payment_intents" && (init?.method ?? "GET") === "POST") {
      await lose(input, init);
      throw new Error("socket hang up");
    }
    return lose(input, init);
  }) as typeof fetch;
  const lost = await press(unknown);
  globalThis.fetch = lose;
  is("the press says checking: the answer was lost", lost.upsell, "checking");
  is("pending, naming the customer, no payment id", await shape(unknown), { state: "pending", customer: "cus_TestBuyer07", pi: null });
  listDown = true;
  later = 11 * 60 * 1000;
  is("settled with Stripe's list down: read, nothing charged", await settle(unknown), { reads: 1, charges: 0 });
  is("still pending: never paid, never let go", await shape(unknown), { state: "pending", customer: "cus_TestBuyer07", pi: null });
  listDown = false;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
