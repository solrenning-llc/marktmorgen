/**
 * The five-minute checkout sweep (lib/checkout-sweep.ts) is the only net, besides
 * the thanks page, that confirms a paid order whose buyer closed the tab: there is
 * no incoming Stripe webhook. It must read every paid checkout of the last day,
 * not only the newest few hundred sessions of every kind. Found by the Stripe list
 * audit of 9 November 2026 (A2): 300 expired checkouts in the last hour pushed a
 * paid order of two hours ago off the pages the sweep read, run after run, so its
 * buyer got no confirmation, was never put on the creator's list, and no affiliate
 * or ad platform heard of the sale. The same pages fed the abandoned-checkout
 * reminders, which a crowd of open checkouts (a launch, or bots) hid the same way.
 *
 * The stand-in for Stripe answers GET /v1/checkout/sessions as Stripe does:
 * newest first, `limit`, `created[gte]`, `status` and `starting_after` honored,
 * and an unknown `starting_after` refused.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { confirmationKey } from "@/lib/purchase-email";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

type Session = Record<string, unknown> & { id: string; created: number; status: string };
let sessions: Session[] = [];
const listCalls: string[] = [];

function listSessions(url: URL): Response {
  listCalls.push(url.search);
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 10));
  const status = url.searchParams.get("status");
  const since = Number(url.searchParams.get("created[gte]") ?? 0);
  const after = url.searchParams.get("starting_after");
  const order = (a: Session, b: Session) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const all = [...sessions].sort(order);
  let rows = all.filter((row) => row.created >= since && (!status || row.status === status));
  if (after) {
    const anchor = all.find((row) => row.id === after);
    if (!anchor) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `No such checkout.session: '${after}'` } }), { status: 400 });
    rows = rows.filter((row) => order(anchor, row) < 0);
  }
  return new Response(JSON.stringify({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit }));
}

const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return listSessions(url);
    if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1TestCompSwp1", country: "US" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "complete-sweep@example.com";
const HANDLE = "completesweep";
let product = "";

async function freshStore(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  sessions = [];
  listCalls.length = 0;
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCompSwp1", true);
  await setSubscription(OWNER, { customerId: "cus_CompSweep1", subscriptionId: "sub_CompSweep1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  product = course.product.id;
  await setProductLink(OWNER, product, "https://example.com/course");
  await storeForEmail(OWNER);
}

const now = () => Math.floor(Date.now() / 1000);
const sid = (prefix: string, n: number) => `cs_test_${prefix}${String(n).padStart(12, "0")}`;
const paid = (id: string, email: string, created: number, store = HANDLE): Session => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
  created, amount_total: 4900, currency: "usd",
  customer_details: { email }, metadata: { store, product },
});
const expired = (id: string, created: number, over: Record<string, unknown> = {}): Session => ({
  id, object: "checkout.session", status: "expired", payment_status: "unpaid", mode: "payment",
  created, expires_at: created + 1800, metadata: { store: HANDLE, product }, ...over,
});
const open = (id: string, created: number): Session => ({
  id, object: "checkout.session", status: "open", payment_status: "unpaid", mode: "payment",
  created, expires_at: created + 86_400, metadata: { store: HANDLE, product },
});
const confirmations = (to: string) => mail.ses.filter((m) => m.to.includes(to)).length;

async function passes(n: number): Promise<{ confirmed: number; reminded: number }> {
  const total = { confirmed: 0, reminded: 0 };
  for (let i = 0; i < n; i += 1) {
    const counts = await sweepCheckouts(Date.now() + 20_000);
    total.confirmed += counts.confirmed;
    total.reminded += counts.reminded;
  }
  return total;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_complete_sweep_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_complete_sweep_only_a_stand_in";

  part("A paid order behind 300 newer expired checkouts is still confirmed (audit A2)");
  await freshStore();
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => expired(sid("lateexp", i), now() - 60 - i * 10)),
    paid(sid("latepaid", 1), "tab-closed@example.com", now() - 7200),
  ];
  let said = await passes(3);
  is("after three runs its buyer has had the confirmation, once", [confirmations("tab-closed@example.com"), said.confirmed], [1, 1]);

  part("The control: 299 newer expired checkouts");
  await freshStore();
  sessions = [
    ...Array.from({ length: 299 }, (_, i) => expired(sid("ctrlexp", i), now() - 60 - i * 10)),
    paid(sid("ctrlpaid", 1), "control@example.com", now() - 7200),
  ];
  said = await passes(3);
  is("confirmed once", [confirmations("control@example.com"), said.confirmed], [1, 1]);

  part("A paid order behind 300 newer open checkouts (a launch, or bots) is confirmed");
  await freshStore();
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => open(sid("botopen", i), now() - 30 - i * 5)),
    paid(sid("botpaid", 1), "behind-bots@example.com", now() - 3600),
  ];
  said = await passes(3);
  is("confirmed once", [confirmations("behind-bots@example.com"), said.confirmed], [1, 1]);

  part("A paid order behind 300 newer paid orders already confirmed is confirmed too, within a few runs");
  await freshStore();
  const newer = Array.from({ length: 300 }, (_, i) => paid(sid("donepaid", i), `done${i}@example.com`, now() - 60 - i * 20, "elsewhere"));
  for (const row of newer) await redis.pipeline([["SET", confirmationKey(row.id), "1"]]);
  sessions = [...newer, paid(sid("oldpaid", 1), "oldest-of-the-day@example.com", now() - 20 * 3600)];
  said = await passes(3);
  is("confirmed once", [confirmations("oldest-of-the-day@example.com"), said.confirmed], [1, 1]);
  said = await passes(3);
  is("and never again on later runs", [confirmations("oldest-of-the-day@example.com"), said.confirmed], [1, 0]);

  part("An abandoned checkout's reminder is not hidden by 300 newer open checkouts (the same pages)");
  await freshStore();
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Portland, OR 97201", asks: true });
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => open(sid("remopen", i), now() - 30 - i * 5)),
    expired(sid("remleft", 1), now() - 5400, { consent: { promotions: "opt_in" }, customer_details: { email: "left-it@example.com" }, expires_at: now() - 3600 }),
  ];
  said = await passes(3);
  is("the buyer who agreed gets the one reminder", [confirmations("left-it@example.com"), said.reminded], [1, 1]);

  part("Nor by 300 newer expired checkouts of buyers who did not agree");
  await freshStore();
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Portland, OR 97201", asks: true });
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => expired(sid("remexp", i), now() - 60 - i * 10)),
    expired(sid("remleft", 2), now() - 9000, { consent: { promotions: "opt_in" }, customer_details: { email: "left-too@example.com" }, expires_at: now() - 7200 }),
  ];
  said = await passes(3);
  is("the buyer who agreed gets the one reminder", [confirmations("left-too@example.com"), said.reminded], [1, 1]);

  done();
}

void main();
