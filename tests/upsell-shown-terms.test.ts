/**
 * An offer after paying is answered for the offer as the thanks page showed it (lib/upsell.ts, offerRef and
 * takeUpsell; app/[handle]/thanks/page.tsx): the form names the step by its id and the fingerprint of the terms
 * drawn on the page (product, title, price, currency, words, picture, consent box). A yes or a no counts only
 * while the step still has those exact terms; otherwise nothing is charged or written, the buyer is told so in
 * the store's language and the page shows the offer as it stands now, to decide again.
 *
 * The charge itself is always the server's own current price: the fingerprint is compared, never charged.
 * The healthy one-click path is unchanged: one charge, one idempotency key per offer, the consent on it.
 *
 * Synthetic data only: a stand-in for the creator's Stripe account and the Redis stub.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_META, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UPSELL_COOKIE, funnelView, newUpsellKey, readUpsell, takeUpsell } from "@/lib/upsell";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { readListing } from "@/lib/catalog";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_shown_only";
process.env.RESEND_API_KEY = "re_test_upsell_shown_only";

const OWNER = "baker@example.com";
const HANDLE = "harbor";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpShown01";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
const made: Record<string, unknown>[] = [];
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
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    charges.push({ body, key });
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    };
    made.push(pi);
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: made, has_more: false });
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the browser key it carried. */
function paidCheckout(id: string, product: string, fingerprint: string): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: HANDLE, product, upsell_key: fingerprint },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const guide = await add("Starter Kit Guide", "29");
  const dearer = await add("Bakery Masterclass", "99");
  const step = (productId: string, priceCents: number, headline = "") => ({ id: "kit001", productId, priceCents, headline, text: "", imageFrom: null, yes: null, no: null });
  const funnel = async (productId: string, priceCents: number, headline = "") => (await setProductFunnel(OWNER, front, { steps: [step(productId, priceCents, headline)] })).ok;
  const browser = newUpsellKey();
  let order = 0;
  const newOrder = () => {
    order += 1;
    const id = `cs_test_shownR42${String(order).padStart(8, "0")}`;
    sessions[id] = paidCheckout(id, front, browser.fingerprint);
    return id;
  };
  /** What the thanks page shows this order now, and the step reference its form carries. */
  const page = async (session: string) => {
    const store = (await storeForEmail(OWNER))!;
    const view = await funnelView({ store, session, product: (await readListing(store, front))!, alsoOwned: [], eligible: true, created: NOW - 60, secret: browser.secret, upsellKey: browser.fingerprint });
    const ref = (view.offer as { ref?: unknown } | null)?.ref;
    return { title: view.offer?.target.title ?? null, price: view.offer?.step.priceCents ?? null, ref: typeof ref === "string" ? ref : "" };
  };
  const press = async (session: string, ref: string, answer: "yes" | "no" = "yes") => {
    const store = (await storeForEmail(OWNER))!;
    const before = charges.length;
    const result = await takeUpsell({ store, session, secret: browser.secret, origin: "https://marktmorgen.com", step: ref, answer, consent: TEST_CONSENT });
    return {
      kind: result.kind,
      charged: charges.slice(before).map((c) => [c.body.get("amount"), c.body.get("metadata[title]")]),
      written: (await readUpsell(session))?.state ?? null,
    };
  };

  part("Healthy: the page's own reference, terms unchanged");
  is("the funnel is saved: one offer, the guide at $19", await funnel(guide, 1900), true);
  const healthy = newOrder();
  const shown = await page(healthy);
  is("the page shows the guide for $19", [shown.title, shown.price], ["Starter Kit Guide", 1900]);
  is("its form names the step by id and the terms shown", /^kit001\.[0-9a-f]{32}$/.test(shown.ref), true);
  const yes = await press(healthy, shown.ref);
  is("yes: charged once, $19 for the guide, written as paid", yes, { kind: "done", charged: [["1900", "Starter Kit Guide"]], written: "paid" });
  const last = charges.at(-1);
  is("one idempotency key for the offer of this order, as before", last?.key, `nimbus-upsell:${healthy}`);
  is("the yes to start access at once is on the offer's own payment", Boolean(last?.body.get(`metadata[${CONSENT_META}]`)), true);
  is("the charge carries the step's own id, never the reference", [last?.body.get("metadata[step_id]"), last?.body.get("metadata[step_number]")], ["kit001", "1"]);
  const again = await press(healthy, shown.ref);
  is("a second press charges nothing more", [again.kind, again.charged], ["done", []]);

  part("The creator edits the step while the buyer reads it (same step id)");
  const edited = newOrder();
  const before = await page(edited);
  is("the page shows the guide for $19", [before.title, before.price], ["Starter Kit Guide", 1900]);
  is("step kit001 now offers the masterclass at $99", await funnel(dearer, 9900), true);
  const stale = await press(edited, before.ref);
  is("yes on the old terms: nothing charged, nothing written, told the offer changed", stale, { kind: "changed", charged: [], written: null });
  const bare = await press(edited, "kit001");
  is("a press naming only the step id (the form before this change): nothing charged", bare, { kind: "changed", charged: [], written: null });
  const now = await page(edited);
  is("the page then shows the offer as it stands now", [now.title, now.price], ["Bakery Masterclass", 9900]);
  is("with a reference of its own", now.ref !== before.ref && now.ref.startsWith("kit001."), true);
  const decided = await press(edited, now.ref);
  is("deciding again on what is shown: charged once, $99 for the masterclass", decided, { kind: "done", charged: [["9900", "Bakery Masterclass"]], written: "paid" });

  part("Only the price changes");
  await funnel(guide, 1900);
  const priced = newOrder();
  const at19 = await page(priced);
  await funnel(guide, 2500);
  is("yes on $19 while the step asks $25: nothing charged", await press(priced, at19.ref), { kind: "changed", charged: [], written: null });

  part("Only the words change");
  await funnel(guide, 1900);
  const worded = newOrder();
  const plain = await page(worded);
  await funnel(guide, 1900, "Bake every day");
  is("yes under words that are no longer the step's: nothing charged", await press(worded, plain.ref), { kind: "changed", charged: [], written: null });

  part("No thanks on old terms");
  await funnel(guide, 1900);
  const declining = newOrder();
  const offered = await page(declining);
  await funnel(dearer, 9900);
  is("no thanks on the old terms: nothing written, told the offer changed", await press(declining, offered.ref, "no"), { kind: "changed", charged: [], written: null });
  is("no thanks on what is shown now: declined", await press(declining, (await page(declining)).ref, "no"), { kind: "declined", charged: [], written: "declined" });

  part("Through the route, as the page's form posts it");
  await funnel(guide, 1900);
  const post = async (session: string, ref: string) => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", ref);
    form.set("answer", "yes");
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const response = await upsellRoute(
      new NextRequest("https://marktmorgen.com/api/store/upsell", {
        method: "POST",
        body: form,
        headers: { host: "marktmorgen.com", cookie: `${UPSELL_COOKIE}=${browser.secret}` },
      }),
    );
    return [response.status, new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell")];
  };
  const routed = newOrder();
  const routedRef = (await page(routed)).ref;
  const routedBefore = charges.length;
  is("the whole reference reaches takeUpsell: done", await post(routed, routedRef), [303, "done"]);
  is("charged once", charges.length - routedBefore, 1);
  const routedStale = newOrder();
  const staleRef = (await page(routedStale)).ref;
  await funnel(guide, 2500);
  const staleBefore = charges.length;
  is("old terms through the route: back to the page with the changed note", await post(routedStale, staleRef), [303, "changed"]);
  is("nothing charged", charges.length - staleBefore, 0);

  part("What the page says, in every store language");
  for (const lang of LANGUAGE_CODES) {
    const note = thanksWords(lang).upsellNotes.changed;
    is(`${lang}: the changed note is there`, typeof note === "string" && note.length > 20, true);
  }
  const source = readFileSync(join(process.cwd(), "app/[handle]/thanks/page.tsx"), "utf8");
  is("the page's form posts the reference of the terms it drew", /name="step" value=\{offer\.ref\}/.test(source), true);
  is("the changed note is always said", /changed: \{ always: true \}/.test(source), true);
  done();
}

void main();
