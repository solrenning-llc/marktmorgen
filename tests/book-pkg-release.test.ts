/**
 * app/api/store/book, the "pkg-used" branch: a failed release still closes the checkout (Claude 6, 06/11/2026).
 *
 * A session from a package is held and its free checkout opened; then
 * holdSession says the package's last session went to another tab meanwhile,
 * the route releases its own hold and answers "pkg-used". The route used to
 * call releaseOwnHold(...).catch(() => {}), and releaseOwnHold swallowed
 * Stripe's failure: when the release's Redis read (HGETALL) failed, the
 * checkout was never expired, and when Stripe's expire failed nothing said so.
 * The free checkout stayed open for up to 31 minutes and the slot held for
 * about 32 (LOW; proof tests/book-pkg-release.proof.ts on
 * claude6/book-pkg-release-proof @ 685e40f7).
 *
 * Here, with the release failing at its Redis read, its Redis write or Stripe's
 * expire, and a control where it succeeds:
 *   - the checkout this request opened is always asked to expire at Stripe,
 *     even when the busy hash could not be read (its id is known: this
 *     request opened it);
 *   - every failure is logged (console.error), never swallowed quietly;
 *   - the control is unchanged: expired at Stripe, slot let go, nothing logged;
 *   - the buyer is never handed the checkout and it is not counted on the package.
 * Real route, real lib/calls.ts and lib/call-packages.ts, the Redis stand-in and a
 * Stripe stand-in; synthetic data, no network.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/book/route";
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { holdSession, packageState, readBought, recordPackage } from "@/lib/call-packages";
import { type CallListing } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { CHECKOUT_OPEN_SECONDS } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const NY = "America/New_York";
const PAID = `cs_test_${"q".repeat(24)}`;
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

// ---- What is logged ---------------------------------------------------------
const logged: string[] = [];
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
};

// ---- Stripe stand-in -------------------------------------------------------
type Opened = { id: string; url: string; body: URLSearchParams; status: "open" | "expired" | "complete" };
const opened = new Map<string, Opened>();
const expires: string[] = [];
let expireFails = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/coupons") return answer({ id: `co_Session${opened.size + 1}` });
  if (method === "POST" && path === "/checkout/sessions") {
    const id = `cs_test_pkgsess${String(opened.size + 1).padStart(10, "0")}`;
    const row: Opened = { id, url: `https://checkout.stripe.com/c/pay/${id}`, body: new URLSearchParams(String(init?.body)), status: "open" };
    opened.set(id, row);
    return answer({ id, url: row.url });
  }
  const expire = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
  if (method === "POST" && expire) {
    expires.push(expire[1]);
    if (expireFails) return answer({ error: { message: "synthetic Stripe failure" } }, 500);
    const row = opened.get(expire[1]);
    if (!row || row.status !== "open") return answer({ error: { message: "not open" } }, 400);
    row.status = "expired";
    return answer({ id: row.id, status: "expired" });
  }
  if (method === "GET" && path === `/checkout/sessions/${PAID}`) {
    return answer({ id: PAID, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded: false, amount: 20000, amount_refunded: 0 } } });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type World = { store: Store; listing: CallListing; token: string; busy: string };
async function world(n: number): Promise<World> {
  redis.clear();
  opened.clear();
  expires.length = 0;
  logged.length = 0;
  expireFails = false;
  const owner = `pkg-release-${n}@example.test`;
  const handle = `pkgrel${n}`;
  await claimHandle(owner, handle, "Synthetic Coaching", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestPkgRel0001", true);
  await setSubscription(owner, { customerId: "cus_PkgRel0001", subscriptionId: "sub_PkgRel0001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Coaching Call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(owner, made.product.id, weekly);
  await setCallPackage(owner, made.product.id, { sessions: 2, priceCents: 20000, days: 90 });
  const store = (await storeForEmail(owner))!;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const bought = await recordPackage({
    store,
    session: { id: PAID, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 20000, currency: "usd", metadata: { store: handle, product: listing.id, kind: "package", sessions: "2", days: "90" }, customer_details: { email: "dana@example.test" } },
    product: listing,
    base: `https://marktmorgen.com/@${handle}`,
    from: '"Synthetic Coaching" <hello@marktmorgen.com>',
  } as never);
  if (!bought) throw new Error("package not recorded");
  // One of the two sessions is already held (booked earlier).
  await holdSession(store, PAID, `cs_test_earlier${"e".repeat(16)}`, Math.floor(Date.now() / 1000) + 3_600);
  return { store, listing, token: bought.token, busy: `nl:call:busy:${store.callsId}` };
}

type Fail = "none" | "read" | "write" | "stripe";
/**
 * The real route, with another tab's holdSession taking the package's last
 * session right after this request's hold was written (so this request's own
 * holdSession says no), and the release failing as asked.
 */
async function book(w: World, start: number, fail: Fail) {
  const base = redis.pipeline.bind(redis);
  let raced = false;
  let armed = false;
  let thrown = 0;
  redis.pipeline = async (batch) => {
    const [cmd, key] = batch[0] ?? [];
    if (armed && fail === "read" && cmd === "HGETALL" && key === w.busy) {
      armed = false;
      thrown += 1;
      throw new Error("synthetic Redis read failure");
    }
    if (armed && fail === "write" && cmd === "HDEL" && key === w.busy) {
      armed = false;
      thrown += 1;
      throw new Error("synthetic Redis write failure");
    }
    const out = await base(batch);
    // The hold's write: a plain HSET of the diary, or the script that writes it only while the call's lock is still
    // the writer's (claude6/calls-lock-token), whose second key is the diary.
    const holdWritten = (cmd === "HSET" && key === w.busy) || (cmd === "EVAL" && String(key).startsWith("-- marktmorgen:call-hold-if-locked:v1\n") && batch[0]?.[4] === w.busy);
    if (!raced && holdWritten) {
      raced = true;
      // Another tab of the same buyer counts the last session first.
      redis.pipeline = base;
      await holdSession(w.store, PAID, `cs_test_othertab${"o".repeat(16)}`, Math.floor(Date.now() / 1000) + 3_600);
      redis.pipeline = wrapped;
      armed = true;
    }
    return out;
  };
  const wrapped = redis.pipeline;
  expireFails = fail === "stripe";
  const form = new URLSearchParams({ handle: w.store.handle, product: w.listing.id, start: String(start), tz: NY, pkg: w.token });
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/book", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
    return { response, raced, thrown };
  } finally {
    redis.pipeline = base;
    expireFails = false;
  }
}

async function busyEntry(w: World, session: string): Promise<{ until: number } | null> {
  const [raw] = await redis.pipeline([["HGET", w.busy, session]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { until: number }) : null;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_pkg_release_only";
  process.env.RESEND_API_KEY = "re_test_pkg_release_only";

  for (const [n, fail] of [[1, "none"], [2, "read"], [3, "write"], [4, "stripe"]] as [number, Fail][]) {
    part(`Release: ${fail === "none" ? "succeeds (control)" : `fails at ${fail}`}`);
    const w = await world(n);
    const start = weekdayAt(3, 600);
    const t0 = Math.floor(Date.now() / 1000);
    const { response, raced, thrown } = await book(w, start, fail);
    const location = response.headers.get("location") ?? "";
    const [only] = [...opened.values()];
    is("the other tab took the last session while this request held its time", raced, true);
    is("the route answers pkg-used", [response.status, location.includes("status=pkg-used")], [303, true]);
    is("one checkout was opened for it, free by a 100% single-use coupon, marked as the package's", [opened.size, Boolean(only?.body.get("discounts[0][coupon]")), only?.body.get("metadata[package]"), only?.body.get("customer_email")], [1, true, PAID, "dana@example.test"]);
    is("the buyer is never handed it: no checkout URL in the answer, no hold cookie", [new URL(location, "https://store.example.test").hostname === "checkout.stripe.com", location.includes(only.id), response.headers.get("set-cookie")], [false, false, null]);
    const closes = Number(only.body.get("expires_at")) - t0;
    is("Stripe closes it by itself within 31 minutes", closes >= CHECKOUT_OPEN_SECONDS - 5 && closes <= CHECKOUT_OPEN_SECONDS + 5, true);
    is("the failure injected", thrown, fail === "read" || fail === "write" ? 1 : 0);
    const entry = await busyEntry(w, only.id);
    const left = (await packageState((await readBought(PAID))!)).left;
    const counted = (await readBought(PAID))!.holds.map((h) => h.session).includes(only.id);
    const row = {
      expireCalled: expires.includes(only.id),
      stripeStatus: only.status,
      slotStillHeld: entry !== null,
      slotHeldForSeconds: entry ? Math.round((entry.until - Date.now()) / 1000) : 0,
      packageLeft: left,
      countedOnPackage: counted,
    };
    const anyLogged = logged.length > 0;
    if (fail === "none") {
      is("control: checkout expired at Stripe, slot let go, nothing logged", [row.expireCalled, row.stripeStatus, row.slotStillHeld, anyLogged], [true, "expired", false, false]);
    } else if (fail === "read") {
      is("read fails: the checkout is still asked to expire at Stripe, and is closed", [row.expireCalled, row.stripeStatus], [true, "expired"]);
      is("…the unread hold is kept, never HDEL'd unread, and runs out by itself", [row.slotStillHeld, row.slotHeldForSeconds > 30 * 60], [true, true]);
      is("…and the read failure is logged", logged.some((line) => line.includes("synthetic Redis read failure")), true);
    } else if (fail === "write") {
      is("write fails: checkout expired at Stripe, slot stays held until the hold runs out", [row.expireCalled, row.stripeStatus, row.slotStillHeld, row.slotHeldForSeconds > 30 * 60], [true, "expired", true, true]);
      is("…and the write failure is logged", logged.some((line) => line.includes("synthetic Redis write failure")), true);
    } else {
      is("expire fails: it was asked for; Stripe left it open; the slot stays held", [row.expireCalled, row.stripeStatus, row.slotStillHeld, row.slotHeldForSeconds > 30 * 60], [true, "open", true, true]);
      is("…and Stripe's failure is logged, never swallowed", logged.some((line) => line.includes("synthetic Stripe failure")), true);
    }
    is("the package has no session left and this checkout is not counted on it", [row.packageLeft, row.countedOnPackage], [0, false]);
  }
    done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
