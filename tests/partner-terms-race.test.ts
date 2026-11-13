/**
 * 630 [HN6](39) on main's write path (#1924 port): the concurrency the PR's own proofs (g-1924-return-proof,
 * partner-share-commit) held, re-held against the program's partner lock and the compare-and-swap of one record.
 * A yes whose lock ran out never writes over a newer request or a removal; two partners saying yes at once never pass
 * the 90% cap together; a share past its end takes no room under the cap and is not counted again when its holder is
 * let back in. Synthetic store, the in-memory Redis stand-in.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { answerShareChange, changeIdentity, decideWhy, listPartners, partnerShareProblem, proposePartnerShare, readAffiliate } from "@/lib/affiliates";
import { MAX_COMMITTED_SHARE } from "@/lib/partner-share";
import { LockBusyError } from "@/lib/redis-lock";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";
const DAY = 86400;
const [p, q] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];

async function fixture() {
  redis.clear();
  const owner = "termsrace@example.test";
  await claimHandle(owner, "termsrace", "Terms Race", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Termsracexxxxx", true);
  await setSubscription(owner, { customerId: "cus_termsrace", subscriptionId: "sub_termsrace", active: true, tier: "creator", period: paidPeriod() });
  // The affiliate commission rides on the same sale: 20% here, so two partners at 40% would promise 100%.
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 20, days: 30 }));
  for (const id of [p, q]) {
    const person = { id, email: `${id}@example.test`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null };
    await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person)]]);
  }
  return (await storeForEmail(owner))!;
}

const seen = async (store: Awaited<ReturnType<typeof fixture>>, id: string) => {
  const change = (await readAffiliate(store, id))!.terms?.change;
  if (!change) throw new Error("no change waiting");
  return changeIdentity(change);
};
const outcome = (work: Promise<unknown>) =>
  work.then(
    (value) => JSON.stringify(value),
    (error: unknown) => (error instanceof LockBusyError ? "busy" : error instanceof UnknownReplyError ? "unsure" : `threw ${String(error)}`),
  );

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const until = now + 90 * DAY;

  part("A yes whose partner lock ran out never writes over a newer request");
  {
    const store = await fixture();
    await proposePartnerShare(store, p, { percent: 30, products: [A], until }, now);
    await proposePartnerShare(store, p, { percent: 20, products: [A], until }, now + 1);
    let reached = 0;
    const result = await outcome(
      answerShareChange(store, p, true, await seen(store, p), now + 2, async () => {
        reached += 1;
        // The lock is a lease of 15 seconds: past it, the store saves the share in force again, which withdraws the request.
        redis.advance(16_000);
        await proposePartnerShare(store, p, { percent: 30, products: [A], until }, now + 12);
        return true;
      }),
    );
    const final = (await readAffiliate(store, p))!;
    is("the partner's own check ran", reached, 1);
    is("the stale yes writes nothing: busy", result, "busy");
    is("the newer state stands: the share in force, no request left", [final.share?.percent, final.terms?.change ?? null], [30, null]);
  }

  part("A yes whose partner lock ran out never brings back a partner the store removed");
  {
    const store = await fixture();
    await proposePartnerShare(store, p, { percent: 30, products: [A] }, now);
    await proposePartnerShare(store, p, { percent: 20, products: [A] }, now + 1);
    const result = await outcome(
      answerShareChange(store, p, true, await seen(store, p), now + 2, async () => {
        redis.advance(16_000);
        await decideWhy(store, p, "remove", now + 12);
        return true;
      }),
    );
    const final = (await readAffiliate(store, p))!;
    is("the stale yes writes nothing: busy", result, "busy");
    is("removed, the share kept as it was, the request taken back", [final.status, final.share, final.terms?.change ?? null], ["removed", { percent: 30, products: [A] }, null]);
  }

  part("Two partners saying yes at once never pass the cap together");
  {
    const store = await fixture();
    for (const id of [p, q]) {
      await proposePartnerShare(store, id, { percent: 10, products: [A], until }, now);
      await proposePartnerShare(store, id, { percent: 40, products: [A], until }, now + 1);
    }
    const ids = await Promise.all([p, q].map((id) => seen(store, id)));
    const results = await Promise.all(
      [p, q].map((id, i) =>
        outcome(answerShareChange(store, id, true, ids[i], now + 2, async (share) => (await partnerShareProblem(store, share, id, undefined, now + 2)) === null)),
      ),
    );
    const committed = 20 + (await listPartners(store)).reduce((sum, a) => sum + (a.share?.percent ?? 0), 0);
    is("one yes applied, the other refused by the cap the first one used", [...results].sort(), [JSON.stringify({ ok: false, reason: "cap" }), JSON.stringify({ ok: true, state: "changed" })]);
    is(`never more than ${MAX_COMMITTED_SHARE}% of a sale`, committed <= MAX_COMMITTED_SHARE, true);
  }

  part("A share past its end takes no room, and is not counted again when its holder is let back in");
  {
    const store = await fixture();
    await proposePartnerShare(store, p, { percent: 60, products: [A] }, now - 10);
    is("a second partner at 20% does not fit while the first runs", (await proposePartnerShare(store, q, { percent: 20, products: [A] }, now - 9)).ok, false);
    // The store ends the first share (until revoked: at once), and removes them.
    await proposePartnerShare(store, p, null, now - 8);
    await decideWhy(store, p, "remove", now - 7);
    is("the first share is kept as it ended", (await readAffiliate(store, p))!.share, { percent: 60, products: [A], until: now - 8 });
    is("now the second fits", await proposePartnerShare(store, q, { percent: 60, products: [A] }, now - 6), { ok: true, state: "started" });
    const back = await decideWhy(store, p, "restore", now);
    is("letting the first back in is not refused for a share that has ended", [back.ok, back.ok && back.affiliate.status], [true, "approved"]);
    is("and nothing past the cap is promised", 20 + (await listPartners(store)).filter((a) => a.status === "approved" && a.share && (a.share.until ?? Infinity) > now).reduce((sum, a) => sum + a.share!.percent, 0) <= MAX_COMMITTED_SHARE, true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
