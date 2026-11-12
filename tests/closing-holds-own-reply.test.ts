/**
 * Rule 30 (from #2517): a member not held yet at a store's closing is read
 * again by id (lib/closing-holds.ts, retryHolds). A reply from Stripe that is
 * not the subscription asked for (another subscription's, or one with no id)
 * decides nothing: the member stays written down to be tried again, is never
 * dropped from the line, and no other subscription is held or written to in
 * its place. Checked against a stand-in for Stripe; nothing real is reached.
 *
 * The same holds for the rows of a list (rule 30, follow-up): an invoice
 * listed for the member that names another subscription or another customer,
 * or names none, is never voided, kept as a draft or written down as the
 * member's last payment; the member is tried again rather than counted held.
 * A subscription the store's search found that is not of the handle searched
 * is never held.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { holdCharges, paidKey, retryHolds, workKey } from "@/lib/closing-holds";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_holds_own_reply_only";

const ACCOUNT = "acct_1ClosingOwnRep";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const MEMBER = "sub_ClosingMember01";
const OTHER = "sub_ClosingOther001";
const CUSTOMER = "cus_ClosingMember1";
const HANDLE = "closing-own-reply";

/** What Stripe answers for GET /subscriptions/<MEMBER>. */
let reply: unknown = {};
const writes: string[] = [];
const reads: string[] = [];
/** What Stripe lists for GET /invoices, by status, whatever subscription was asked for. */
let lists: Record<string, Record<string, unknown>[]> = {};
/** What Stripe's search of the store's subscriptions answers. */
let found: Record<string, unknown>[] = [];
/** A whole reply given as it is, in place of a list: for GET /invoices by status, and for the search ("search"). */
const asIs = new Map<string, unknown>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    writes.push(`${method} ${path}`);
    return json({ id: path.split("/").pop() });
  }
  reads.push(path);
  if (path === `/subscriptions/${MEMBER}`) return json(reply);
  if (path === "/invoices" && asIs.has(url.searchParams.get("status") ?? "")) return json(asIs.get(url.searchParams.get("status") ?? ""));
  if (path === "/subscriptions/search" && asIs.has("search")) return json(asIs.get("search"));
  if (path === "/invoices") return json({ object: "list", data: lists[url.searchParams.get("status") ?? ""] ?? [], has_more: false });
  if (path === "/subscriptions/search") return json({ object: "search_result", data: found, has_more: false, next_page: null });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function setup() {
  redis.clear();
  writes.length = 0;
  reads.length = 0;
  lists = {};
  found = [];
  asIs.clear();
  const email = "closing-own-reply@example.com";
  await claimHandle(email, "closing-own-reply", "Closing own reply", "");
  await setStripeAccount(email, ACCOUNT, true);
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redis.pipeline([["HSET", workKey(folder), "calls", 100, `f:${MEMBER}`, "1", `m:${MEMBER}`, "member@example.com"]]);
  return { store, folder };
}

const fields = async (folder: string) => {
  const raw = await redis.run(["HKEYS", workKey(folder)]);
  return (Array.isArray(raw) ? raw.map(String) : []).sort();
};

async function main() {
  part("A reply for another subscription, not chargeable, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply with no id, not chargeable, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply for another subscription, already held, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "active", metadata: { store_hold: String(ENDED_AT) }, pause_collection: { behavior: "void" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply for another subscription, chargeable, never holds that other one");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "active", metadata: { store: "closing-own-reply" }, customer: { email: "other@example.com" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("nothing is written to Stripe for another subscription", writes, []);
    is("no invoice of another subscription is read", reads.filter((path) => path === "/invoices").length, 0);
    is("the other subscription is never written down as a member", (await fields(folder)).filter((field) => field.endsWith(OTHER)), []);
    is("the member is still to be tried again", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, 1]);
  }

  // Claude 6 on #3098: a 200 whose JSON body is null, a string or a number is not the member's reply either.
  for (const [label, body] of [["null", null], ["a string", MEMBER], ["a number", 7]] as const) {
    part(`A reply that is ${label}, not an object, never drops the member`);
    const { store, folder } = await setup();
    reply = body;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, 1]);
    is("nothing is written to Stripe and no invoice is read", [writes, reads.filter((path) => path === "/invoices").length], [[], 0]);
  }

  part("The member's own reply still decides");
  {
    const { store, folder } = await setup();
    reply = { id: MEMBER, status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("a member whose own subscription ended leaves the line", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [false, 0]);
  }
  {
    const { store, folder } = await setup();
    reply = { id: MEMBER, status: "active", metadata: { store: "closing-own-reply" }, customer: { email: "member@example.com" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("a member whose own subscription is chargeable is held", [writes.includes(`POST /subscriptions/${MEMBER}`), (await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, false, 0]);
  }

  // The member, chargeable, read again by id; its invoices are what each case lists.
  const member = { id: MEMBER, status: "active", metadata: { store: HANDLE }, customer: { id: CUSTOMER, email: "member@example.com" } };
  const PE = Math.floor(ENDED_AT / 1000) + 20 * 86_400;
  const paidInvoice = (id: string, extra: Record<string, unknown>) => ({
    id, status: "paid", amount_paid: 2_000, subtotal: 2_000, total: 2_000, currency: "usd", payment_intent: `pi_${id.slice(3)}`,
    lines: { data: [{ type: "subscription", proration: false, amount: 2_000, discount_amounts: [], period: { start: PE - 30 * 86_400, end: PE } }] },
    ...extra,
  });
  const ownOpen = { id: "in_OwnOpen00001", status: "open", subscription: MEMBER, customer: CUSTOMER };
  const ownDraft = { id: "in_OwnDraft0001", status: "draft", auto_advance: true, subscription: MEMBER, customer: CUSTOMER };
  const ownPaid = paidInvoice("in_OwnPaid00001", { subscription: MEMBER, customer: CUSTOMER });
  const paused = () => writes.includes(`POST /subscriptions/${MEMBER}`);
  const notHeld = (what: string, got: { counts: { failed: number }; keys: string[] }) =>
    is(`${what}: the member is not counted held, it is tried again`, [paused(), got.keys.includes(`f:${MEMBER}`), got.counts.failed], [false, true, 1]);

  part("An open invoice listed for the member that names another subscription is never voided");
  {
    const { store, folder } = await setup();
    lists = { open: [ownOpen, { id: "in_ForeignOpen1", status: "open", subscription: OTHER, customer: CUSTOMER }] };
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("another subscription's invoice is not voided", writes.includes("POST /invoices/in_ForeignOpen1/void"), false);
    notHeld("a list with a row of another subscription", { counts, keys: await fields(folder) });
  }

  part("An open invoice listed with no subscription, or another customer's, is never voided");
  for (const [what, row] of [
    ["no subscription", { id: "in_BareOpen00001", status: "open", customer: CUSTOMER }],
    ["another customer", { id: "in_OtherCust0001", status: "open", subscription: MEMBER, customer: "cus_SomeoneElse1" }],
    ["no customer", { id: "in_NoCustomer001", status: "open", subscription: MEMBER }],
  ] as const) {
    const { store, folder } = await setup();
    lists = { open: [row] };
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is(`an open invoice with ${what} is not voided`, writes.filter((w) => w.startsWith("POST /invoices/")), []);
    notHeld(`an open invoice with ${what}`, { counts, keys: await fields(folder) });
  }

  part("A draft listed for the member that is another subscription's is never kept as a draft");
  {
    const { store, folder } = await setup();
    lists = { draft: [ownDraft, { id: "in_ForeignDraft1", status: "draft", auto_advance: true, subscription: OTHER, customer: CUSTOMER }] };
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    const kept = await redis.run(["HGET", workKey(folder), `d:${MEMBER}`]);
    is("another subscription's draft is not written to", writes.includes("POST /invoices/in_ForeignDraft1"), false);
    is("nor written down to be let go on a release", String(kept ?? "").includes("in_ForeignDraft1"), false);
    notHeld("a draft list with a row of another subscription", { counts, keys: await fields(folder) });
  }

  part("A paid invoice listed for the member that is another subscription's, or names none, is never its last payment");
  for (const [what, rows] of [
    ["another subscription's on top", [paidInvoice("in_ForeignPaid01", { subscription: OTHER, customer: CUSTOMER }), ownPaid]],
    ["one with no subscription on top", [paidInvoice("in_BarePaid00001", { customer: CUSTOMER }), ownPaid]],
  ] as const) {
    const { store, folder } = await setup();
    lists = { paid: [...rows] };
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    const paid = await redis.run(["HGETALL", paidKey(folder)]);
    is(`with ${what}, no payment is written down for the member`, Array.isArray(paid) ? paid.length : 0, 0);
    notHeld(`a paid list with ${what}`, { counts, keys: await fields(folder) });
  }

  part("The member's own invoices are still acted on, where either API version names the subscription");
  for (const [what, open] of [
    ["on the invoice", ownOpen],
    ["under its parent", { id: "in_OwnOpenNew001", status: "open", parent: { type: "subscription_details", subscription_details: { subscription: MEMBER } }, customer: CUSTOMER }],
  ] as const) {
    const { store, folder } = await setup();
    lists = { open: [open], draft: [ownDraft], paid: [ownPaid] };
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    const paid = await redis.run(["HGET", paidKey(folder), MEMBER]);
    is(`(${what}) its open invoice is voided`, writes.includes(`POST /invoices/${open.id}/void`), true);
    is(`(${what}) its draft is kept as a draft`, [writes.includes(`POST /invoices/${ownDraft.id}`), await redis.run(["HGET", workKey(folder), `d:${MEMBER}`])], [true, ownDraft.id]);
    is(`(${what}) its last payment is written down`, typeof paid === "string" && (JSON.parse(paid) as { inv?: string }).inv, ownPaid.id);
    is(`(${what}) it is held and leaves the line`, [paused(), (await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, false, 0]);
  }

  // Claude 6 on #3098, same class: a 200 whose JSON body is null, a string, a number or an object with no rows is not
  // a list, and never an empty one: the member's open invoices would stay unvoided, its drafts would go on and its
  // last payment would not be written down, with the member counted held.
  const notLists = [["null", null], ["a string", "in_OwnOpen00001"], ["a number", 7], ["an object with no data", { object: "list", has_more: false }]] as const;
  part("An invoice list answered with something that is not a list never counts the member held");
  for (const status of ["open", "draft", "paid"] as const) {
    for (const [label, body] of notLists) {
      const { store, folder } = await setup();
      lists = { open: [ownOpen], draft: [ownDraft], paid: [ownPaid] };
      asIs.set(status, body);
      reply = member;
      const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
      notHeld(`the ${status} invoices answered with ${label}`, { counts, keys: await fields(folder) });
    }
  }

  part("The store's search answered with something that is not a list is never its last page");
  for (const [label, body] of notLists) {
    const { store, folder } = await setup();
    await redis.pipeline([["HDEL", workKey(folder), `f:${MEMBER}`, `m:${MEMBER}`]]);
    asIs.set("search", body);
    const result = await holdCharges(store, ENDED_AT, Date.now() + 10_000).catch(() => null);
    is(`a search answered with ${label}: the hold is not done, and nothing is written`, [result?.done === true, writes], [false, []]);
  }

  // Claude 6's money review of #3108 (rule 24): a page that does not say, exactly, whether there is more is not the
  // last one; done there would leave the members of the next pages never held, and their records forgotten.
  part("A search page that does not say exactly whether there is more is never the last one");
  const notSaid = [
    ["no has_more", { object: "search_result", data: [member], next_page: null }],
    ["has_more true and no next_page", { object: "search_result", data: [member], has_more: true, next_page: null }],
    ["has_more as a string", { object: "search_result", data: [member], has_more: "false", next_page: null }],
  ] as const;
  for (const [label, body] of notSaid) {
    const { store, folder } = await setup();
    await redis.pipeline([["HDEL", workKey(folder), `f:${MEMBER}`, `m:${MEMBER}`]]);
    asIs.set("search", body);
    const result = await holdCharges(store, ENDED_AT, Date.now() + 10_000).catch(() => null);
    is(`a search page with ${label}: the hold is not done`, result?.done === true, false);
  }

  // Claude 4's money review of #3108 (LEVE 1): a row of the search that cannot be read at all is not "of another
  // store"; skipping it as such would answer done with that member never held.
  part("A search row that is not an object is never skipped as another store's");
  for (const [label, row] of [["null", null], ["a string", "sub_SearchString01"], ["a number", 7]] as const) {
    const { store, folder } = await setup();
    await redis.pipeline([["HDEL", workKey(folder), `f:${MEMBER}`, `m:${MEMBER}`]]);
    found = [member, row as unknown as Record<string, unknown>];
    const result = await holdCharges(store, ENDED_AT, Date.now() + 10_000).catch(() => null);
    is(`a search row that is ${label}: the hold is not done`, result?.done === true, false);
  }

  part("A subscription the store's search found that is not of the handle searched is never held");
  {
    const { store, folder } = await setup();
    await redis.pipeline([["HDEL", workKey(folder), `f:${MEMBER}`, `m:${MEMBER}`]]);
    const FOREIGN = "sub_SearchForeign1";
    const BARE = "sub_SearchBare0001";
    found = [
      member,
      { id: FOREIGN, status: "active", metadata: { store: "another-store" }, customer: { id: "cus_Foreign00001", email: "foreign@example.com" } },
      { id: BARE, status: "active", metadata: {}, customer: { id: "cus_Bare00000001", email: "bare@example.com" } },
    ];
    const result = await holdCharges(store, ENDED_AT, Date.now() + 10_000);
    const keys = await fields(folder);
    is("a subscription of another handle is never written to", writes.filter((w) => w.includes(FOREIGN) || w.includes(BARE)), []);
    is("nor its invoices read", reads.filter((r) => r === "/invoices").length, 3);
    is("nor written down as a member", keys.filter((k) => k.endsWith(FOREIGN) || k.endsWith(BARE)), []);
    is("the store's own member is held", [writes.includes(`POST /subscriptions/${MEMBER}`), result.done, result.failed], [true, true, 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
