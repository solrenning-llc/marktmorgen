/**
 * #3834 LOW (Claude 1 cloud, rev-pares; Claude 2 nuvem B): the record naming the customer, written before Stripe
 * is asked, was a plain SET. A press stalled longer than the orphan window between its claim and that write could
 * find its claim let go by the sweep and a second press's claim in its place, and then overwrite that second claim
 * and charge too. The write is now a compare-and-set against this press's own claim text: a claim that is no longer
 * this press's is never written over, and the press is refused before Stripe is asked.
 *
 * Synthetic: the real route, in-memory Redis, a stand-in for the creator's Stripe account.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_stalled_press_only";
process.env.RESEND_API_KEY = "re_test_upsell_stalled_press_only";

const OWNER = "stallpotter@example.com";
const HANDLE = "stallwork";
const ACCOUNT = "acct_1TestUpStall";
const NOW = Math.floor(Date.now() / 1000);

type Command = (string | number)[];

/** Before the write naming the customer lands, the key already holds another press's claim (the stall). */
let stall: { session: string; theirs: string } | null = null;
let stalledKey = "";
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const naming = (c: Command) => String(c[1]).startsWith(`nl:upsell:${stall?.session}`) && String(c).includes('cus_TestBuyer07');
  if (stall && batch.some((c) => (c[0] === "SET" && !c.includes("NX") && naming(c)) || (c[0] === "EVAL" && String(c[3]).startsWith(`nl:upsell:${stall!.session}`) && String(c).includes("cus_TestBuyer07")))) {
    const key = batch.find((c) => c[0] === "SET" || c[0] === "EVAL")!;
    stalledKey = String(key[0] === "EVAL" ? key[3] : key[1]);
    await real([["SET", stalledKey, stall.theirs]]);
  }
  return real(batch);
}) as typeof redis.pipeline;

const charges: URLSearchParams[] = [];
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
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: [], has_more: false });
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
    customer_details: { email: "claimbuyer@example.com" },
    payment_intent: { id: "pi_test_front00007", payment_method: { id: "pm_test_card0007", type: "card", customer: "cus_TestBuyer07" } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Stallwork", "");
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
    let note: string | null;
    try {
      const response = await upsellRoute(
        new NextRequest("https://marktmorgen.com/api/store/upsell", {
          method: "POST",
          body: form,
          headers: { host: "marktmorgen.com", cookie: `${UPSELL_COOKIE}=${browser.secret}` },
        }),
      );
      note = new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell");
    } catch {
      note = "refused";
    }
    return { upsell: note, charges: charges.length - charged };
  };

  part("Control: a press whose claim is still its own is charged once");
  is("charged once, done", await press("cs_test_stalledpress00001"), { upsell: "done", charges: 1 });

  part("A press whose claim was let go and taken by a second press while it stalled");
  const session = "cs_test_stalledpress00002";
  const theirs = JSON.stringify({ state: "pending", product: upsell, at: Date.now() + 1 });
  stall = { session, theirs };
  const stalled = await press(session);
  stall = null;
  is("the stalled press is refused and nothing is charged", stalled, { upsell: "refused", charges: 0 });
  is("the stall happened at the write naming the customer", stalledKey !== "", true);
  const [left] = (await real([["GET", stalledKey]])) as unknown[];
  is("the second press's claim is still there, not written over", left, theirs);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
