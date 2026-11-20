/**
 * Codex X8-20261119-0917 (money, MEDIUM): an automatic coupon (introductory, fair or member price) is used at checkout
 * and kept as made ("1") only when Stripe's answer to its creation is the coupon itself, with the id that was asked
 * for. An empty answer, another coupon's, or an id that is not that text is unknown: the checkout gets an error and
 * nothing is kept, so the next checkout asks again. Synthetic only: an in-memory provider, no network.
 */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_x8_coupon_identity";

let reply: Record<string, unknown> | null = null;
let posts = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com" || !url.pathname.endsWith("/coupons") || init?.method !== "POST") throw new Error("unexpected synthetic request");
  posts += 1;
  const form = new URLSearchParams(String(init.body));
  return Response.json(reply ?? { id: form.get("id") });
}) as typeof fetch;

async function main(): Promise<void> {
  const { introCoupon } = await import("@/lib/intro-coupon");
  const { fairCoupon, memberCoupon } = await import("@/lib/fair-coupon");
  const cases = [
    { name: "intro", make: (a: string) => introCoupon(a, "usd", 1000, 2), id: "mm_intro_usd_1000_2", cache: (a: string) => `nl:intro:c:${a}:mm_intro_usd_1000_2` },
    { name: "fair", make: (a: string) => fairCoupon(a, 20), id: "mm_fair_20", cache: (a: string) => `nl:fair:c:${a}:20` },
    { name: "member", make: (a: string) => memberCoupon(a, 20), id: "mm_member_20", cache: (a: string) => `nl:member:c:${a}:20` },
  ];
  const mark = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
  let serial = 0;
  for (const c of cases) {
    part(`${c.name}: a successful answer must be the coupon asked for`);
    for (const bad of [{}, { id: "co_another_coupon" }, { id: 42 }, { id: null }, { id: "" }]) {
      const account = `acct_X8Synthetic${serial++}`;
      reply = bad;
      posts = 0;
      is(`${JSON.stringify(bad)}: the coupon is refused`, await c.make(account).then(() => "accepted", () => "unknown"), "unknown");
      is(`${JSON.stringify(bad)}: nothing is kept as made`, await mark(c.cache(account)), null);
    }
    reply = null;
    posts = 0;
    const account = `acct_X8Synthetic${serial++}`;
    is("the coupon asked for is used", await c.make(account), c.id);
    is("and kept as made", await mark(c.cache(account)), "1");
    is("the next checkout uses it again", await c.make(account), c.id);
    is("with no second creation", posts, 1);
  }
  done();
}

void main();
