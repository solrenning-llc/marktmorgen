/**
 * What a sale through an affiliate's link earns.
 *
 * This file exists because of one defect that reading the code did not show.
 * `attributionFor` threw the credit away when the *front* product earned 0%,
 * before anything else in the order was looked at. A creator who pays nothing
 * on a $7 front offer and 30% on the $97 add-on — an ordinary arrangement, and
 * the whole reason per-product rates exist — had every one of those sales
 * credited to nobody. The share was already carried correctly in the charge's
 * own record; it simply never got written, because the decision was made in
 * the wrong place.
 *
 * So the checks here are about *where* the decision is made: the click is read
 * on its own, the order's earnings are worked out from the whole order, and the
 * two are not allowed to collapse into each other again.
 */
import { attributionFor, noteSession } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsid1";
const AFF = "0123456789ab";
const CODE = "sara";

/** Just enough store for the parts under test to be the real ones. */
function shop(rates: Record<string, number>, percent = 0): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent, days: 30, rates, payday: 0, hold: 0 },
  } as unknown as Store;
}

/** An approved affiliate whose link has been clicked, as the store holds them. */
async function seed(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    [
      "HSET",
      `nl:aff:${STATS}:people`,
      AFF,
      JSON.stringify({
        id: AFF,
        email: "sara@example.com",
        code: CODE,
        status: "approved",
        appliedAt: 1,
        decidedAt: 2,
        note: "",
      }),
    ],
    ["HSET", `nl:aff:${STATS}:codes`, CODE, AFF],
  ]);
}

/** The cookie a click leaves: the code and the second it happened. */
const clicked = () => `${CODE}.${Math.floor(Date.now() / 1000)}`;

/** What was written down about a sale, read straight back out of the store. */
async function referral(id: string): Promise<{ aff: string; rate: number } | null> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, id]]);
  if (typeof raw !== "string") return null;
  const v = JSON.parse(raw) as { aff: string; rate: number };
  return { aff: v.aff, rate: v.rate };
}

async function main(): Promise<void> {
  part("Who the click credits, and at what share");
  await seed();

  const front = shop({ front: 0, addon: 30 });
  const both = shop({ front: 20, addon: 30 });

  is(
    "a product set to 0% still names the affiliate",
    await attributionFor(front, "front", { via: clicked(), session: undefined }),
    { aff: AFF, rate: 0, own: null },
  );
  is(
    "a product with a share of its own carries it",
    await attributionFor(both, "front", { via: clicked(), session: undefined }),
    { aff: AFF, rate: 20, own: null },
  );
  is(
    "no click, nobody credited",
    await attributionFor(both, "front", { via: undefined, session: undefined }),
    null,
  );
  is(
    "a click older than the store's window is spent",
    await attributionFor(both, "front", { via: `${CODE}.${Math.floor(Date.now() / 1000) - 31 * 86_400}`, session: undefined }),
    null,
  );
  is(
    "a code nobody holds credits nobody",
    await attributionFor(both, "front", { via: `zzz.${Math.floor(Date.now() / 1000)}`, session: undefined }),
    null,
  );

  part("What the order earns, once the whole of it is known");
  // The charge as Stripe reports it: $7 front offer plus a $97 add-on, no tax.
  const order = (meta: Record<string, string>) => ({
    id: `cs_${Math.random().toString(36).slice(2, 10)}`,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: 1_760_000_000,
    amount_total: 10_400,
    amount_subtotal: 10_400,
    currency: "usd",
    total_details: { amount_tax: 0, amount_shipping: 0 },
    payment_intent: "pi_1",
    metadata: { store: "harbor", product: "front", title: "Front + Add-on", ...meta },
    customer_details: { email: "buyer@example.com" },
  });

  const withBump = order({ via: AFF, via_rate: "0", bump: "addon", bump_cents: "9700", bump_rate: "30" });
  await noteSession(front, withBump);
  is(
    "0% on the front offer, 30% on the add-on: the add-on's share is earned",
    await referral(withBump.id),
    // 30% of $97 is $29.10, which is 27.98% of the $104 order. The rate kept
    // is the one over the whole of it, because that is what a refund of part
    // of the order has to be worked back out of.
    { aff: AFF, rate: 27.98 },
  );

  const bothPaying = order({ via: AFF, via_rate: "20", bump: "addon", bump_cents: "9700", bump_rate: "30" });
  await noteSession(both, bothPaying);
  is(
    "both paying: the two shares blended over the order",
    await referral(bothPaying.id),
    // 20% of $7 plus 30% of $97 is $30.50, which is 29.33% of $104.
    { aff: AFF, rate: 29.33 },
  );

  // Two boxes checked: $7 front at 20%, the $97 add-on at 30% and a $20
  // second add-on at 10%. Earned: $1.40 + $29.10 + $2.00 = $32.50 of $124.
  const twoBoxes = order({ via: AFF, via_rate: "20", bump: "addon", bump_cents: "9700", bump_rate: "30", bump2: "extra", bump2_cents: "2000", bump2_rate: "10" });
  twoBoxes.amount_total = 12_400;
  twoBoxes.amount_subtotal = 12_400;
  await noteSession(both, twoBoxes);
  is("two boxes checked: each earns its own share, weighed by its part of the order", await referral(twoBoxes.id), { aff: AFF, rate: 26.21 });

  const frontOnly = order({ via: AFF, via_rate: "20" });
  frontOnly.amount_total = 700;
  frontOnly.amount_subtotal = 700;
  await noteSession(both, frontOnly);
  is("no add-on: the front offer's own share, untouched", await referral(frontOnly.id), { aff: AFF, rate: 20 });

  const uncredited = order({});
  await noteSession(front, uncredited);
  is("an order with nobody named is not written down", await referral(uncredited.id), null);

  // The case the fix must not open: a bump that earns nothing must not turn a
  // 0% front offer into a sale on the book. Nothing writes this metadata now —
  // lib/store-checkout.ts leaves `via` off the charge entirely when no part of
  // the order earns — and if something ever did, the share would be 0 rather
  // than some number nobody agreed to.
  const nothingEarns = order({ via: AFF, via_rate: "0", bump: "addon", bump_cents: "9700", bump_rate: "0" });
  await noteSession(shop({ front: 0, addon: 0 }), nothingEarns);
  is("nothing in the order earns: the share is nothing", await referral(nothingEarns.id), { aff: AFF, rate: 0 });

  part("A membership is never credited");
  const membership = { ...order({ via: AFF, via_rate: "20" }), mode: "subscription" };
  await noteSession(both, membership);
  is("a subscription is left alone", await referral(membership.id), null);

  done();
}

void main();
