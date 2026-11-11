/**
 * 630 [HN6](39), unit 2, the creator's decisions (rewritten on main's partner lock in claude3/keep/c-hn6-on-main; ported
 * from #1924, tests/partner-terms-kept.test.ts): a partner whose dated share is still in force is not removed or
 * declined by the store alone, in one decision or in bulk; an undo in bulk never sends someone given a share since back
 * to waiting; a removal racing the partner's yes is never undone by it. Synthetic store.
 *
 * TODO(#1924, 4 open points awaiting Claude 1, canal para-claude-1 11/11/2026): #1924 also ended a share "until
 * revoked" when its partner was removed (share set to null, a "revoked" step). Main keeps a removed partner's share on
 * the record (it counts again, cap checked, if they are restored); that reading is kept here until Claude 1 decides.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { answerShareChange, changeIdentity, decide, decideMany, decideWhy, proposePartnerShare, readAffiliate, undoMany } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";
const B = "prodbbbbbb";
const DAY = 86400;

async function main(): Promise<void> {
  redis.clear();
  const owner = "partnerdecide@example.com";
  await claimHandle(owner, "partnerdecide", "Partner Decide", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Decidexxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_decide", subscriptionId: "sub_decide", active: true, tier: "creator", period: paidPeriod() });
  const person = (id: string) => ({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null });
  const put = (record: object & { id: string }) => redis.pipeline([["HSET", `nl:aff:${statsId}:people`, record.id, JSON.stringify(record)]]);
  const store = async () => (await storeForEmail(owner))!;
  const read = async (id: string) => (await readAffiliate(await store(), id))!;
  const seen = async (id: string) => {
    const change = (await read(id)).terms?.change;
    return change ? changeIdentity(change) : "";
  };
  const T = Math.floor(Date.now() / 1000);

  part("A dated share in force is not removed by the store alone");
  const [d, u, x] = ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"];
  for (const id of [d, u, x]) await put(person(id));
  await proposePartnerShare(await store(), d, { percent: 20, products: [A], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), u, { percent: 20, products: [B] }, T);
  await proposePartnerShare(await store(), x, { percent: 20, products: [B], until: T + 60 * DAY }, T);
  is("remove is refused", await decide(await store(), d, "remove"), null);
  is("decline is refused too", await decide(await store(), d, "decline"), null);
  is("they stay approved, with their share and no new step", [(await read(d)).status, (await read(d)).share?.percent, (await read(d)).terms?.history.length], ["approved", 20, 1]);
  const removedU = await decide(await store(), u, "remove");
  is("a share until revoked can be removed (the share kept on the record, as on main)", [removedU?.status, removedU?.share?.percent], ["removed", 20]);
  const after = await decideWhy(await store(), x, "remove", T + 61 * DAY);
  is("after the end date it can be removed, the share left as it ended", [after.ok, after.ok ? after.affiliate.status : "", after.ok ? after.affiliate.share?.until : 0], [true, "removed", T + 60 * DAY]);
  is("with no step saying the store ended it: it ended on its date", (await read(x)).terms?.history.map((s) => s.kind), ["started"]);

  part("Refused with its own reason, whatever the status");
  const w = "abababababab";
  await put({ ...person(w), status: "pending", share: { percent: 10, products: [A], until: T + 30 * DAY } });
  is("somebody waiting who holds a dated share in force is not declined", await decideWhy(await store(), w, "decline", T + 1), { ok: false, reason: "term" });
  is("the dated partner's removal says why", await decideWhy(await store(), d, "remove", T + 1), { ok: false, reason: "term" });
  is("an unknown one says unknown", await decideWhy(await store(), "acacacacacac", "remove", T + 1), { ok: false, reason: "unknown" });
  const bulk = await decideMany(await store(), [w], "decline");
  is("in bulk it is never touched either, and the reason is said", [bulk.before, bulk.held.map((h) => h.why), (await read(w)).status], [[], ["term"], "pending"]);

  part("Taking someone out withdraws a change still waiting, in the history");
  const k = "acdcacdcacdc";
  await put(person(k));
  await proposePartnerShare(await store(), k, { percent: 10, products: [B] }, T);
  await proposePartnerShare(await store(), k, { percent: 25, products: [B] }, T + 5);
  is("(a raise waits for their yes)", (await read(k)).terms?.change?.share?.percent, 25);
  await decide(await store(), k, "remove");
  is("removed, the change withdrawn and written down", [(await read(k)).status, (await read(k)).terms?.change ?? null, (await read(k)).terms?.history.at(-1)?.kind], ["removed", null, "withdrawn"]);

  part("An undo never sends a partner back to waiting");
  const v = "bcbcbcbcbcbc";
  await put({ ...person(v), status: "pending", decidedAt: 0 });
  const approved = await decideMany(await store(), [v], "approve");
  is("approved in bulk", (await read(v)).status, "approved");
  await proposePartnerShare(await store(), v, { percent: 15, products: [A], until: T + 60 * DAY }, T + 3);
  is("the undo leaves a partner given a dated share since as they are", [(await undoMany(await store(), approved.before, "approve")).undone, (await read(v)).status], [0, "approved"]);
  is("so they cannot then be declined around their term", await decideWhy(await store(), v, "decline", T + 4), { ok: false, reason: "term" });
  const v2 = "cdcdcdcdcdcd";
  await put({ ...person(v2), status: "pending", decidedAt: 0 });
  const approved2 = await decideMany(await store(), [v2], "approve");
  is("an approval with nothing given since is still undone", [(await undoMany(await store(), approved2.before, "approve")).undone, (await read(v2)).status], [1, "pending"]);

  part("A removal racing a yes is never undone by it");
  const e = "fafafafafafa";
  await put(person(e));
  await proposePartnerShare(await store(), e, { percent: 10, products: [B] }, T);
  await proposePartnerShare(await store(), e, { percent: 40, products: [B] }, T + 1);
  const eSeen = await seen(e);
  const slowYes = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return true;
  };
  const shop = await store();
  await Promise.all([answerShareChange(shop, e, true, eSeen, T + 2, slowYes), decide(shop, e, "remove")]);
  const eEnd = await read(e);
  is("removed, with no change left waiting", [eEnd.status, eEnd.terms?.change ?? null], ["removed", null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
