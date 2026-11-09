/**
 * A member with two memberships bought in two checkouts (Claude 6, R43 F1 on #2985). Every checkout makes a new
 * customer on the creator's Stripe account, so one address can stand behind several customers, each holding its own
 * membership. The member's page (lib/membership-manage.ts) must list, cancel, pause and switch every one of them,
 * not only the newest customer's, or the older membership cannot be stopped from the page and keeps charging.
 * Synthetic only: the in-memory Redis double and stand-ins for Stripe and the email provider through `fetch`.
 *
 *   - The link is still proven by the inbox: only customers whose address is the one typed are in it, so a
 *     membership of another person's customer is never listed, canceled, paused or switched with it.
 *   - Customers known to hold no membership of this store are not read again by the page (no reads past need).
 *   - A customer whose list cannot be read is never "no membership": the page says it cannot list (empty list,
 *     Stripe's own page still there) and an action on a membership it may hold ends in an error, never "gone".
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { MANAGE_CUSTOMERS_MAX, MANAGE_GRANT_BYTES, grantRecord, membershipsFor, openCancel, openPortal, requestManageLink } from "@/lib/membership-manage";
import { pauseMembership } from "@/lib/membership-pause";
import { previewSwitch } from "@/lib/tier-switch";
import { POST as openRoute } from "@/app/api/store/manage/open/route";
import { addProduct, claimHandle, ensureStatsId, setPauseMonths, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const ACCOUNT = "acct_1TestHarbor0001";
const calls: { method: string; path: string; query: URLSearchParams; body: URLSearchParams }[] = [];
const emails: { to: string | string[]; text: string }[] = [];
let tierA = "";
/** A customer whose memberships list Stripe does not answer. */
let failing = "";

const sub = (id: string, customer: string, created: number) => ({
  id,
  object: "subscription",
  status: "active",
  customer,
  created,
  metadata: { store: "harbor", product: tierA },
  items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 1000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
});
/** Dana bought twice, so Stripe holds two customers for her address; a third of hers holds nothing of this store. */
const CUSTOMERS: Record<string, { id: string; created: number }[]> = {
  "dana@example.com": [
    { id: "cus_Second000001", created: 2 },
    { id: "cus_First0000001", created: 1 },
    { id: "cus_Empty0000001", created: 3 },
  ],
  "eve@example.com": [{ id: "cus_Other0000001", created: 1 }],
};
const SUBS = (): Record<string, unknown[]> => ({
  cus_First0000001: [sub("sub_First0000001", "cus_First0000001", 1)],
  cus_Second000001: [sub("sub_Second000001", "cus_Second000001", 2)],
  cus_Empty0000001: [],
  cus_Other0000001: [sub("sub_Other0000001", "cus_Other0000001", 3)],
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, query: url.searchParams, body });
  if (method === "GET" && path === "/customers") {
    // Each row with its own address, the one asked for, as Stripe's exact filter gives it (rule 23: fixture only; findMembers counts a customer only when its own address is the one typed, ignoring capitals, since manage-email-case).
    const email = url.searchParams.get("email") ?? "";
    return json({ object: "list", has_more: false, data: (CUSTOMERS[email] ?? []).map((c) => ({ ...c, email })) });
  }
  if (method === "GET" && path.startsWith("/customers/")) return json({ id: path.split("/")[2], email: "dana@example.com" });
  if (method === "GET" && path === "/subscriptions") {
    const customer = url.searchParams.get("customer") ?? "";
    if (customer === failing) return json({ error: { message: "Stripe is down" } }, 500);
    return json({ object: "list", has_more: false, data: SUBS()[customer] ?? [] });
  }
  if (method === "POST" && path === "/billing_portal/configurations") return json({ id: "bpc_Config000001" });
  if (method === "POST" && path === "/billing_portal/sessions") return json({ id: "bps_1", url: `https://billing.stripe.com/p/session/${body.get("customer")}` });
  if (method === "POST" && path === "/prices") return json({ id: "price_Tier00000001" });
  if (method === "POST" && path === "/invoices/create_preview") {
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({ total: 500, currency: "usd", starting_balance: 0, lines: { object: "list", has_more: false, data: [{ amount: 500, parent: { subscription_item_details: { proration: true } }, period: { start: at } }] } });
  }
  if (method === "POST" && path.startsWith("/subscriptions/")) return json({ id: path.split("/")[2] });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const sessions = () => calls.filter((c) => c.method === "POST" && c.path === "/billing_portal/sessions");
const listsOf = (customer: string) => calls.filter((c) => c.method === "GET" && c.path === "/subscriptions" && c.query.get("customer") === customer).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_two_customers_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", ACCOUNT, true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setPauseMonths("owner@example.com", 2);
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct("owner@example.com", "Basic", "", "10", monthly);
  const b = await addProduct("owner@example.com", "Pro", "", "20", monthly);
  if (!a.ok || !b.ok) throw new Error("no products");
  await setProductLink("owner@example.com", a.product.id, "https://example.com/basic");
  await setProductLink("owner@example.com", b.product.id, "https://example.com/pro");
  tierA = a.product.id;
  await setStoreTiers("owner@example.com", [a.product.id, b.product.id]);
  const store = (await storeForEmail("owner@example.com"))!;

  part("One link for every customer behind the address");
  is("the link is emailed", await requestManageLink({ store, email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  const token = /token=([0-9a-f]{64})/.exec(String(emails.at(-1)!.text))![1];
  const emptyBefore = listsOf("cus_Empty0000001");
  const listed = (await membershipsFor(store, token)) ?? [];
  is("both memberships are on the page, the one from the first checkout too", listed.map((m) => m.id).sort(), ["sub_First0000001", "sub_Second000001"]);
  is("a customer known to hold nothing here is not read again", listsOf("cus_Empty0000001") - emptyBefore, 0);

  part("Canceling either one");
  const first = await openCancel(store, token, "sub_First0000001", "https://marktmorgen.com");
  is("the first checkout's membership opens its cancellation page", first.ok, true);
  is("on Stripe's page for the customer who holds it", sessions().at(-1)?.body.get("customer"), "cus_First0000001");
  is("for that very membership", sessions().at(-1)?.body.get("flow_data[subscription_cancel][subscription]"), "sub_First0000001");
  const second = await openCancel(store, token, "sub_Second000001", "https://marktmorgen.com");
  is("and the second's, for its own customer", [second.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_Second000001"]);

  part("Pausing and switching either one");
  const paused = await pauseMembership(store, token, "sub_First0000001", 1);
  is("the first checkout's membership pauses", paused.ok, true);
  is("Stripe is asked to pause that one", calls.some((c) => c.method === "POST" && c.path === "/subscriptions/sub_First0000001" && c.body.get("pause_collection[behavior]") === "void"), true);
  const preview = await previewSwitch(store, token, "sub_First0000001", b.product.id);
  is("its switch is previewed", preview.ok, true);
  is("on the customer who holds it", calls.filter((c) => c.path === "/invoices/create_preview").at(-1)?.body.get("customer"), "cus_First0000001");

  part("Stripe's own page, for the customer whose membership it is");
  const portal = await openPortal(store, token, "https://marktmorgen.com", "sub_First0000001");
  is("the card and receipts of the first checkout's membership", [portal.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_First0000001"]);
  const form = new URLSearchParams({ handle: "harbor", token, subscription: "sub_First0000001" });
  const routed = await openRoute(new NextRequest("https://marktmorgen.com/api/store/manage/open", { method: "POST", body: form.toString(), headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" } }));
  is("the page's button sends which membership", [routed.status, sessions().at(-1)?.body.get("customer")], [303, "cus_First0000001"]);
  const plain = await openPortal(store, token, "https://marktmorgen.com");
  is("with none named, the newest membership's customer, as before", [plain.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_Second000001"]);

  part("Never another person's membership");
  const before = sessions().length;
  is("another address's membership is not canceled with this link", (await openCancel(store, token, "sub_Other0000001", "https://marktmorgen.com")).ok, false);
  is("nor its Stripe page opened", (await openPortal(store, token, "https://marktmorgen.com", "sub_Other0000001")).ok, false);
  is("so no page was made at Stripe for it", sessions().length, before);
  is("nor paused", (await pauseMembership(store, token, "sub_Other0000001", 1)).ok, false);
  is("nor switched", await previewSwitch(store, token, "sub_Other0000001", b.product.id), { ok: false, reason: "gone" });

  part("A customer that cannot be read is not 'no membership'");
  failing = "cus_First0000001";
  is("the page says it cannot list, never a list missing one", await membershipsFor(store, token), []);
  is("canceling a membership it may hold ends in an error", await openCancel(store, token, "sub_First0000001", "https://marktmorgen.com"), { ok: false, reason: "error" });
  is("switching it too, not 'gone'", await previewSwitch(store, token, "sub_First0000001", b.product.id), { ok: false, reason: "error" });
  const still = await openCancel(store, token, "sub_Second000001", "https://marktmorgen.com");
  is("a membership read on another customer still cancels", [still.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_Second000001"]);
  failing = "";

  part("A link made before this change");
  const old = "a".repeat(64);
  const key = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${old}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", key, JSON.stringify({ a: ACCOUNT, c: "cus_First0000001", h: "harbor" })]]);
  is("still lists its one customer's membership", ((await membershipsFor(store, old)) ?? []).map((m) => m.id), ["sub_First0000001"]);
  is("and cannot reach another customer's", (await openCancel(store, old, "sub_Second000001", "https://marktmorgen.com")).ok, false);

  part("The link's record has a declared ceiling, and past it the page says it cannot list");
  const many = Array.from({ length: MANAGE_CUSTOMERS_MAX + 5 }, (_, i) => `cus_Many${String(i).padStart(8, "0")}`);
  const capped = grantRecord(ACCOUNT, "harbor", many, false);
  is("at most MANAGE_CUSTOMERS_MAX customers, the rest said", [capped.cs?.length, capped.c, capped.m], [MANAGE_CUSTOMERS_MAX, many[0], 1]);
  const long = Array.from({ length: MANAGE_CUSTOMERS_MAX }, (_, i) => `cus_${String(i).padStart(64, "L")}`);
  const heavy = grantRecord(ACCOUNT, "harbor", long, false);
  is("never heavier than MANAGE_GRANT_BYTES, the rest said", [Buffer.byteLength(JSON.stringify(heavy)) <= MANAGE_GRANT_BYTES, (heavy.cs?.length ?? 1) < MANAGE_CUSTOMERS_MAX, heavy.m], [true, true, 1]);
  is("one customer keeps the record it always had", grantRecord(ACCOUNT, "harbor", ["cus_First0000001"], false), { a: ACCOUNT, c: "cus_First0000001", h: "harbor" });
  const past = "b".repeat(64);
  const pastKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${past}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", pastKey, JSON.stringify({ a: ACCOUNT, c: "cus_Second000001", h: "harbor", cs: ["cus_Second000001", "cus_First0000001"], m: 1 })]]);
  is("a link that may miss customers lists nothing rather than a list missing one", await membershipsFor(store, past), []);
  is("and an action on a membership not found on it is an error, not 'gone'", await previewSwitch(store, past, "sub_Other0000001", b.product.id), { ok: false, reason: "error" });
  const forged = "c".repeat(64);
  const forgedKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${forged}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", forgedKey, JSON.stringify({ a: ACCOUNT, c: "cus_First0000001", h: "harbor", cs: ["cus_Other0000001", "cus_First0000001"] })]]);
  is("a record whose customers do not start with its own is no link", await membershipsFor(store, forged), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
