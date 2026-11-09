/**
 * A Stripe `discounts` that is not Stripe's own shape is "not known", never
 * "no discount" (CX-123 rule 30; the LEVE finding of the review of #3186,
 * 9 November 2026, siblings of lib/member-discount.ts's hasDiscount).
 *
 * Stripe documents a subscription's `discounts` and a subscription item's
 * `discounts` as a list of discount ids or discount objects, empty when there
 * is none (stripe-node 23.1.0, API 2026-10-28.endive: Subscription.discounts
 * and SubscriptionItem.discounts, `Array<string | Discount>`, not optional).
 * API versions before it had only the single `discount` (stripe-node for API
 * 2022-11-15: Subscription.discount `Discount | null`, no `discounts`), so a
 * subscription with `discount: null` and no `discounts` reads "none", as it
 * did; a subscription with neither field, a `discounts` that is not a list
 * (null, one id as text, a list object) or a list with a row that cannot be
 * read is unknown, and no yearly or monthly price is offered on it: the
 * figure compared would be the undiscounted price, and a move could drop a
 * discount the member has. Synthetic subscriptions only; nothing is sent.
 */
import { type YearlySub, discounted, yearlyChoice } from "@/lib/yearly-switch-rules";
import { type FallbackInvoice, type FallbackSub, monthlyFallback } from "@/lib/yearly-fallback-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 9) / 1000;
const club = { id: "club", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null, yearly: { cents: 20000 } };

/** A monthly member as the current API answers: `discounts` a list, no single `discount`. */
const monthly = (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const sub: Record<string, unknown> = {
    status: "active",
    start_date: NOW - 90 * 86_400,
    discounts: [],
    pause_collection: null,
    metadata: { store: "harbor", product: "club" },
    items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
    ...over,
  };
  for (const key of drop) delete sub[key];
  return sub as YearlySub;
};
const choice = (sub: YearlySub) => yearlyChoice(sub, club, [], "usd", NOW);
const YEAR = { cents: 20000, saving: 4000, monthly: 2000 };

part("A subscription's discounts, read exactly (yearly-switch-rules)");
is(
  "Stripe's shapes that say none still offer the year: an empty list; the single field null beside an empty list; an older version's single field null with no list",
  [choice(monthly()), choice(monthly({ discount: null })), choice(monthly({ discount: null }, ["discounts"]))],
  [YEAR, YEAR, YEAR],
);
is(
  "a discount Stripe lists, by id or as an object, or the single field: never offered",
  [choice(monthly({ discounts: ["di_1"] })), choice(monthly({ discounts: [{ id: "di_1", object: "discount" }] })), choice(monthly({ discount: { id: "di_1" } }))],
  [null, null, null],
);
is(
  "a discounts Stripe cannot have sent is unknown, never none: missing with no single field, null, one id as text, a list object, a number",
  [
    choice(monthly({}, ["discounts"])),
    choice(monthly({ discounts: null })),
    choice(monthly({ discounts: "di_1" })),
    choice(monthly({ discounts: { object: "list", data: ["di_1"] } })),
    choice(monthly({ discounts: 1 })),
  ],
  [null, null, null, null, null],
);
is(
  "a row Stripe cannot have sent, or a single field that is neither a discount nor null, is unknown too",
  [
    choice(monthly({ discounts: [""] })),
    choice(monthly({ discounts: [{}] })),
    choice(monthly({ discounts: [null] })),
    choice(monthly({ discount: "di_1" })),
    choice(monthly({ discount: [] })),
  ],
  [null, null, null, null, null],
);
is(
  "discounted() says so itself: unknown counts as a discount, so nothing is offered on it",
  [discounted(monthly()), discounted(monthly({ discount: null }, ["discounts"])), discounted(monthly({}, ["discounts"])), discounted(monthly({ discounts: null })), discounted(monthly({ discount: "di_1" }))],
  [false, false, true, true, true],
);

part("A subscription item's discounts, read exactly (yearly-fallback-rules)");
/** A yearly membership past due on its renewal, read at FALLBACK_STRIPE_VERSION (dahlia): every item lists its discounts. */
const yearly = (item: Record<string, unknown> = {}, drop: string[] = [], over: Record<string, unknown> = {}): FallbackSub => {
  const row: Record<string, unknown> = { quantity: 1, discounts: [], price: { unit_amount: 20000, currency: "usd", recurring: { interval: "year", interval_count: 1 } }, ...item };
  for (const key of drop) delete row[key];
  return {
    status: "past_due",
    collection_method: "charge_automatically",
    discounts: [],
    metadata: { store: "lena" },
    default_payment_method: { id: "pm_1", type: "card" },
    items: { data: [row as NonNullable<NonNullable<FallbackSub["items"]>["data"]>[number]] },
    ...over,
  };
};
const invoice: FallbackInvoice = { subscription: "sub_1", billing_reason: "subscription_cycle", status: "open", amount_due: 20000, currency: "usd" };
const fallbackProduct = { id: "p1", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: false, yearly: { cents: 20000 } };
const offer = (sub: FallbackSub) => monthlyFallback("sub_1", sub, invoice, fallbackProduct, [], "usd", NOW);
const MONTH = { monthly: 2000, yearly: 20000, extraPerYear: 4000 };

is("an item that lists none: offered", offer(yearly()), MONTH);
is("an item that lists one, by id or as an object: never offered", [offer(yearly({ discounts: ["di_item"] })), offer(yearly({ discounts: [{ id: "di_item" }] }))], [null, null]);
is(
  "an item whose discounts Stripe cannot have sent is unknown, never none: missing, null, one id as text, a list object, a row that cannot be read",
  [
    offer(yearly({}, ["discounts"])),
    offer(yearly({ discounts: null })),
    offer(yearly({ discounts: "di_item" })),
    offer(yearly({ discounts: { object: "list", data: ["di_item"] } })),
    offer(yearly({ discounts: [""] })),
    offer(yearly({ discounts: [{}] })),
  ],
  [null, null, null, null, null, null],
);
is(
  "the subscription's own discounts are read the same way here: missing with no single field, or not a list, is never offered",
  [offer(yearly({}, [], { discounts: undefined })), offer(yearly({}, [], { discounts: null })), offer(yearly({}, [], { discounts: "di_1" }))],
  [null, null, null],
);

done();
