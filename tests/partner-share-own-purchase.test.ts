/**
 * "Your own purchases never earn" holds for a partner's share as it does for an affiliate's commission: the buyer
 * is matched with the partner as one inbox however the address is written (canonicalEmail: case, a "+" tag, and
 * Gmail's dots and googlemail.com), not only character for character. A share written for the partner's own
 * purchase is marked `self`, which the book never pays. A different person buying still earns the partner their
 * share. Synthetic records, the Redis stand-in only.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { notePartners } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner-partner-self@example.com";
const PRODUCT = "prodselfaaa";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harborself", "Harbor Self", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;

  const partner = (id: string, email: string) => ({ id, email, code: id, status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { percent: 50, products: [PRODUCT] } });
  const plain = partner("aaaaaaaaaaaa", "pat.lee@example.com");
  const gmail = partner("bbbbbbbbbbbb", "sam.rivera@gmail.com");
  const partners = [plain, gmail] as never;

  let n = 0;
  const sell = async (buyer: string) => {
    const ref = `cs_test_${String(++n).padStart(24, "o")}`;
    await notePartners(store, { ref, pi: `pi_test_ownpurchase${n}`, at: Date.now(), product: PRODUCT, title: "Course", base: 4900, total: 4900, currency: "usd", buyer }, partners);
    return ref;
  };
  const selfOf = async (ref: string, aff: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${store.statsId}:shares`, `${ref}:${aff}`]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { self: boolean }).self : null;
  };

  part("The partner buys their own product: the share is theirs, so it is marked self");
  for (const [label, buyer] of [
    ["the same address", "pat.lee@example.com"],
    ["in capitals", "Pat.Lee@Example.com"],
    ["with a plus tag", "pat.lee+books@example.com"],
    ["with a plus tag and a trailing dot on the domain", "pat.lee+books@example.com."],
  ] as const) {
    const ref = await sell(buyer);
    is(`${label}: the plain partner's share is self`, await selfOf(ref, plain.id), true);
    is(`${label}: the Gmail partner, a different person, still earns`, await selfOf(ref, gmail.id), false);
  }
  for (const [label, buyer] of [
    ["Gmail without the dot", "samrivera@gmail.com"],
    ["Gmail with other dots", "s.a.m.rivera@gmail.com"],
    ["Gmail with a plus tag", "sam.rivera+shop@gmail.com"],
    ["googlemail.com", "samrivera@googlemail.com"],
  ] as const) {
    const ref = await sell(buyer);
    is(`${label}: the Gmail partner's share is self`, await selfOf(ref, gmail.id), true);
    is(`${label}: the plain partner, a different person, still earns`, await selfOf(ref, plain.id), false);
  }

  part("A different person buys: both partners earn");
  for (const [label, buyer] of [
    ["another address", "buyer@example.com"],
    ["dots matter outside Gmail", "patlee@example.com"],
    ["another Gmail inbox", "sam.rivera2@gmail.com"],
  ] as const) {
    const ref = await sell(buyer);
    is(`${label}: the plain partner earns`, await selfOf(ref, plain.id), false);
    is(`${label}: the Gmail partner earns`, await selfOf(ref, gmail.id), false);
  }

  part("No buyer address: nobody is matched");
  const unnamed = await sell("");
  is("no address: the plain partner earns", await selfOf(unnamed, plain.id), false);
  is("no address: the Gmail partner earns", await selfOf(unnamed, gmail.id), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
