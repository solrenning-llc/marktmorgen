/**
 * 630 [HN6](39) on main (claude3/keep/c-hn6-on-main), Codex M's MEDIUM on #1924 (review 5813075476), ported: a share
 * whose end (`until`) is present but does not read (text, a boolean, a fraction) was read by parsePartnerShare as a
 * share with no end, so it earned on sales after the agreement really ended. listPartners (what notePartners credits)
 * now keeps a partner only when their share reads exactly (shareReadsExactly): an unreadable one earns nothing on this
 * read. An absent or null end still means no end. Synthetic store.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { listPartners } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};
  const owner = "partnerread@example.com";
  await claimHandle(owner, "partnerread", "Partner Read", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Readxxxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_read", subscriptionId: "sub_read", active: true, tier: "creator", period: paidPeriod() });
  const person = (id: string, share: unknown) => ({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share, cleared: null, by: null });
  const rows: [string, unknown][] = [
    ["aaaaaaaaaaaa", { percent: 20, products: [A] }],
    ["bbbbbbbbbbbb", { percent: 20, products: [A], until: null }],
    ["cccccccccccc", { percent: 20, products: [A], until: 4_102_444_800 }],
    ["dddddddddddd", { percent: 20, products: [A], until: "soon" }],
    ["eeeeeeeeeeee", { percent: 20, products: [A], until: true }],
    ["ffffffffffff", { percent: 20, products: [A], until: 1.5 }],
  ];
  for (const [id, share] of rows) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person(id, share))]]);

  part("Only a share that reads exactly earns");
  const ids = (await listPartners((await storeForEmail(owner))!)).map((p) => p.id).sort();
  is("no end, a null end and a real end are partners; an end that does not read is not", ids, ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
