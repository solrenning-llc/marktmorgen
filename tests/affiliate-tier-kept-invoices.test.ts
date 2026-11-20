/**
 * #3485 merged with #3378 (main's kept invoices): the second tier of a renewal is decided when its invoice is read
 * (tierOfInvoice) and kept with it, so a renewal whose buyer is not known still waits when the book reads it from the
 * kept invoices, not only on the reading that fetched it from Stripe; a renewal bought by the recruit's inviter keeps
 * its tier off. A record kept before the tier was kept does not read, so the invoices are read again from Stripe,
 * never shown with a second tier nobody decided. Synthetic only: the in-memory Redis double and a fake Stripe.
 */
import { readBook, TIER_BUYER_FROM } from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_kept";
process.env.RESEND_API_KEY = "re_test_tier_kept";

const OWNER = "chef@example.com";
const ACCOUNT = "acct_1TierKept01";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

let invoices: Record<string, unknown>[] = [];
let invoiceReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (path === "/invoices") {
    invoiceReads += 1;
    return answer({ object: "list", data: invoices, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

const invoice = (id: string, email: string | null) => ({
  id, status: "paid", billing_reason: "subscription_cycle", amount_paid: 5_000, currency: "usd", ...(email ? { customer_email: email } : {}),
  created: NOW - 900, status_transitions: { paid_at: NOW - 900 }, total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", product: "prod01", via: BEA, via_rate: "30", kind: "plan" } } },
  payments: { object: "list", has_more: false, data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});

/** One kept line as main's record keeps it (lib/affiliates.ts, KeptLine), with or without the tier at its end. */
const keptLine = (id: string, tier?: number) => [id, `pi_${id}`, BEA, NOW - 900, NOW - 900, "prod01", 5_000, 5_000, "usd", 30, 0, null, ...(tier === undefined ? [] : [tier])];

async function setup(lines: unknown[][] | null) {
  redis.clear();
  invoices = [];
  invoiceReads = 0;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  if (lines) {
    // What a reading too long for its pages left kept: fresh (no rebuild due), whole, up to a minute ago.
    const keep = { v: 1, account: ACCOUNT, handles: "harbor", since: NOW - 400 * DAY, kept: { lines, unlinked: [], whole: true, top: NOW - 60, at: NOW - 60 }, walk: null, over: null };
    await redis.pipeline([["SET", `nl:aff:${statsId}:invoices`, JSON.stringify(keep)]]);
  }
  return store;
}
type Store = Awaited<ReturnType<typeof setup>>;
const flagged = (l: unknown) => (l as { unconfirmed?: number } | undefined)?.unconfirmed === 1;
const line = async (store: Store, ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);
const payable = async (store: Store, id: string) => (await readBook(store)).rows.find((r) => r.affiliate.id === id)?.payable;

async function main(): Promise<void> {
  is("(fixture: the invoices count from TIER_BUYER_FROM)", NOW - 900 >= TIER_BUYER_FROM, true);

  part("a renewal with no buyer's address, read from the kept invoices, still waits");
  {
    const store = await setup([keptLine("in_Kept000001", 2 + 4)]);
    const tier = await line(store, "tier2:in_Kept000001");
    is("its second tier is marked waiting", flagged(tier), true);
    is("its first tier is held as unconfirmed too", flagged(await line(store, "in_Kept000001")), true);
    is("the inviter is paid nothing automatically", await payable(store, ANA), 0);
  }

  part("a renewal bought by the recruit's inviter, read from the kept invoices, keeps its tier off");
  {
    const store = await setup([keptLine("in_Kept000002", 1)]);
    is("no second tier is shown for it", await line(store, "tier2:in_Kept000002"), undefined);
    is("the inviter is paid nothing on it", await payable(store, ANA), 0);
  }

  part("a renewal decided earning keeps earning from the kept invoices");
  {
    const store = await setup([keptLine("in_Kept000003", 0)]);
    const tier = await line(store, "tier2:in_Kept000003");
    is("its second tier earns", [flagged(tier), tier?.status], [false, "earned"]);
  }

  part("a record kept before the tier was kept is read again from Stripe, never shown undecided");
  {
    const store = await setup([keptLine("in_Kept000004")]);
    invoices = [invoice("in_Kept000004", null)];
    const tier = await line(store, "tier2:in_Kept000004");
    is("the invoices were read again from Stripe", invoiceReads > 0, true);
    is("its second tier waits, as read from the invoice", flagged(tier), true);
    is("the inviter is paid nothing automatically", await payable(store, ANA), 0);
  }

  part("a tier mark no reading writes does not read either");
  {
    const store = await setup([keptLine("in_Kept000005", 2)]);
    invoices = [invoice("in_Kept000005", null)];
    const tier = await line(store, "tier2:in_Kept000005");
    is("read again from Stripe", invoiceReads > 0, true);
    is("and waits, as the invoice says", flagged(tier), true);
  }
  done();
}

void main();
