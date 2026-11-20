/**
 * The reviews of #3395 (9 November 2026), read with the code itself, the in-memory database and a stand-in for the
 * creator's Stripe account:
 *
 *   R1  [MEDIUM, Claude 2] a refund question was priced at REFUND_CHECK_WAITS calls of TICKET_REFUND_READ_BYTES, but a
 *       payment plan's (lib/refunds.ts planRefundedInFull) read the invoice, its payments, up to ten payments and up to
 *       ten disputes, about 22 bodies with no ceiling of bytes. Now the community's question reads at most
 *       REFUND_CHECK_WAITS calls, each up to TICKET_REFUND_READ_BYTES; past either, the answer is not known, never "no"
 *       and never "yes".
 *   R2  [MEDIUM, Claude 6 F2] "Send me the link" made and emailed a link for an address with no purchase when the store's
 *       Stripe account refused the read (account_invalid, 400, 403, 404 are "lasting" too). Only a lasting unknown
 *       caused by the purchases' volume sends the link; a refused account mints nothing and says to write to the
 *       creator.
 *   R3  [LOW, Claude 6 F3] the lasting lines said "your purchases are more than we can check" also when the account was
 *       refused. They now name no cause, in every language.
 *   R5  [LOW-MEDIUM, Claude 2, on main] a checkout refunded in full was passed over before its customer was added, so a
 *       ticket taken in one click after it, and kept, read as "not held".
 */
import { readFileSync } from "node:fs";
import * as access from "@/lib/community-access";
import * as readRules from "@/lib/community-read-rules";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { lockedWords } from "@/lib/buyer-words/community-locked";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "cpr-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);
const read = (file: string) => readFileSync(file, "utf8");

/** Checkouts by the address they were paid from, newest first. */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** Payments by the customer they were made as. */
const intents: Record<string, Record<string, unknown>[]> = {};
/** Invoices by id, their payments by invoice id, payments by id. */
const invoices: Record<string, Record<string, unknown>> = {};
const invoicePayments: Record<string, Record<string, unknown>[]> = {};
const payments: Record<string, Record<string, unknown>> = {};
/** Characters added to every invoice and every list of disputes, to make them heavier than they may be read. */
let padding = 0;
/** The store's Stripe account refuses every request, as a disconnected one does. */
let refused = false;
/** Calls made to answer a refund question (an invoice, its payments, a payment, its disputes). */
let refundCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "email_test_1" });
  if (refused) return answer({ error: { code: "account_invalid", message: "synthetic refused account" } }, 403);
  const path = url.pathname.replace(/^\/v1/, "");
  const page = (all: Record<string, unknown>[]) => {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  };
  const pad = padding ? { description: "x".repeat(padding) } : {};
  if (path === "/checkout/sessions") return page(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  if (path === "/payment_intents") return page(intents[url.searchParams.get("customer") ?? ""] ?? []);
  refundCalls += 1;
  if (path.startsWith("/invoices/")) return answer({ ...invoices[decodeURIComponent(path.slice("/invoices/".length))], ...pad });
  if (path === "/invoice_payments") return page(invoicePayments[url.searchParams.get("invoice") ?? ""] ?? []);
  if (path.startsWith("/payment_intents/")) return answer(payments[decodeURIComponent(path.slice("/payment_intents/".length))] ?? {});
  if (path === "/disputes") return answer({ object: "list", data: [{ id: "dp_cpr1", status: "under_review" }], has_more: false, ...pad });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string, disputed = false) => ({ object: "charge", id, amount: 4900, amount_refunded: 0, refunded: false, disputed });
const refundedCharge = { object: "charge", id: "ch_cprrefunded01", amount: 4900, amount_refunded: 4900, refunded: true, disputed: false };
const paid = (n: number, product: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: `cs_test_cpr${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400 - n,
  customer: null,
  metadata: { store: "paidreview", product, ...meta },
  payment_intent: { id: `pi_cpr${n}`, object: "payment_intent", latest_charge: charge(`ch_cpr${String(n).padStart(6, "0")}`) },
  ...extra,
});
/** A payment plan's checkout: a subscription with no payment of its own; its first invoice is what counts. */
const plan = (n: number, product: string, invoice: string) =>
  paid(n, product, { mode: "subscription", payment_intent: null, invoice, subscription: { id: `sub_cpr${n}`, status: "active" } }, { kind: "plan" });
/** A first invoice paid in `count` payments, each charge marked disputed or not. */
const planInvoice = (invoice: string, count: number, disputed: boolean) => {
  invoices[invoice] = { id: invoice, object: "invoice", payment_intent: null };
  invoicePayments[invoice] = Array.from({ length: count }, (_, i) => {
    const pi = `pi_cprplan${invoice.slice(-4)}${String(i).padStart(4, "0")}`;
    payments[pi] = { id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge(`ch_cprplan${invoice.slice(-4)}${String(i).padStart(4, "0")}`, disputed) };
    return { id: `inpay_cpr${invoice.slice(-4)}${i}`, status: "paid", payment: { type: "payment_intent", payment_intent: pi } };
  });
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_paid_review_only";
  process.env.RESEND_API_KEY = "re_test_community_paid_review_only";
  await claimHandle(OWNER, "paidreview", "Paid Review", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaidRevw01", true);
  await setSubscription(OWNER, { customerId: "cus_PaidRevw0001", subscriptionId: "sub_PaidRevw0001", active: true, period: paidPeriod() });
  const made = async (title: string, price: string) => {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
    return added.product.id;
  };
  const ticket = await made("Club pass", "49");
  const other = await made("Sticker pack", "5");
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [ticket],
    spaces: [{ id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 }] as CommunityConfig["spaces"],
  };
  await saveConfig(id, config);
  const fresh = async () => {
    store = (await storeForEmail(OWNER))!;
    return store;
  };
  const rules = readRules as Record<string, unknown>;
  const waits = typeof rules.REFUND_CHECK_WAITS === "number" ? (rules.REFUND_CHECK_WAITS as number) : 0;
  const bytes = typeof rules.TICKET_REFUND_READ_BYTES === "number" ? (rules.TICKET_REFUND_READ_BYTES as number) : 64_000;
  const state = async (email: string) => {
    redis.advance(61_000);
    return access.ticketState(await fresh(), config, email);
  };

  part("R1 [MEDIUM] a payment plan's refund question reads at most what it is priced at");
  // Control: a plan paid in one payment, not disputed: the invoice, its payments and the payment, three calls.
  planInvoice("in_cprplanA001", 1, false);
  sessions["plan-one@example.com"] = [plan(1, ticket, "in_cprplanA001")];
  refundCalls = 0;
  is("control: a plan paid in one payment opens the door", await state("plan-one@example.com"), true);
  is("control: in three calls", refundCalls, 3);
  // Ten payments on the first invoice, each charge marked disputed: 1 + 1 + 10 + 10 calls asked whole on head.
  planInvoice("in_cprplanB002", 10, true);
  sessions["plan-ten@example.com"] = [plan(2, ticket, "in_cprplanB002")];
  refundCalls = 0;
  const ten = await state("plan-ten@example.com");
  is("the question makes at most REFUND_CHECK_WAITS calls", [refundCalls <= waits, waits], [true, 5]);
  is("past them the answer is not known, never 'yes' on a guess", ten, "unknown");
  const tenHoldings = await access.holdingsOf(await fresh(), config, "plan-ten@example.com");
  is("and it will stay so: write to the creator, and the link is sent (it is the purchases' volume)", [tenHoldings.whole, tenHoldings.lasting], [false, true]);
  // An invoice heavier than a refund answer may be read to.
  planInvoice("in_cprplanC003", 1, false);
  sessions["plan-heavy@example.com"] = [plan(3, ticket, "in_cprplanC003")];
  padding = bytes + 1;
  const heavy = await state("plan-heavy@example.com");
  padding = 0;
  is("an invoice past TICKET_REFUND_READ_BYTES is not known, never read whole", heavy, "unknown");
  is("control: the same invoice within the ceiling opens", await state("plan-heavy@example.com"), true);
  // A one-click addition whose charge is disputed, with a list of disputes past the ceiling.
  sessions["add-heavy@example.com"] = [paid(10, other, { customer: "cus_cprAddHeavy01" }, { upsell_key: "key10" })];
  intents.cus_cprAddHeavy01 = [{ id: "pi_cpradd10", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "paidreview", product: ticket }, latest_charge: charge("ch_cpradd000010", true) }];
  padding = bytes + 1;
  const addHeavy = await state("add-heavy@example.com");
  padding = 0;
  is("a list of disputes past the ceiling is not known either", addHeavy, "unknown");
  is("control: within it the addition opens the door", await state("add-heavy@example.com"), true);
  is("the ceiling is a named figure the registry prices from", [typeof rules.TICKET_REFUND_READ_BYTES, /import \{[^}]*TICKET_REFUND_READ_BYTES[^}]*\} from "@\/lib\/community-read-rules"/.test(read("tests/plan-cost-registry.ts"))], ["number", true]);

  part("R2 [MEDIUM] 'Send me the link' mints nothing when the store's Stripe account refuses the read");
  const links = async () => {
    const [reply] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:cm:link:*", "COUNT", "100000"]])) as [[string, string[]]];
    return reply[1].length;
  };
  redis.advance(61_000);
  refused = true;
  const before = await links();
  const asked = await access.requestCommunityLink({ store: await fresh(), email: "nobody@example.com", ip: "203.0.113.51", origin: "https://marktmorgen.com" });
  const after = await links();
  refused = false;
  is("no link is made for an address nobody could check", after - before, 0);
  is("the answer says to write to the creator, the same for every address", asked, "unchecked");
  const languages = Object.keys(COMMUNITY_WORDS) as (keyof typeof COMMUNITY_WORDS)[];
  const notices = (l: keyof typeof COMMUNITY_WORDS) => (COMMUNITY_WORDS[l] as unknown as { linkNotices: Record<string, { title?: string; body?: string } | undefined> }).linkNotices;
  is("every language says it", languages.filter((l) => !notices(l).unchecked?.title || !notices(l).unchecked?.body), []);
  is("in English: write to the creator, never 'try again'", [/write to the creator/i.test(notices("en").unchecked?.body ?? ""), /try again|moment|minute/i.test(notices("en").unchecked?.body ?? "")], [true, false]);
  // Control: the purchases' volume still sends the link (the pre-review's P3, community-paid-unknown-prerev.test.ts).
  sessions["lou@example.com"] = [...Array.from({ length: 2 * 100 + 5 }, (_, i) => paid(501 + i, other)), paid(500, ticket)];
  const louBefore = await links();
  await access.requestCommunityLink({ store: await fresh(), email: "lou@example.com", ip: "203.0.113.52", origin: "https://marktmorgen.com" });
  is("control: a lasting unknown from the purchases' volume still makes the link", (await links()) - louBefore, 1);

  part("R3 [LOW] the lasting lines name no cause that may not be the cause");
  // The old clause, in each language: "your purchases are more than we can check".
  const cause = /purchases (from \S+ )?are more|compras (en \S+ )?son más|achats (chez \S+ )?sont plus nombreux|Käufe (bei \S+ )?sind mehr|acquisti (da \S+ )?sono più|aankopen (bij \S+ )?zijn meer|compras (em \S+ )?são mais/i;
  const lasting = (l: keyof typeof COMMUNITY_WORDS) => {
    const w = COMMUNITY_WORDS[l] as unknown as {
      notices: Record<string, string>;
      unknownLastingBody: (e: string, s: string) => string;
      eventUncheckedLasting: string;
      uncheckedMoreLasting: (n: number) => string;
    };
    return [w.notices.spaceunknownlasting, w.notices.eventunknownlasting, w.unknownLastingBody("a@b.c", "Shop"), w.eventUncheckedLasting, w.uncheckedMoreLasting(2), (lockedWords(l) as unknown as Record<string, string>).uncheckedLasting];
  };
  is("no language says the purchases are too many", languages.filter((l) => lasting(l).some((t) => cause.test(t))), []);
  is("control: each English line still says to write to the creator", lasting("en").filter((t) => !/write to (the creator|Shop)/i.test(t)), []);

  part("R5 [LOW-MEDIUM] a ticket added in one click after a checkout refunded in full, and kept, is held");
  sessions["kept-add@example.com"] = [
    paid(700, other, { customer: "cus_cprKeptAdd01", payment_intent: { id: "pi_cpr700", object: "payment_intent", latest_charge: refundedCharge } }, { upsell_key: "key700" }),
  ];
  intents.cus_cprKeptAdd01 = [{ id: "pi_cpradd700", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "paidreview", product: ticket }, latest_charge: charge("ch_cpradd000700") }];
  is("the kept addition opens the door", await state("kept-add@example.com"), true);
  intents.cus_cprKeptAdd01 = [{ ...intents.cus_cprKeptAdd01[0], latest_charge: refundedCharge }];
  // The "yes" just read is kept five minutes (OPEN_SECONDS), as for every holder: forgotten, as a refund's webhook would.
  await access.forgetTicket(await fresh(), "kept-add@example.com");
  is("control: refunded too, it does not", await state("kept-add@example.com"), false);
  done();
}

void main();
