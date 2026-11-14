/**
 * Whether a store sold before its "first" sale, read exactly (CX-123 rule 24, rule 30).
 *
 * lib/yearly-offer.ts asks the store's own Stripe account, once, whether it
 * was paid before the sale the checkout pass just saw. "Never" notes today
 * as the store's first sale, for good, and emails the creator "Your store
 * just made its first sale" with the yearly offer. So a reply that is not a
 * whole Stripe list (no data, data that is not a list, has_more that is not
 * true or false, a row that is not a checkout, a sale without its date) or
 * a list that goes on past the page read is not "never": it is unknown, and
 * nothing is noted or sent on it; the next pass asks again. Pages are walked
 * by the last row's id, and a page with more but no id to walk on, a
 * repeated id or more pages than the bound is unknown too.
 *
 * Which rows are sales is read exactly too: a row whose metadata is not an
 * object (so whose it is cannot be read), or a row of this store whose
 * payment status is not one Stripe documents or, when paid and not a tip,
 * whose amount is not whole cents, is unknown, never "not a sale".
 *
 * Controls: an exactly empty list is "never" (noted today, one email), one
 * earlier sale is "before" (its day noted, nothing sent), and rows that are
 * exactly not a sale of this store (another store's, unpaid, free, of zero,
 * a tip) are skipped.
 */
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, noteFirstSale } from "@/lib/yearly-offer";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_yearly_only";
process.env.RESEND_API_KEY = "re_test_yearly_offer_only";

const NOW = 1_791_700_000;
const emails: string[] = [];
const subs: Record<string, Record<string, unknown>> = {};
/** What the store's account answers for its earlier checkouts: by the starting_after cursor ("" for the first page). */
let answer: (cursor: string) => Response = () => json({ object: "list", data: [], has_more: false });
let listReads = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function subscription(id: string): Record<string, unknown> {
  return {
    id,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_end: NOW + 20 * 86_400,
          price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } },
        },
      ],
    },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/checkout/sessions") {
      listReads += 1;
      return answer(url.searchParams.get("starting_after") ?? "");
    }
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) return json(subs[m[1]]);
    return json({ error: { message: "no such" } }, 404);
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return json({ id: "re_1" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let n = 0;
/** A fresh store on a staying monthly plan, so a "first sale" would email it. */
async function freshStore() {
  n += 1;
  const sub = `sub_r24yearly${String(n).padStart(4, "0")}`;
  subs[sub] = subscription(sub);
  const email = `r24-yearly-${n}@example.com`;
  await claimHandle(email, `r24yearly${n}`, "A store", "");
  await setStripeAccount(email, "acct_1TestR24Yrly");
  await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  return (await storeForEmail(email))!;
}

const sale = (handle: string, created: number, over: Record<string, unknown> = {}) => ({
  id: `cs_sale_${handle}_${created}`,
  created,
  amount_total: 1900,
  status: "complete",
  payment_status: "paid",
  metadata: { store: handle },
  ...over,
});
const tip = (handle: string, id: string) => ({ id, created: NOW - 5000, amount_total: 500, status: "complete", payment_status: "paid", metadata: { store: handle, kind: "tip" } });

/** One pass over a store that the checkout pass just saw sell, with `reply` as its account's answer about earlier sales. */
async function pass(reply: (handle: string) => (cursor: string) => Response) {
  const store = await freshStore();
  answer = reply(store.handle);
  const before = emails.length;
  listReads = 0;
  const noted = await noteFirstSale(store, [sale(store.handle, NOW - 60)], true);
  return { store, noted, day: await firstSaleAt(store), sent: emails.length - before, reads: listReads };
}

/** Off-shape: nothing is noted (the day stays unknown) and nothing is sent. */
async function unknownCase(label: string, reply: (handle: string) => (cursor: string) => Response) {
  const r = await pass(reply);
  is(`${label}: nothing noted, nothing sent`, [r.noted, r.day, r.sent], [false, 0, 0]);
  return r;
}

async function main() {
  part("Controls: an exact answer");
  {
    const never = await pass(() => () => json({ object: "list", data: [], has_more: false }));
    is("an exactly empty list is never: today noted, one email", [never.noted, never.day, never.sent], [true, NOW - 60, 1]);
    const before = await pass((h) => () => json({ object: "list", data: [sale(h, NOW - 90 * 86_400)], has_more: false }));
    is("one earlier sale is before: its day noted, nothing sent", [before.noted, before.day, before.sent], [false, NOW - 90 * 86_400, 0]);
    const paged = await pass((h) => (cursor) =>
      cursor === ""
        ? json({ object: "list", data: [tip(h, "cs_tip_1"), tip(h, "cs_tip_2")], has_more: true })
        : cursor === "cs_tip_2"
          ? json({ object: "list", data: [sale(h, NOW - 40 * 86_400)], has_more: false })
          : json({ error: { message: "bad cursor" } }, 400),
    );
    is("a sale on the second page is before: walked on the last row's id, its day noted, nothing sent", [paged.noted, paged.day, paged.sent, paged.reads], [false, NOW - 40 * 86_400, 0, 2]);
    const skipped = await pass((h) => () =>
      json({
        object: "list",
        data: [
          sale("another", NOW - 10 * 86_400, { id: "cs_other_store" }),
          sale("another", NOW - 11 * 86_400, { id: "cs_other_odd", payment_status: "succeeded", amount_total: "1900" }),
          sale(h, NOW - 12 * 86_400, { id: "cs_no_store", metadata: {} }),
          sale(h, NOW - 13 * 86_400, { id: "cs_unpaid", payment_status: "unpaid", amount_total: null }),
          sale(h, NOW - 14 * 86_400, { id: "cs_free", payment_status: "no_payment_required", amount_total: 0 }),
          sale(h, NOW - 15 * 86_400, { id: "cs_zero", amount_total: 0 }),
          tip(h, "cs_tip_only"),
        ],
        has_more: false,
      }),
    );
    is(
      "rows of another store, without a store, unpaid, free, of zero or a tip are exactly not a sale: never, today noted, one email",
      [skipped.noted, skipped.day, skipped.sent],
      [true, NOW - 60, 1],
    );
  }

  part("Off-shape replies are unknown, never 'never sold'");
  await unknownCase("a null body", () => () => json(null));
  await unknownCase("a reply with no data", () => () => json({ object: "list", has_more: false }));
  await unknownCase("data that is not a list", () => () => json({ object: "list", data: "none", has_more: false }));
  await unknownCase("an empty list whose has_more is not a boolean", () => () => json({ object: "list", data: [], has_more: "false" }));
  await unknownCase("an empty list with has_more missing", () => () => json({ object: "list", data: [] }));
  await unknownCase("a row that is not a checkout", () => () => json({ object: "list", data: ["cs_1"], has_more: false }));
  await unknownCase("a sale without its date", (h) => () => json({ object: "list", data: [sale(h, NOW - 86_400, { created: "yesterday" })], has_more: false }));
  // Which rows are sales is read exactly too (Claude 4 on #3281): a row of this store whose payment status or amount
  // cannot be read, or a row whose metadata cannot say whose it is, may be the only earlier sale.
  const only = (over: Record<string, unknown>) => (h: string) => () => json({ object: "list", data: [sale(h, NOW - 90 * 86_400, over)], has_more: false });
  await unknownCase("the only earlier row with no payment status", only({ payment_status: undefined }));
  await unknownCase("the only earlier row with a payment status Stripe does not document", only({ payment_status: "succeeded" }));
  await unknownCase("the only earlier row with its amount as a string", only({ amount_total: "1900" }));
  await unknownCase("the only earlier paid row with no amount", only({ amount_total: null }));
  await unknownCase("the only earlier paid row with a fractional amount", only({ amount_total: 19.5 }));
  await unknownCase("the only earlier row with null metadata", only({ metadata: null }));
  await unknownCase("the only earlier row with no metadata", only({ metadata: undefined }));
  await unknownCase("the only earlier row with metadata that is a list", only({ metadata: ["store"] }));
  await unknownCase("the only earlier row with a store that is not a string", (h) => only({ metadata: { store: [h] } })(h));
  await unknownCase("the only earlier row with a kind that is not a string", (h) => only({ metadata: { store: h, kind: 1 } })(h));
  await unknownCase("a page with more but rows without ids", (h) => (cursor) =>
    cursor === ""
      ? json({ object: "list", data: [{ ...tip(h, ""), id: undefined }], has_more: true })
      : json({ object: "list", data: [sale(h, NOW - 30 * 86_400)], has_more: false }),
  );
  await unknownCase("a page with more and no rows", () => () => json({ object: "list", data: [], has_more: true }));
  await unknownCase("a repeated cursor", (h) => () => json({ object: "list", data: [tip(h, "cs_same")], has_more: true }));
  {
    const r = await unknownCase("more pages than the bound, none with a sale", (h) => (cursor) => json({ object: "list", data: [tip(h, `cs_${cursor || "start"}_next`)], has_more: true }));
    is("the walk stops at its bound", r.reads <= 10, true);
  }
  await unknownCase("an error from Stripe", () => () => json({ error: { message: "down" } }, 500));

  part("After an unknown answer, the next whole answer notes it and writes, once");
  {
    const store = await freshStore();
    answer = () => json({ object: "list", data: "none", has_more: false });
    const before = emails.length;
    const odd = await noteFirstSale(store, [sale(store.handle, NOW - 60)], true);
    answer = () => json({ object: "list", data: [], has_more: false });
    const whole = await noteFirstSale(store, [sale(store.handle, NOW - 60)], true);
    const again = await noteFirstSale(store, [sale(store.handle, NOW)], true);
    is("odd: nothing; whole: noted and one email; again: nothing", [odd, whole, again, emails.length - before, await firstSaleAt(store)], [false, true, false, 1, NOW - 60]);
  }

  done();
}

main();
