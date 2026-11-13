/**
 * The coupons a creator's introductory price and fair price take off at
 * checkout (lib/intro-coupon.ts, lib/fair-coupon.ts) are made once and noted.
 * A coupon the creator deleted at Stripe is no longer accepted, so a noted
 * coupon is checked at Stripe before it is handed to a checkout: gone or no
 * longer valid, the note is dropped and the coupon is made again, so the buyer
 * pays the price they were shown (issue #4377, Codex X8-2326). A coupon that
 * is there and right is never made twice, and a check Stripe does not answer
 * throws: the checkout never opens at the full price instead.
 */
import { fairCoupon } from "@/lib/fair-coupon";
import { introCoupon } from "@/lib/intro-coupon";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_coupon_stand_in";
const live = new Map<string, Record<string, unknown>>();
let creates = 0;
let down = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (down) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = body.get("id")!;
    creates += 1;
    if (live.has(id)) return new Response(JSON.stringify({ error: { code: "resource_already_exists", message: "exists" } }), { status: 400 });
    const coupon = { id, valid: true, amount_off: Number(body.get("amount_off")) || undefined, percent_off: Number(body.get("percent_off")) || undefined, currency: body.get("currency") ?? undefined, duration: body.get("duration"), duration_in_months: Number(body.get("duration_in_months")) || undefined };
    live.set(id, coupon);
    return new Response(JSON.stringify(coupon), { status: 200 });
  }
  const one = /^\/coupons\/(.+)$/.exec(path);
  if (one && method === "GET") {
    const coupon = live.get(decodeURIComponent(one[1]));
    return coupon ? new Response(JSON.stringify(coupon), { status: 200 }) : new Response(JSON.stringify({ error: { code: "resource_missing", message: "No such coupon" } }), { status: 404 });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const ACCOUNT = "acct_1TestCoupon0001";

async function main(): Promise<void> {
  for (const [name, make] of [
    ["introductory price", () => introCoupon(ACCOUNT, "usd", 1500, 3)],
    ["fair price", () => fairCoupon(ACCOUNT, 30)],
  ] as const) {
    redis.clear();
    live.clear();
    creates = 0;
    down = false;
    part(`The ${name}'s coupon`);
    const id = await make();
    is("control: made once on the account", [live.has(id), creates], [true, 1]);
    is("control: there and right, it is not made again", [await make(), creates], [id, 1]);
    live.delete(id); // the creator deletes it in the Stripe dashboard
    const again = await make();
    is("deleted at Stripe: the coupon handed to the next checkout exists", live.has(again), true);
    live.set(id, { ...live.get(id), valid: false });
    let invalid: string;
    try {
      invalid = await make();
    } catch {
      invalid = "refused";
    }
    is("no longer valid at Stripe: never handed to a checkout", invalid === id && live.get(id)?.valid === false, false);
    live.set(id, { ...(live.get(id) ?? {}), valid: true });
    is("valid again: handed to the checkout, and noted", await make(), id);
    down = true;
    let checked: string;
    try {
      checked = await make();
    } catch {
      checked = "refused";
    }
    is("Stripe does not answer the check: refused, never a full price", checked, "refused");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
