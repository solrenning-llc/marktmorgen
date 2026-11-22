/**
 * Codex X6's two route LOWs on #2617 (7052207176), on the real route and lib/call-packages.ts:
 *   - a package or its sessions left that do not read before the session is prepared answer "pkg-error" (try again,
 *     nothing charged), never a page error and never "used" or "gone";
 *   - a session count (holdSession) that cannot read the package answers "pkg-error", never "no sessions left"
 *     ("pkg-used"), and the checkout this request opened is still closed at Stripe.
 * Synthetic data, the Redis stand-in and a Stripe stand-in, as tests/book-pkg-release.test.ts.
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


async function post(w: World, start: number) {
  const form = new URLSearchParams({ handle: w.store.handle, product: w.listing.id, start: String(start), tz: NY, pkg: w.token });
  return POST(new NextRequest("https://marktmorgen.com/api/store/book", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
}
const statusOf = (response: Response) => new URL(response.headers.get("location") ?? "/", "https://store.example.test").searchParams.get("status");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_pkg_unknown_only";
  process.env.RESEND_API_KEY = "re_test_pkg_unknown_only";
  const base = redis.pipeline.bind(redis);

  part("The package does not read before its session is prepared: pkg-error, nothing opened");
  {
    const w = await world(11);
    redis.pipeline = (async (batch: (string | number)[][]) => {
      if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:pkg:"))) throw new Error("synthetic package read failure");
      return base(batch);
    }) as typeof redis.pipeline;
    let response: Response | null = null;
    let threw = false;
    try { response = await post(w, weekdayAt(3, 600)); } catch { threw = true; } finally { redis.pipeline = base; }
    is("no page error: the route answers", threw, false);
    is("told to try again, never used up or gone", [response?.status, statusOf(response!)], [303, "pkg-error"]);
    is("no checkout opened", opened.size, 0);
  }

  part("The session count cannot read the package after the time is held: pkg-error, not pkg-used");
  {
    const w = await world(12);
    let held = false;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      const [cmd, key] = batch[0] ?? [];
      if (held && batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:pkg:"))) throw new Error("synthetic count read failure");
      const out = await base(batch);
      if ((cmd === "HSET" && key === w.busy) || (cmd === "EVAL" && String(key).startsWith("-- marktmorgen:call-hold-if-locked:v1\n") && batch[0]?.[4] === w.busy)) held = true;
      return out;
    }) as typeof redis.pipeline;
    let response: Response;
    try { response = await post(w, weekdayAt(4, 600)); } finally { redis.pipeline = base; }
    const [only] = [...opened.values()];
    is("the time was held before the count", held, true);
    is("told to try again, not \"no sessions left\"", [response.status, statusOf(response)], [303, "pkg-error"]);
    is("the checkout it opened is closed at Stripe", [opened.size, only ? expires.includes(only.id) : false], [1, true]);
    is("and not counted on the package", (await readBought(PAID))!.holds.some((h) => h.session === only?.id), false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
