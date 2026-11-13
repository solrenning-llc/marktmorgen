/**
 * Mutation testing of the commission math in lib/affiliates.ts (Claude 7,
 * 13/11/2026): each case kills a mutant that survived every test importing the
 * module. A commission left as it was is not a raise, an affiliate moved to the
 * program's equal share is paid no more, a product already over the committed
 * cap with nothing changed may still be saved, and the largest share a link may
 * carry is read, never refused. A sale through a link earns on what the buyer
 * paid less the tax added on top, and is written down only for a settled
 * checkout of this store with an id.
 */
import { bonusLines, commissionCapProblem, commissionRaised, leadLine, linkShare, noteCharge, noteSession, paysNoMore, settleLine, stripeWait, tierLines, withinMonths } from "@/lib/affiliates";
import type { Affiliate, Line } from "@/lib/affiliates";
import type { SettledLead } from "@/lib/affiliate-lead-rules";
import { MAX_COMMISSION, RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const terms = (percent: number, rates: Record<string, number> = {}) => ({ percent, rates });

part("A raise of commission");
is("the same terms are no raise", commissionRaised(terms(10, { p1: 20 }), terms(10, { p1: 20 })), false);
is("a product's share raised is", commissionRaised(terms(10, { p1: 20 }), terms(10, { p1: 25 })), true);
is("the program's share raised is", commissionRaised(terms(10), terms(12)), true);
is("a product's share lowered is not", commissionRaised(terms(10, { p1: 20 }), terms(10, { p1: 15 })), false);

part("Paid no more");
is("the same share", paysNoMore(terms(10), 15, 15), true);
is("their own share equal to the program's, moved to the program's", paysNoMore(terms(10), 10, null), true);
is("a lower share is no more", paysNoMore(terms(10), 15, 12), true);
is("a higher share is more", paysNoMore(terms(10), 15, 20), false);

part("The committed cap");
const partner = (id: string, percent: number, rate: number | null = null) =>
  ({ id, status: "approved", rate, share: { percent, products: ["p1"] } }) as unknown as Affiliate;
const over = [partner("a1", 60), partner("a2", 25, 20)];
is("already over the cap with nothing changed may be saved", commissionCapProblem({ terms: terms(10), people: over, nextTerms: terms(10), nextPeople: over }), null);
is("a rise over the cap is refused", commissionCapProblem({ terms: terms(10), people: over, nextTerms: terms(30), nextPeople: over }), "committed");
is("a fall while over the cap may be saved", commissionCapProblem({ terms: terms(10), people: over, nextTerms: terms(5), nextPeople: [partner("a1", 60), partner("a2", 25, 5)] }), null);

part("The share a link carries");
is("the largest share is read", linkShare(String(MAX_COMMISSION)), MAX_COMMISSION);
is("zero is read", linkShare("0"), 0);

const STATS = "statsmut1";
const AFF = "0123456789ab";
const shop = { handle: "harbor", name: "Harbor", previousHandles: [], releasedHandles: [], statsId: STATS, currency: "usd", affiliates: { enabled: true, percent: 10, days: 30, rates: {}, payday: 0, hold: 0 } } as unknown as Store;
let orders = 0;
const order = (over: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: `cs_mutants${++orders}`,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: 1_760_000_000,
  amount_total: 11_000,
  amount_subtotal: 10_000,
  currency: "usd",
  total_details: { amount_tax: 1_000 },
  payment_intent: "pi_mutants1",
  metadata: { store: "harbor", product: "front", title: "Front", via: AFF, via_rate: "20", ...meta },
  customer_details: { email: "buyer@example.com" },
  ...over,
});
async function sale(id: unknown): Promise<Record<string, unknown> | null> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, String(id)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
}
const noted = async (session: ReturnType<typeof order>) => {
  await noteSession(shop, session as Parameters<typeof noteSession>[1]);
  const v = await sale(session.id);
  return v && { base: v.base, total: v.total, rate: v.rate, pi: v.pi, at: v.at };
};

async function sales() {
  redis.clear();
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]]);

  part("What a sale through a link earns on");
  is("what the buyer paid less the tax added on top", await noted(order()), { base: 10_000, total: 11_000, rate: 20, pi: "pi_mutants1", at: 1_760_000_000 });
  is("a share with more decimals is kept as the link carried it", (await noted(order({}, { via_rate: "12.345" })))?.rate, 12.345);
  is("an expanded payment is read by its id", (await noted(order({ payment_intent: { id: "pi_mutants2", object: "payment_intent" } })))?.pi, "pi_mutants2");
  is("a payment with no id reads as none", (await noted(order({ payment_intent: {} })))?.pi, "");
  is("no payment reads as none", (await noted(order({ payment_intent: null })))?.pi, "");
  const undated = await noted(order({ created: undefined }));
  is("an undated sale is written at a whole second", Number.isInteger(undated?.at), true);

  part("Products checked at checkout");
  is("with no subtotal, a checked product cannot be weighed: the front share stands", (await noted(order({ amount_subtotal: 0 }, { bump: "addon", bump_cents: "5000", bump_rate: "40" })))?.rate, 20);
  is("with nothing paid, nothing is weighed", (await noted(order({ amount_total: 0, total_details: { amount_tax: 0 } }, { bump: "addon", bump_cents: "5000", bump_rate: "40" })))?.rate, 20);
  // Two checked products that say more than the whole order: the second only weighs what is left (40%), never more.
  is("checked products never weigh more than the whole order", (await noted(order({}, { via_rate: "10", bump: "a1", bump_cents: "6000", bump_rate: "50", bump2: "a2", bump2_cents: "6000", bump2_rate: "30" })))?.rate, 42);

  part("A product added after paying");
  const charge = (over: Record<string, unknown> = {}) => ({ id: `pi_mutcharge${++orders}`, status: "succeeded", amount: 2_000, currency: "usd", created: 1_760_000_500, receipt_email: "buyer@example.com", metadata: { store: "harbor", product: "addon", title: "Add-on", via: AFF, via_rate: "25" }, ...over });
  const charged = async (pi: Record<string, unknown>) => {
    await noteCharge(shop, pi);
    const v = await sale(pi.id);
    return v && { base: v.base, rate: v.rate, at: v.at, self: v.self };
  };
  is("earns on what it took, at the link's share, when it was paid", await charged(charge()), { base: 2_000, rate: 25, at: 1_760_000_500, self: false });
  is("bought by the affiliate themselves", (await charged(charge({ receipt_email: "sara@example.com" })))?.self, true);
  is("a payment that did not succeed earns nothing", await charged(charge({ status: "requires_payment_method" })), null);
  is("no affiliate named: nothing, and no error", await charged(charge({ metadata: { store: "harbor", product: "addon" } })), null);
  const undatedCharge = await charged(charge({ created: undefined }));
  is("an undated payment is written at a whole second", Number.isInteger(undatedCharge?.at), true);

  part("Only a settled checkout of this store with an id");
  const noId = order();
  is("no id", await noteSession(shop, { ...noId, id: undefined } as unknown as Parameters<typeof noteSession>[1]).then(() => sale("undefined")), null);
  is("not paid", await noted(order({ payment_status: "unpaid", status: "open" })), null);
  is("another store's", await noted(order({}, { store: "elsewhere" })), null);
}

function lines() {
  part("A sale's commission after a refund");
  const referral = (over: Record<string, unknown> = {}) => ({ ref: "cs_line1", pi: "pi_line1", aff: AFF, at: 1_760_000_000, product: "p1", title: "P1", base: 7, total: 2, currency: "usd", rate: 50, self: false, how: "click", ...over }) as unknown as Parameters<typeof settleLine>[0];
  is("what is kept is rounded before its share is taken", settleLine(referral(), 1).commission, 2);
  is("a sale of nothing earns nothing and is not refunded", (({ commission, status }) => ({ commission, status }))(settleLine(referral({ base: 0, total: 0 }), 0)), { commission: 0, status: "earned" });

  part("Months of a membership");
  is("always means always, however far ahead", withinMonths(0, 10_000_000_000, RECURRING_ALWAYS), true);

  part("Time left for Stripe");
  is("one second left is still asked", stripeWait(1_000, 0), 1_000);
  is("in whole milliseconds", stripeWait(5_000.5, 0), 5_000);
  is("never more than Stripe's own limit", stripeWait(10 * STRIPE_TIMEOUT_MS, 0), STRIPE_TIMEOUT_MS);

  part("A lead's line");
  const lead = (kind: string) => ({ lead: { id: "lead1", kind, ref: "prod1", pi: "", aff: AFF, at: 1, title: "T", currency: "usd", email: "x@example.com", why: "" }, status: "earned", commission: 500, readyAt: 2 }) as unknown as SettledLead;
  is("a free product names it", leadLine(lead("free")).product, "prod1");
  is("a signup names none", leadLine(lead("signup")).product, "");
  is("a booking names none", leadLine(lead("booking")).product, "");
  is("never an own purchase", leadLine(lead("free")).self, false);

  part("Bonuses for sales in a month");
  const bonusShop = { currency: "usd", affiliates: { bonuses: [{ sales: 1, cents: 1_000 }] } } as unknown as Parameters<typeof bonusLines>[0];
  const line = (over: Record<string, unknown>) => ({ ref: "r", pi: "", aff: AFF, at: 1_760_000_000, product: "", title: "", base: 1_000, total: 1_000, currency: "usd", rate: 10, self: false, how: "click", refunded: 0, commission: 100, status: "earned", ...over }) as unknown as Line;
  for (const how of ["partner", "bonus", "tier2", "lead"]) is(`a ${how} line is no sale toward a bonus`, bonusLines(bonusShop, [line({ how })]), []);
  is("a sale in another currency is not counted", bonusLines(bonusShop, [line({ currency: "eur" })]), []);
  const bonus = bonusLines({ ...bonusShop, affiliates: { bonuses: [{ sales: 2, cents: 1_000 }] } } as unknown as Parameters<typeof bonusLines>[0], [line({ at: 1_760_000_300 }), line({ at: 1_760_000_100 }), line({ at: 1_760_000_200 })]);
  is("reached at the second sale in time, not in the list's order", bonus.map((b) => [b.at, b.self, b.commission]), [[1_760_000_200, false, 1_000]]);

  part("The affiliate who recruited them");
  const person = (id: string, over: Record<string, unknown> = {}) => ({ id, status: "approved", decidedAt: 0, by: null, ...over }) as unknown as Affiliate;
  const recruit = (by: string) => person(AFF, { by: { id: by, percent: 5 } });
  const tiers = (everyone: Affiliate[], over: Record<string, unknown> = {}) => tierLines(everyone, [line(over)], new Map()).map((l) => [l.aff, l.rate]);
  is("earns their share of a sale the recruit brought", tiers([recruit("up0000000001"), person("up0000000001")]), [["up0000000001", 5]]);
  is("not of the recruit's own purchase", tiers([recruit("up0000000001"), person("up0000000001")], { self: true }), []);
  is("nothing when the recruiter is not on record", tiers([recruit("up0000000001")]), []);
  is("nothing when they recruited themselves", tiers([recruit(AFF)]), []);
  is("a recruiter removed at the very second of the sale still earns it", tiers([recruit("up0000000001"), person("up0000000001", { status: "removed", decidedAt: 1_760_000_000_000 })]), [["up0000000001", 5]]);
}

sales()
  .then(() => lines())
  .then(() => done())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
