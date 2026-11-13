/**
 * #3970, decision ALL-160: a place an unpaid checkout holds in the store's order
 * figure (lib/order-admission.ts) is given back when that checkout expires, never
 * kept past it; a paid one is never given back this way.
 *
 * Before: every opened checkout held a place for OPEN_HOURS (25 h) whatever became
 * of it, so checkouts opened and left unpaid could fill every place and pause all
 * of a store's sales for a day. There is no incoming Stripe webhook: the five-minute
 * sweep (lib/checkout-sweep.ts) reads the store's expired checkouts from the
 * creator's own Stripe account, and now gives their places back, once each.
 *
 * Runs the real admitOrders and sweepCheckouts on the in-memory Redis, with a
 * stand-in for Stripe's list of Checkout Sessions. Synthetic data only.
 */
import { ADMITTED_FIELD, admitOrders } from "@/lib/order-admission";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

type Session = Record<string, unknown> & { id: string; created: number; status: string };
let sessions: Session[] = [];

function listSessions(url: URL): Response {
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
    if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1TestHoldSwp1", country: "US" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "abandoned-hold@example.com";
const HANDLE = "abandonedhold";
let product = "";

/** A paying store on the smallest plan, with no reminders and no list: only its counted orders read expired checkouts. */
async function freshStore(): Promise<Store> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  sessions = [];
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHoldSwp1", true);
  await setSubscription(OWNER, { customerId: "cus_HoldSweep1", subscriptionId: "sub_HoldSweep1", active: true, tier: "creator", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  product = course.product.id;
  await setProductLink(OWNER, product, "https://example.com/course");
  const store = await storeForEmail(OWNER);
  if (!store) throw new Error("no store");
  return store;
}

const seconds = () => Math.floor(Date.now() / 1000);
const sid = (prefix: string, n: number) => `cs_test_${prefix}${String(n).padStart(12, "0")}`;
const expired = (id: string, created: number, hour: number | null, over: Record<string, unknown> = {}): Session => ({
  id, object: "checkout.session", status: "expired", payment_status: "unpaid", mode: "payment",
  created, expires_at: created + 1800,
  metadata: { store: HANDLE, product, ...(hour === null ? {} : { [ADMITTED_FIELD]: String(hour) }) },
  ...over,
});

/** Fills every place of the month with checkouts admitted at `at` (ms), and answers their hour. */
async function fill(store: Store, count: number, at = Date.now()): Promise<number> {
  let hour = -1;
  for (let i = 0; i < count; i += 1) {
    const admitted = await admitOrders(store, 1, at);
    if (!admitted.ok || admitted.hour === null) throw new Error(`checkout ${i} was not admitted: ${JSON.stringify(admitted)}`);
    hour = admitted.hour;
  }
  return hour;
}

async function sweep(): Promise<void> {
  await sweepCheckouts(Date.now() + 20_000);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_abandoned_hold_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_abandoned_hold_only_a_stand_in";
  const limit = ORDERS_INCLUDED.creator;

  part("Checkouts left unpaid give their places back once Stripe closes them");
  let store = await freshStore();
  let hour = await fill(store, limit);
  is("every place is held: the next checkout is refused", await admitOrders(store, 1), { ok: false, reason: "paused" });
  sessions = Array.from({ length: limit }, (_, i) => expired(sid("left", i), seconds() - 3600 - i, hour));
  await sweep();
  let opened = 0;
  for (let i = 0; i < limit; i += 1) if ((await admitOrders(store, 1)).ok) opened += 1;
  is("after the sweep reads them closed unpaid, every place opens again", opened, limit);
  is("and the figure still holds past them", await admitOrders(store, 1), { ok: false, reason: "paused" });

  part("Only an unpaid checkout of this store with a held hour gives a place back, and only once");
  store = await freshStore();
  hour = await fill(store, limit);
  sessions = [
    expired(sid("mine", 1), seconds() - 3600, hour),
    expired(sid("other", 1), seconds() - 3600, hour, { metadata: { store: "someoneelse", product, [ADMITTED_FIELD]: String(hour) } }),
    expired(sid("paid", 1), seconds() - 3600, hour, { payment_status: "paid" }),
    expired(sid("nohour", 1), seconds() - 3600, null),
  ];
  await sweep();
  is("one place opens", (await admitOrders(store, 1)).ok, true);
  is("and only one", await admitOrders(store, 1), { ok: false, reason: "paused" });
  await sweep();
  await sweep();
  is("reading the same closed checkouts again gives nothing back twice", await admitOrders(store, 1), { ok: false, reason: "paused" });

  part("A checkout left at Stripe's default, closed a day after it opened, still gives its place back");
  store = await freshStore();
  const dayAgo = Date.now() - (24 * 3600 + 600) * 1000;
  hour = await fill(store, 1, dayAgo);
  await fill(store, limit - 1);
  is("every place is held", await admitOrders(store, 1), { ok: false, reason: "paused" });
  sessions = [expired(sid("dayold", 1), Math.floor(dayAgo / 1000), hour, { expires_at: Math.floor(dayAgo / 1000) + 86_400 })];
  await sweep();
  is("its place opens once the sweep reads it closed", (await admitOrders(store, 1)).ok, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
