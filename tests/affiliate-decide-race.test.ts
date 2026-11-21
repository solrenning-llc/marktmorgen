/**
 * Approving somebody read with no share, while the creator gives them a share meanwhile, never passes the 90% cap
 * (pre-review of claude5/affiliate-cap-writes, MEDIUM 1). Synthetic only: the in-memory Redis double and the real
 * lib/affiliates.ts decide.
 *
 * Before: decide read A with no share, so it took no partner lock; the record was written over the record as it is
 * now, which by then held an 80% share, and A was approved with it. With B approved meanwhile at 80% of the same
 * product (its check saw A still waiting), the product promised 80 + 80 + 5 = 165% of a sale.
 *
 * Now: when the record holds a share that becomes counted, the decision goes again under the partner lock and is
 * checked against the partners read exactly now: refused (ShareCapError), A left waiting.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ShareCapError, decide, readAffiliate } from "@/lib/affiliates";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Runs once, right after the first read of this record: what the creator did in another tab meanwhile. */
let meanwhile: { field: string; run: () => Promise<void> } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  const one = commands.length === 1 ? commands[0] : null;
  if (meanwhile && one?.[0] === "HGET" && /^nl:aff:[^:]+:people$/.test(String(one[1])) && one[2] === meanwhile.field) {
    const run = meanwhile.run;
    meanwhile = null;
    await run();
  }
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "potter@example.com";
  await claimHandle(owner, "pottershop", "Potter store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1pottersho9b06", true);
  await setSubscription(owner, { customerId: "cus_potter", subscriptionId: "sub_potter", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Clay Course", "", "40");
  const P = made.ok ? made.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const people = `nl:aff:${(await store()).statsId}:people`;
  const person = (id: string, status: string, share: { percent: number; products: string[] } | null) =>
    JSON.stringify({ id, email: `${id}@example.com`, code: `c${id}`, status, appliedAt: 1, decidedAt: 1, note: "", rate: null, paypal: "", share, cleared: null, by: null });
  const A = "aaaaaaaaaaaa";
  const B = "bbbbbbbbbbbb";
  await real([["HSET", people, A, person(A, "pending", null)], ["HSET", people, B, person(B, "pending", null)]]);

  part("1. Approving A, read with no share, while A is given 80% and B is approved with 80% meanwhile");
  meanwhile = {
    field: A,
    run: async () => {
      // The creator's other tab: A (still waiting) is given 80% of the course, which passes alone (80 + 5 = 85),
      // and B is approved with 80% of it, which passes too: A is not approved, so A's share does not count yet.
      await real([["HSET", people, A, person(A, "pending", { percent: 80, products: [P] })]]);
      await real([["HSET", people, B, person(B, "approved", { percent: 80, products: [P] })]]);
    },
  };
  const result = await decide(await store(), A, "approve").then(
    (next) => (next ? next.status : "nothing"),
    (error: unknown) => (error instanceof ShareCapError ? `cap:${error.problem}` : `error:${String(error)}`),
  );
  is("refused by the cap, not approved over the share given meanwhile", result.startsWith("cap:"), true);
  const a = await readAffiliate(await store(), A);
  is("A still waits, with the share it was given", [a?.status, a?.share], ["pending", { percent: 80, products: [P] }]);

  part("2. Approving A when nothing changed meanwhile, with no share: approved at once");
  await real([["HSET", people, A, person(A, "pending", null)]]);
  const plain = await decide(await store(), A, "approve");
  is("approved", plain?.status, "approved");
  done();
}
main();
