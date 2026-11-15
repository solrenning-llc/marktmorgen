/**
 * #4703 (Codex X8): a coupon lives on the Stripe account that made it. After the store disconnected account A and
 * connected B, saving the same welcome, stay or come-back offer kept the coupon made on A, so the offer was announced
 * and its checkout failed on B ("No such coupon"). A stored coupon is now reused only when Stripe, on the account
 * connected now, answers it as a valid coupon of the same terms; otherwise a coupon is made there first.
 * Synthetic Stripe stand-in: a coupon is held by the account in the Stripe-Account header.
 */
import { NextRequest } from "next/server";
import { POST as welcomeRoute } from "@/app/api/store/welcome-offer/route";
import { POST as saveRoute } from "@/app/api/store/save-offer/route";
import { POST as comeBackRoute } from "@/app/api/store/come-back/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, clearStripeAccount, ensureStatsId, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_offer_coupon_account";

const OWNER = "owner@example.com";
const A = "acct_1TestOfferCpnA01";
const B = "acct_1TestOfferCpnB01";
/** Every coupon made, as "<account letter>:<id>". */
const made: string[] = [];
/** Coupons that exist, by the account that holds them. */
const held = new Map<string, Record<string, unknown>>();
let reads = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const account = String(new Headers(init?.headers).get("Stripe-Account") ?? "");
  const letter = account === A ? "a" : account === B ? "b" : "?";
  if (url.pathname === "/v1/coupons" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const id = `coupon_${letter}_${made.length + 1}`;
    const coupon = {
      id,
      object: "coupon",
      percent_off: Number(body.get("percent_off")),
      amount_off: null,
      duration: body.get("duration"),
      duration_in_months: body.get("duration_in_months") ? Number(body.get("duration_in_months")) : null,
      valid: true,
    };
    made.push(`${letter}:${id}`);
    held.set(`${account}:${id}`, coupon);
    return json(coupon);
  }
  const one = /^\/v1\/coupons\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (one && (init?.method ?? "GET") === "GET") {
    reads += 1;
    const coupon = held.get(`${account}:${one[1]}`);
    return coupon ? json(coupon) : json({ error: { message: `No such coupon: '${one[1]}'`, code: "resource_missing" } }, 404);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, A, true);
  await setSubscription(OWNER, { customerId: "cus_OfferCpn0001", subscriptionId: "sub_OfferCpn0001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  const cookie = await openSession(OWNER);
  const post = async (route: (r: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const text = JSON.stringify(body);
    const response = await route(
      new NextRequest(`https://marktmorgen.com/api/store/${path}`, {
        method: "POST",
        body: text,
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", "content-length": String(text.length), cookie: `${SESSION_COOKIE}=${cookie}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, { coupon?: string } | undefined> };
  };
  const welcome = async () => (await post(welcomeRoute, "welcome-offer", { percent: 25, hours: 48, product: paid.product.id })).body.welcomeOffer?.coupon;
  const stay = async () => (await post(saveRoute, "save-offer", { percent: 20, months: 2 })).body.save?.coupon;
  const comeBack = async () => (await post(comeBackRoute, "come-back", { percent: 30, months: 1, days: 7, address: "1 Harbor Way, Portland, OR 97201" })).body.winback?.coupon;

  part("Saved on account A");
  const onA = [await welcome(), await stay(), await comeBack()];
  is("each offer is saved with a coupon made on A", onA.map((c) => c?.startsWith("coupon_a_")), [true, true, true]);
  const madeOnA = made.length;
  is("(control) saved again on A: each keeps its own coupon, nothing new made", [await welcome(), await stay(), await comeBack(), made.length], [...onA, madeOnA]);

  part("The store disconnects A, connects B, and saves the same offers");
  await clearStripeAccount(OWNER);
  await setStripeAccount(OWNER, B, true);
  const onB = [await welcome(), await stay(), await comeBack()];
  is("each offer now carries a coupon made on B", onB.map((c) => c?.startsWith("coupon_b_")), [true, true, true]);
  is("each coupon it carries is held by B", onB.map((c) => held.has(`${B}:${c}`)), [true, true, true]);
  is("the stored coupons were read on B before any was kept", reads > 0, true);
  done();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
