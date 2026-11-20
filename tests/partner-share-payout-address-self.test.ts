/**
 * "Your own purchases never earn" for a partner's share also covers the partner's payout address (issue #4046,
 * part 2): a partner who set a PayPal address for their payouts and buys their own product with it is buying from
 * themselves, as an affiliate is (isSelf, ownAddress) and as an own lead is refused (lib/affiliate-leads.ts isOwn).
 * The share written for that purchase is marked `self`, which the book never pays, however the address is written.
 * A partner with no payout address of their own is matched by their inbox only, and somebody else buying with an
 * address that is nobody's payout address still earns every partner their share. Synthetic records, the Redis
 * stand-in only.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { notePartners } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner-partner-payto@example.com";
const PRODUCT = "prodpaytoaaa";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harborpayto", "Harbor Payto", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;

  const partner = (id: string, email: string, paypal: string) => ({
    id,
    email,
    code: id,
    status: "approved",
    appliedAt: 1,
    decidedAt: 2,
    note: "",
    rate: null,
    paypal,
    share: { percent: 50, products: [PRODUCT] },
    cleared: null,
    by: null,
  });
  const paid = partner("aaaaaaaaaaaa", "pat.lee@example.com", "pat.payouts@example.com");
  const plain = partner("bbbbbbbbbbbb", "sam.rivera@example.com", "");
  const partners = [paid, plain] as never;

  let n = 0;
  const sell = async (buyer: string) => {
    const ref = `cs_test_${String(++n).padStart(24, "p")}`;
    await notePartners(store, { ref, pi: `pi_test_payto${n}`, at: Date.now(), product: PRODUCT, title: "Course", base: 4900, total: 4900, currency: "usd", buyer }, partners);
    return ref;
  };
  const selfOf = async (ref: string, aff: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${store.statsId}:shares`, `${ref}:${aff}`]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { self: boolean }).self : null;
  };

  part("The partner buys their own product with their payout address: the share is marked self");
  for (const [label, buyer] of [
    ["the payout address", "pat.payouts@example.com"],
    ["in capitals", "Pat.Payouts@Example.com"],
    ["with a plus tag", "pat.payouts+shop@example.com"],
  ] as const) {
    const ref = await sell(buyer);
    is(`${label}: the partner who set it is self`, await selfOf(ref, paid.id), true);
    is(`${label}: the other partner, a different person, still earns`, await selfOf(ref, plain.id), false);
  }

  part("Their inbox still matches, as before");
  const inbox = await sell("pat.lee@example.com");
  is("the inbox: the partner is self", await selfOf(inbox, paid.id), true);
  is("the inbox: the other partner earns", await selfOf(inbox, plain.id), false);

  part("A partner with no payout address of their own is matched by their inbox only");
  const theirs = await sell("sam.rivera+x@example.com");
  is("the plain partner's inbox: self", await selfOf(theirs, plain.id), true);
  is("the plain partner's inbox: the partner with a payout address earns", await selfOf(theirs, paid.id), false);

  part("Somebody else buys: both partners earn");
  const other = await sell("buyer@example.com");
  is("another address: the partner with a payout address earns", await selfOf(other, paid.id), false);
  is("another address: the plain partner earns", await selfOf(other, plain.id), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
