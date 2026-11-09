/**
 * A member who typed their address with capitals in one checkout and without in another (Claude 5, the residue of
 * R43 F1 on #2985). Stripe's hosted checkout keeps the address as typed on the customer it makes, and the `email`
 * filter of Stripe's customer list is case-sensitive, so "Ana@Example.com" and "ana@example.com" are two customers
 * that one exact read never finds together: the member's page missed one membership, which kept charging.
 * Synthetic only: the in-memory Redis double and stand-ins for Stripe and the email provider through `fetch`; the
 * Stripe stand-in filters by email exactly, as Stripe does.
 *
 *   - The link reads the address as typed and in small letters (two exact reads, never a sweep of the account),
 *     and holds every customer of either that holds a membership of this store, within MANAGE_CUSTOMERS_MAX.
 *   - An address typed in small letters already is read once: no read past need.
 *   - Identity: only customers whose own address is the one typed, ignoring capitals, are in the link. A row of
 *     another address proves nothing (fail closed: the page says it cannot list) and is never reachable.
 *   - Unknown stays unknown: a list that cannot be read is "error", never "sent" without an email or "gone".
 */
import { MANAGE_CUSTOMERS_MAX, membershipsFor, openCancel, openPortal, requestManageLink } from "@/lib/membership-manage";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const ACCOUNT = "acct_1TestHarbor0001";
const calls: { method: string; path: string; query: URLSearchParams; body: URLSearchParams }[] = [];
const emails: { to: string | string[]; text: string }[] = [];
let product = "";
/** An address whose customers list Stripe does not answer. */
let failingEmail = "";

const sub = (id: string, customer: string, created: number) => ({
  id,
  object: "subscription",
  status: "active",
  customer,
  created,
  metadata: { store: "harbor", product },
  items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 1000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
});
const customer = (id: string, email: string, created: number) => ({ id, object: "customer", email, created });
/** Many customers of one address, each holding one membership (the ceiling's case). */
const many = (prefix: string, email: string, n: number) => Array.from({ length: n }, (_, i) => customer(`cus_${prefix}${String(i).padStart(8, "0")}`, email, 100 + i));

/** Customers as Stripe holds them, filtered by `email` exactly (case-sensitive), as Stripe does. */
const CUSTOMERS: ReturnType<typeof customer>[] = [
  customer("cus_Upper0000001", "Ana@Example.com", 1),
  customer("cus_Lower0000001", "ana@example.com", 2),
  customer("cus_Bob000000001", "bob@example.com", 1),
  ...many("Gil", "Gil@Example.com", 15),
  ...many("gil", "gil@example.com", 15),
];
/** A row Stripe would never give for this filter: another person's address. The page must never reach it. */
let stray: ReturnType<typeof customer> | null = null;
const SUBS: Record<string, unknown[]> = {
  cus_Upper0000001: [sub("sub_Upper0000001", "cus_Upper0000001", 1)],
  cus_Lower0000001: [sub("sub_Lower0000001", "cus_Lower0000001", 2)],
  cus_Bob000000001: [sub("sub_Bob000000001", "cus_Bob000000001", 3)],
  cus_Mallory00001: [sub("sub_Mallory00001", "cus_Mallory00001", 4)],
};

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
    const email = url.searchParams.get("email") ?? "";
    if (email === failingEmail) return json({ error: { message: "Stripe is down" } }, 500);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const found = CUSTOMERS.filter((c) => c.email === email).sort((x, y) => y.created - x.created);
    const rows = stray && email === "eve@example.com" ? [...found, stray] : found;
    return json({ object: "list", has_more: rows.length > limit, data: rows.slice(0, limit) });
  }
  if (method === "GET" && path === "/subscriptions") {
    const id = url.searchParams.get("customer") ?? "";
    const own = SUBS[id] ?? (/^cus_(Gil|gil)/.test(id) ? [sub(`sub_${id.slice(4)}`, id, 5)] : []);
    return json({ object: "list", has_more: false, data: own });
  }
  if (method === "POST" && path === "/billing_portal/configurations") return json({ id: "bpc_Config000001" });
  if (method === "POST" && path === "/billing_portal/sessions") return json({ id: "bps_1", url: `https://billing.stripe.com/p/session/${body.get("customer")}` });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const sessions = () => calls.filter((c) => c.method === "POST" && c.path === "/billing_portal/sessions");
const customerReads = () => calls.filter((c) => c.method === "GET" && c.path === "/customers");
const subReads = () => calls.filter((c) => c.method === "GET" && c.path === "/subscriptions").length;
const tokenOf = (text: string) => /token=([0-9a-f]{64})/.exec(text)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_email_case_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", ACCOUNT, true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  const store = (await storeForEmail("owner@example.com"))!;
  const ask = (email: string, ip = "203.0.113.9") => requestManageLink({ store, email, ip, origin: "https://marktmorgen.com" });

  part("An address typed with capitals reaches the customer of either spelling");
  let reads = customerReads().length;
  is("the link is emailed", await ask("Ana@Example.com"), "sent");
  is("to the address in small letters, as before", [emails.at(-1)?.to].flat(), ["ana@example.com"]);
  const token = tokenOf(String(emails.at(-1)?.text));
  const asked = customerReads().slice(reads).map((c) => c.query.get("email")).sort();
  is("Stripe is asked for the address as typed and in small letters, nothing else", asked, ["Ana@Example.com", "ana@example.com"]);
  is("each read within the one page of customers", customerReads().slice(reads).every((c) => Number(c.query.get("limit")) <= MANAGE_CUSTOMERS_MAX), true);
  const listed = ((await membershipsFor(store, token)) ?? []).map((m) => m.id).sort();
  is("both memberships are on the page, the one bought with capitals too", listed, ["sub_Lower0000001", "sub_Upper0000001"]);
  const upper = await openCancel(store, token, "sub_Upper0000001", "https://marktmorgen.com");
  is("the capitals checkout's membership opens its cancellation page, on its own customer", [upper.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_Upper0000001"]);
  const lower = await openCancel(store, token, "sub_Lower0000001", "https://marktmorgen.com");
  is("and the other one's, on its own", [lower.ok, sessions().at(-1)?.body.get("customer")], [true, "cus_Lower0000001"]);
  is("another person's membership is still not reachable", (await openCancel(store, token, "sub_Bob000000001", "https://marktmorgen.com")).ok, false);

  part("An address typed in small letters is read once");
  reads = customerReads().length;
  is("the link is emailed", await ask("ana@example.com", "203.0.113.10"), "sent");
  is("one read of customers, no read past need", customerReads().slice(reads).map((c) => c.query.get("email")), ["ana@example.com"]);
  const small = tokenOf(String(emails.at(-1)?.text));
  is("its membership is on the page", ((await membershipsFor(store, small)) ?? []).map((m) => m.id), ["sub_Lower0000001"]);

  part("Identity: only customers of the address typed, ignoring capitals");
  stray = customer("cus_Mallory00001", "mallory@example.com", 9);
  SUBS.cus_Eve000000001 = [sub("sub_Eve000000001", "cus_Eve000000001", 1)];
  CUSTOMERS.push(customer("cus_Eve000000001", "eve@example.com", 1));
  is("the link is emailed for Eve", await ask("Eve@Example.com", "203.0.113.11"), "sent");
  const eve = tokenOf(String(emails.at(-1)?.text));
  const eveListed = ((await membershipsFor(store, eve)) ?? []).map((m) => m.id);
  is("a customer of another address is never listed", eveListed.includes("sub_Mallory00001"), false);
  const before = sessions().length;
  is("nor canceled with the link", (await openCancel(store, eve, "sub_Mallory00001", "https://marktmorgen.com")).ok, false);
  is("nor its Stripe page opened", (await openPortal(store, eve, "https://marktmorgen.com", "sub_Mallory00001")).ok, false);
  is("so no Stripe page was made for that customer", sessions().slice(before).some((s) => s.body.get("customer") === "cus_Mallory00001"), false);
  is("and the page says it cannot list rather than show a list that read a row it could not trust", eveListed, []);
  stray = null;

  part("Within the same ceiling, never a sweep of the account");
  reads = customerReads().length;
  const subsBefore = subReads();
  is("the link is emailed for Gil", await ask("Gil@Example.com", "203.0.113.12"), "sent");
  is("two reads of customers, each one page", customerReads().slice(reads).map((c) => [c.query.get("email"), Number(c.query.get("limit")) <= MANAGE_CUSTOMERS_MAX]).sort(), [["Gil@Example.com", true], ["gil@example.com", true]]);
  is("at most MANAGE_CUSTOMERS_MAX lists of memberships read for the link, both spellings together", subReads() - subsBefore <= MANAGE_CUSTOMERS_MAX, true);
  const gil = tokenOf(String(emails.at(-1)?.text));
  is("past the ceiling the page says it cannot list, never a list missing one", await membershipsFor(store, gil), []);

  part("Unknown stays unknown");
  failingEmail = "ana@example.com";
  const sentBefore = emails.length;
  // requestManageLink throws and the route answers status=error, as for one list in another shape (manage-links-unknown).
  is("one spelling that cannot be read is an error, never 'sent'", await ask("Ana@Example.com", "203.0.113.13").catch(() => "error"), "error");
  is("and no email leaves", emails.length, sentBefore);
  failingEmail = "";
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
