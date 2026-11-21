/**
 * The one-click offer after paying is claimed once with a SET NX before the
 * card is charged (lib/upsell.ts, takeUpsell). Redis answers that claim with
 * exactly "OK" (taken here) or null (already answered). Any other reply —
 * none at all, a number, a word that is not "OK", more than one reply — does
 * not say the claim was taken here, so it is unknown (CX-123 rule 24): the
 * card is never charged on it and nothing further is written for the offer.
 *
 * Each case goes through the real route (POST /api/store/upsell) with the
 * paying browser's own cookie, against a stand-in for the creator's Stripe
 * account, with the claim's reply garbled and the claim itself not applied.
 * A press whose claim answers "OK" is charged once, as before.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey, readUpsell } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_claim_exact_only";
process.env.RESEND_API_KEY = "re_test_upsell_claim_exact_only";

const OWNER = "claimpotter@example.com";
const HANDLE = "claimwork";
const ACCOUNT = "acct_1TestUpClaimEx";
const NOW = Math.floor(Date.now() / 1000);

type Command = (string | number)[];

/** The garbled reply given to the offer's claim for the session named, the claim itself not applied. */
let garble: { session: string; reply: unknown[] } | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const claim =
    garble &&
    batch.length === 1 &&
    batch[0][0] === "SET" &&
    String(batch[0][1]).startsWith(`nl:upsell:${garble.session}`) &&
    batch[0].includes("NX") &&
    String(batch[0][2]).includes('"pending"');
  if (claim && garble) return garble.reply;
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
  await claimHandle(OWNER, HANDLE, "Claimwork", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00007", subscriptionId: "sub_Owner00007", active: true, period: paidPeriod() });
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
  /** A yes pressed on the offer: its answer (or that it was refused with an error), the charges it made, what it wrote. */
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
    return { upsell: upsellNote, charges: charges.length - charged, written: (await readUpsell(session))?.state ?? null };
  };

  part("Control: a claim answered exactly \"OK\" is charged once");
  is("charged once, done, written as paid", await press("cs_test_claimexact000001"), { upsell: "done", charges: 1, written: "paid" });

  part("A claim whose reply is not exactly \"OK\" or null is unknown: never charged on");
  const garbled: [string, unknown[]][] = [
    ["no reply at all", []],
    ["a number", [1]],
    ["a word that is not OK", ["QUEUED"]],
    ["an empty answer", [""]],
    ["more replies than commands", ["OK", "OK"]],
  ];
  let n = 2;
  for (const [what, reply] of garbled) {
    const session = `cs_test_claimexact00000${n}`;
    n += 1;
    garble = { session, reply };
    is(`${what}: refused, nothing charged, nothing written`, await press(session), { upsell: "refused", charges: 0, written: null });
    garble = null;
  }

  part("Control again: a fresh offer whose claim answers \"OK\" is charged once more");
  is("charged once, done", await press("cs_test_claimexact000009"), { upsell: "done", charges: 1, written: "paid" });
  is("two charges in all, both from the controls", charges.length, 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
