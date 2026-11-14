/**
 * Claude 1 cloud's review of #3395 at e002635470 (12 November 2026, 08:41 UTC), read with the code itself, the
 * in-memory database and a stand-in for the creator's Stripe account:
 *
 *   B1  [MEDIUM] the refund questions of one reading (TICKET_REFUND_CHECKS) were shared by every product of the
 *       community: a member who bought A, B and C in installments (each a payment plan, each needing one question,
 *       newest first A, B, C) never got C asked, so the space kept for C said "write to the creator" for good to
 *       somebody who paid. On main each door made its own reading that stopped at its own product. A door whose
 *       products the shared reading left unasked for want of questions now asks for its own products alone, with
 *       questions of its own, its answer kept under the door's own key.
 *   B2  [MEDIUM] the shared reading was kept five minutes only when the member held EVERY product asked: holding the
 *       ticket and not a second access product kept it one minute (main kept the gate's "yes" five), and each minute
 *       read every page again, unpaid. It is now kept by the gate's own answer: five minutes while the ticket is held.
 */
import * as access from "@/lib/community-access";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { mintPass, passCookieName } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "cpb-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);

/** Checkouts by the address they were paid from, newest first. */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** Invoices by id, payments by id. */
const invoices: Record<string, Record<string, unknown>> = {};
const payments: Record<string, Record<string, unknown>> = {};
/** Every call to Stripe, and the pages of checkouts among them. */
let stripeCalls = 0;
let sessionPages = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "email_test_1" });
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const page = (all: Record<string, unknown>[]) => {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  };
  if (path === "/checkout/sessions") {
    sessionPages += 1;
    return page(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  }
  if (path.startsWith("/invoices/")) return answer(invoices[decodeURIComponent(path.slice("/invoices/".length))] ?? {});
  if (path.startsWith("/payment_intents/")) return answer(payments[decodeURIComponent(path.slice("/payment_intents/".length))] ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string, refunded = false) => ({ object: "charge", id, amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed: false });
const paid = (n: number, product: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: `cs_test_cpb${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400 - n,
  customer: null,
  metadata: { store: "paidbudget", product, ...meta },
  payment_intent: { id: `pi_cpb${n}`, object: "payment_intent", latest_charge: charge(`ch_cpb${String(n).padStart(6, "0")}`) },
  ...extra,
});
/** A payment plan's checkout, whose first invoice was paid by one payment, refunded or not. */
const plan = (n: number, product: string, refunded = false) => {
  const invoice = `in_cpbplan${String(n).padStart(4, "0")}`;
  const pi = `pi_cpbplan${String(n).padStart(4, "0")}`;
  invoices[invoice] = { id: invoice, object: "invoice", payment_intent: pi };
  payments[pi] = { id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge(`ch_cpbplan${String(n).padStart(4, "0")}`, refunded) };
  return paid(n, product, { mode: "subscription", payment_intent: null, invoice, subscription: { id: `sub_cpb${n}`, status: "active" } }, { kind: "plan" });
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_paid_budget_only";
  process.env.RESEND_API_KEY = "re_test_community_paid_budget_only";
  await claimHandle(OWNER, "paidbudget", "Paid Budget", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaidBudg01", true);
  await setSubscription(OWNER, { customerId: "cus_PaidBudg0001", subscriptionId: "sub_PaidBudg0001", active: true, period: paidPeriod() });
  const made = async (title: string, price: string) => {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
    return added.product.id;
  };
  const a = await made("Course A", "49");
  const b = await made("Course B", "49");
  const c = await made("Course C", "49");
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const fresh = async () => {
    store = (await storeForEmail(OWNER))!;
    return store;
  };
  const spaceC = { id: newItemId(), name: "C room", about: "", creatorOnly: false, only: [c], level: 0 };
  const spaceA = { id: newItemId(), name: "A room", about: "", creatorOnly: false, only: [a], level: 0 };
  const three: CommunityConfig = {
    ...freshConfig(store.name),
    access: [a, b, c],
    spaces: [{ id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 }, spaceA, spaceC] as CommunityConfig["spaces"],
  };
  await saveConfig(id, three);

  part("B1 [MEDIUM] three products bought in installments: the space kept for the third opens");
  sessions["abc@example.com"] = [plan(1, a), plan(2, b), plan(3, c)];
  const viewer = { owner: false, email: "abc@example.com" };
  is("the space kept for C opens for somebody who paid for C", await access.maySeeSpace(await fresh(), three, spaceC, viewer), true);
  is("and is said as open, never as not known", await access.spaceAnswer(await fresh(), three, spaceC, viewer), true);
  is("control: the space kept for A opens too", await access.maySeeSpace(await fresh(), three, spaceA, viewer), true);
  stripeCalls = 0;
  is("the door's own answer is kept: asked again, still open", await access.maySeeSpace(await fresh(), three, spaceC, viewer), true);
  is("without asking Stripe again", stripeCalls, 0);
  const spaces = await access.spaceChecks(await fresh(), three, viewer);
  is("the list of spaces shows C's, with nothing left unchecked", [spaces.spaces.some((s) => s.id === spaceC.id), spaces.unchecked.size], [true, 0]);
  // C's own installments given back: its door's own reading says "no", never "yes" on a guess.
  sessions["abc-gone@example.com"] = [plan(11, a), plan(12, b), plan(13, c, true)];
  const gone = { owner: false, email: "abc-gone@example.com" };
  is("C refunded: its own reading says shut, never not known", await access.spaceAnswer(await fresh(), three, spaceC, gone), false);
  is("control: A still opens", await access.spaceAnswer(await fresh(), three, spaceA, gone), true);
  // Stripe that cannot be asked on the door's own reading: not known, never open.
  sessions["abc-down@example.com"] = [plan(21, a), plan(22, b), plan(23, c)];
  const down = { owner: false, email: "abc-down@example.com" };
  const held = await access.holdingsOf(await fresh(), three, down.email);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const downAnswer = await access.spaceAnswer(await fresh(), three, spaceC, { ...down, holdings: held });
  globalThis.fetch = realFetch;
  is("control: the door's own reading failing is not known, never open", downAnswer, "unknown");

  part("B2 [MEDIUM] the ticket held, a second access product not: the reading is kept five minutes");
  const ticket = a;
  const second = b;
  const two: CommunityConfig = { ...three, access: [ticket, second], spaces: [three.spaces[0]] };
  await saveConfig(id, two);
  // Three pages of checkouts of something else, then the ticket: the reading reads every page.
  const other = c;
  sessions["one-of-two@example.com"] = [paid(100, ticket), ...Array.from({ length: 150 }, (_, i) => paid(101 + i, other))];
  const jar = async () => {
    const pass = await mintPass(await fresh(), "one-of-two@example.com", "all");
    const name = passCookieName(store);
    return { get: (n: string) => (n === name ? { value: pass } : undefined) };
  };
  const first = await access.communityViewer(await fresh(), await jar());
  is("the member is in", first.state, "in");
  redis.advance(120_000);
  stripeCalls = 0;
  sessionPages = 0;
  const again = await access.communityViewer(await fresh(), await jar());
  is("two minutes later, still in", again.state, "in");
  is("without reading Stripe again", [stripeCalls, sessionPages], [0, 0]);
  redis.advance(181_000);
  stripeCalls = 0;
  await access.communityViewer(await fresh(), await jar());
  is("control: past five minutes it is read again", stripeCalls > 0, true);
  // Holding neither: a "no" is kept a minute, as before.
  sessions["neither@example.com"] = [paid(400, other)];
  const neither = async () => {
    const pass = await mintPass(await fresh(), "neither@example.com", "all");
    const name = passCookieName(store);
    return { get: (n: string) => (n === name ? { value: pass } : undefined) };
  };
  is("control: holding neither, the door is shut", (await access.communityViewer(await fresh(), await neither())).state, "closed");
  redis.advance(61_000);
  stripeCalls = 0;
  await access.communityViewer(await fresh(), await neither());
  is("control: and a minute later it is read again", stripeCalls > 0, true);
  done();
}

void main();
