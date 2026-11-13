/**
 * Mutation testing of lib/checkout-recovery.ts (Claude 7, 13/11/2026): each
 * case kills a mutant that survived the tests importing the module. A reminder
 * about a checkout left unpaid goes out up to exactly six hours after it
 * closed, never before it closed, to the address the buyer typed or the one
 * the checkout carried, and never to somebody who paid for it since in this
 * store (as the product or as a box ticked beside another). A product hidden
 * since, or a checkout still open, is never written about.
 *
 * Synthetic only: Stripe and the sender are stand-ins for fetch, Redis is
 * tests/redis-stub.ts.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductHidden, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { REMIND_WITHIN_SECONDS, remindAbandoned, remindAsked, remindAssisted } from "@/lib/checkout-recovery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_mutants_only";
// A stand-in key from tests/resend-fixture-credentials.ts, shared with the other reminder tests.
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

const OWNER = "printer@example.com";
const emails: string[] = [];
let paid: Record<string, unknown>[] = [];
let asked: URLSearchParams | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    emails.push([body.to].flat()[0]);
    return answer({ id: `email_${emails.length}` });
  }
  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    asked = url.searchParams;
    return answer({ object: "list", data: paid, has_more: false });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "printworks", "Print Works", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrint00001", true);
  await setSubscription(OWNER, { customerId: "cus_Print00001", subscriptionId: "sub_Print00001", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Press Lane, Portland, OR 97201", asks: true });
  const made = await addProduct(OWNER, "Signed Print", "", "40", null);
  const other = await addProduct(OWNER, "Poster", "", "20", null);
  if (!made.ok || !other.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/print");
  await setProductLink(OWNER, other.product.id, "https://example.com/poster");
  const print = made.product.id;
  const load = async () => (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const left = (over: Record<string, unknown> = {}) =>
    ({
      id: `cs_test_mutantsrecovery${String(++n).padStart(4, "0")}`,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email: `left${n}@example.com` },
      metadata: { store: "printworks", product: print },
      ...over,
    }) as never;
  const remind = async (session: never, at = now) => {
    const before = emails.length;
    const outcome = await remindAbandoned(await load(), session, at);
    return [outcome, emails.slice(before)];
  };

  part("When a reminder goes out");
  const closedAt = now - 50;
  is("exactly six hours after it closed: still sent", (await remind(left({ expires_at: closedAt }), closedAt + REMIND_WITHIN_SECONDS))[0], "sent");
  is("one second more: not", (await remind(left({ expires_at: closedAt }), closedAt + REMIND_WITHIN_SECONDS + 1))[0], "skip");
  is("at the second it closed: sent", (await remind(left({ expires_at: closedAt }), closedAt))[0], "sent");
  is("before it closed: not", (await remind(left({ expires_at: closedAt }), closedAt - 1))[0], "skip");
  is("a checkout still open: not", (await remind(left({ status: "open" })))[0], "skip");

  part("To whom");
  is("the address the checkout carried, when none was typed", await remind(left({ customer_details: null, customer_email: "carried@example.com" })), ["sent", ["carried@example.com"]]);
  is("no address at all: not", (await remind(left({ customer_details: null })))[0], "skip");

  part("Never to somebody who paid since");
  const created = now - 3700;
  await remind(left({ created }));
  is("payments looked for from when the checkout opened", asked?.get("created[gte]"), String(created));
  await remind(left({ created: undefined, expires_at: closedAt }));
  is("an undated checkout: from an hour before it closed", asked?.get("created[gte]"), String(closedAt - 3600));
  const bought = (over: Record<string, unknown>) => ({ id: "cs_paid", status: "complete", payment_status: "paid", metadata: { store: "printworks", product: print }, ...over });
  paid = [bought({})];
  is("paid for it here since: not", (await remind(left()))[0], "skip");
  paid = [bought({ metadata: { store: "printworks", product: other.product.id, bump: print } })];
  is("paid for it as a box ticked beside another: not", (await remind(left()))[0], "skip");
  paid = [bought({ metadata: { store: "elsewhere", product: print } })];
  is("paid for something of the same id in another store: still sent", (await remind(left()))[0], "sent");
  paid = [bought({ payment_status: "unpaid" })];
  is("a checkout completed but not paid: still sent", (await remind(left()))[0], "sent");
  paid = [bought({ metadata: { store: "printworks", product: other.product.id } })];
  is("paid for something else here: still sent", (await remind(left()))[0], "sent");
  paid = [bought({ metadata: { store: "printworks" } })];
  is("a payment naming no product: still sent", (await remind(left()))[0], "sent");
  paid = [];

  part("A product hidden since, or a store without its address");
  const store = await load();
  is("asked for, nothing named: not", await remindAsked(store, { productId: "", email: "asked@example.com", askedAt: now - 3600, key: "kmut2" }), "skip");
  is("the assistant's, a checkout still open: not", await remindAssisted(store, left({ status: "open" }), { email: "assisted@example.com", why: "You asked for this reminder." }), "skip");
  is("the assistant's, no postal address: not", await remindAssisted({ ...store, recovery: { ...store.recovery, address: "" } } as never, left(), { email: "assisted@example.com", why: "You asked for this reminder." }), "skip");
  is("the assistant's, otherwise sent", await remindAssisted(store, left(), { email: "assisted2@example.com", why: "You asked for this reminder." }), "sent");
  await setProductHidden(OWNER, print, true);
  is("the product hidden: not", await remindAbandoned(await load(), left(), now), "skip");
  is("asked for, the product hidden: not", await remindAsked(await load(), { productId: print, email: "asked@example.com", askedAt: now - 3600, key: "kmut1" }), "skip");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
