/**
 * 630 [HN6](39) on main (claude3/keep/c-hn6-on-main), Codex G's MEDIUM on #1924 ported to main's design: the 90% cap
 * read the program's people with peopleExact, which drops a record that does not parse, and parseAffiliate, which reads
 * a share that does not parse as no share and an unknown status as "pending". Either way a partner's running share
 * vanished from the cap, and a new share could be promised past it. Now the cap reads every record exactly: one that
 * does not read whole, a share that does not read, or a status that does not read next to a share is unknown
 * (UnknownReplyError), and nothing is promised. A record written before shares existed (no share field) still reads.
 * Synthetic store.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { partnerShareProblem, proposePartnerShare } from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";

async function main(): Promise<void> {
  redis.clear();
  const owner = "partnercap@example.com";
  await claimHandle(owner, "partnercap", "Partner Cap", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Capxxxxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_cap", subscriptionId: "sub_cap", active: true, tier: "creator", period: paidPeriod() });
  const key = `nl:aff:${statsId}:people`;
  const person = (id: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null, ...extra });
  const me = "aaaaaaaaaaaa";
  await redis.pipeline([["HSET", key, me, JSON.stringify(person(me))]]);
  const store = async () => (await storeForEmail(owner))!;
  const outcome = (promise: Promise<unknown>) => promise.then((value) => JSON.stringify(value), (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`));

  part("Control: an old record with no share field, and a readable partner, still read");
  const old: Record<string, unknown> = person("bbbbbbbbbbbb");
  delete old.share;
  await redis.pipeline([["HSET", key, "bbbbbbbbbbbb", JSON.stringify(old)]]);
  await redis.pipeline([["HSET", key, "cccccccccccc", JSON.stringify(person("cccccccccccc", { share: { percent: 30, products: [A] } }))]]);
  is("a share that fits is checked and passes", await outcome(partnerShareProblem(await store(), { percent: 20, products: [A] }, me)), "null");

  const cases: [string, string][] = [
    ["a record that is not JSON", "{not json"],
    ["a share that does not parse", JSON.stringify(person("dddddddddddd", { share: { percent: "lots", products: [A] } }))],
    ["a share whose products do not read", JSON.stringify(person("dddddddddddd", { share: { percent: 30, products: [A, 7] } }))],
    ["a status that does not read next to a share", JSON.stringify(person("dddddddddddd", { status: "weird", share: { percent: 30, products: [A] } }))],
  ];
  for (const [label, raw] of cases) {
    part(`The cap meets ${label}`);
    await redis.pipeline([["HSET", key, "dddddddddddd", raw]]);
    is(`${label}: the cap is unknown, never passed`, await outcome(partnerShareProblem(await store(), { percent: 20, products: [A] }, me)), "unknown");
    is(`${label}: a share asked for is not written`, [await outcome(proposePartnerShare(await store(), me, { percent: 20, products: [A] }, Math.floor(Date.now() / 1000))), (JSON.parse(String((await redis.pipeline([["HGET", key, me]]))[0])) as { share: unknown }).share], ["unknown", null]);
    await redis.pipeline([["HDEL", key, "dddddddddddd"]]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
