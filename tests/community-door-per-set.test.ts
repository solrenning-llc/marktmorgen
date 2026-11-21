/**
 * Claude 6's money review of #3395 at 685d38ff5c (17 November 2026), read with the code itself, the in-memory
 * database and a stand-in for the creator's Stripe account:
 *
 *   D1  [MEDIUM] a door whose products the shared reading ran out of refund questions for (Holdings `short`) read
 *       Stripe on its own, under its own key: the events page asks every event at once, so fifty events kept for the
 *       same product made fifty readings (150 calls) in one view, where main made one a set of products (`bySet`).
 *       One reading a set of products now answers every door kept for it in the same view.
 *   D2  [MEDIUM] a door's own reading that came up short too ("more than is read", lasting) kept nothing, so every
 *       view asked Stripe again for the same "not known". It is kept a minute, as the shared reading keeps one.
 */
import * as access from "@/lib/community-access";
import { mayAttend, type CommunityEvent } from "@/lib/community-events";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "cdps-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);

/** Checkouts by the address they were paid from, newest first. */
const sessions: Record<string, Record<string, unknown>[]> = {};
const invoices: Record<string, Record<string, unknown>> = {};
const payments: Record<string, Record<string, unknown>> = {};
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "email_test_1" });
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const all = sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  }
  if (path.startsWith("/invoices/")) return answer(invoices[decodeURIComponent(path.slice("/invoices/".length))] ?? {});
  if (path.startsWith("/payment_intents/")) return answer(payments[decodeURIComponent(path.slice("/payment_intents/".length))] ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string, refunded = false) => ({ object: "charge", id, amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed: false });
/** A payment plan's checkout, whose first invoice was paid by one payment, refunded or not. */
const plan = (n: number, product: string, refunded = false) => {
  const tag = String(n).padStart(4, "0");
  const invoice = `in_cdpsplan${tag}`;
  const pi = `pi_cdpsplan${tag}`;
  invoices[invoice] = { id: invoice, object: "invoice", payment_intent: pi };
  payments[pi] = { id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge(`ch_cdpsplan${tag}`, refunded) };
  return {
    id: `cs_test_cdps${String(n).padStart(6, "0")}`,
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    created: NOW - 86_400 - n,
    customer: null,
    metadata: { store: "doorperset", product, kind: "plan" },
    payment_intent: null,
    invoice,
    subscription: { id: `sub_cdps${n}`, status: "active" },
  };
};
/** An event kept for `only`: what the door reads of it is its id, its version and its products. */
const event = (only: string[]) => ({ id: newItemId(), v: 1, only }) as unknown as CommunityEvent;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_door_per_set_only";
  process.env.RESEND_API_KEY = "re_test_community_door_per_set_only";
  await claimHandle(OWNER, "doorperset", "Door Per Set", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1DoorPerSet01", true);
  await setSubscription(OWNER, { customerId: "cus_DoorPerSet01", subscriptionId: "sub_DoorPerSet01", active: true, period: paidPeriod() });
  const made = async (title: string) => {
    const added = await addProduct(OWNER, title, "", "49", null);
    if (!added.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
    return added.product.id;
  };
  const a = await made("Course A");
  const b = await made("Course B");
  const c = await made("Course C");
  await setCommunity(OWNER, true);
  const fresh = async () => (await storeForEmail(OWNER))!;
  const id = (await fresh()).community!.id;
  const config: CommunityConfig = { ...freshConfig("Door Per Set"), access: [a, b, c] };
  await saveConfig(id, config);

  part("D1 [MEDIUM] fifty events kept for one product: one reading of it, not one an event");
  // A and B in installments use the shared reading's refund questions; C is left to its doors' own readings.
  sessions["one@example.com"] = [plan(1, a), plan(2, b), plan(3, c)];
  sessions["fifty@example.com"] = [plan(11, a), plan(12, b), plan(13, c)];
  const one = { owner: false, email: "one@example.com", holdings: await access.holdingsOf(await fresh(), config, "one@example.com") };
  is("control: the shared reading left C to the doors kept for it", one.holdings.short?.has(c) ?? false, true);
  stripeCalls = 0;
  is("control: one event kept for C opens", await mayAttend(await fresh(), config, event([c]), one), true);
  const single = stripeCalls;
  is("control: and it read Stripe", single > 0, true);
  const fifty = { owner: false, email: "fifty@example.com", holdings: await access.holdingsOf(await fresh(), config, "fifty@example.com") };
  const events = Array.from({ length: 50 }, () => event([c]));
  const view = await fresh();
  stripeCalls = 0;
  const answers = await Promise.all(events.map((e) => mayAttend(view, config, e, fifty)));
  is("all fifty open for somebody who paid for C", answers.every((x) => x === true), true);
  is("with the calls of one reading, not fifty", stripeCalls, single);
  // A space kept for C in the same view is the same set of products: answered by the same reading.
  stripeCalls = 0;
  is("a space kept for C in the same view opens", await access.spaceAnswer(view, config, { id: newItemId(), only: [c] }, fifty), true);
  is("without asking Stripe again", stripeCalls, 0);

  part("D2 [MEDIUM] a door's own reading that comes up short is kept a minute");
  // C bought three times in installments, the newest two given back: C's own refund questions are spent on them.
  sessions["short@example.com"] = [plan(21, a), plan(22, b), plan(23, c, true), plan(24, c, true), plan(25, c)];
  const shortViewer = async () => ({ owner: false, email: "short@example.com", holdings: await access.holdingsOf(await fresh(), config, "short@example.com") });
  const room = { id: newItemId(), only: [c] };
  is("C's own reading comes up short: not known, never open", await access.spaceAnswer(await fresh(), config, room, await shortViewer()), "unknown");
  stripeCalls = 0;
  is("the next view: still not known", await access.spaceAnswer(await fresh(), config, room, await shortViewer()), "unknown");
  is("without asking Stripe again", stripeCalls, 0);
  redis.advance(61_000);
  stripeCalls = 0;
  await access.spaceAnswer(await fresh(), config, room, await shortViewer());
  is("control: a minute later it is read again", stripeCalls > 0, true);
  done();
}

void main();
