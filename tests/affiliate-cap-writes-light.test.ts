/**
 * The light findings of the pre-review of claude5/affiliate-cap-writes. Synthetic only: the in-memory Redis double,
 * the real lib/affiliates.ts and the real route app/api/store/affiliates/route.ts, and the studio's source.
 *
 * 1. Approving several with none approved does not say anybody was emailed.
 * 2. Leaving the program's commission for an own share that pays less on every product is a reduction: written without
 *    reading the program's people, never refused for them. One that pays more on any product is still checked.
 * 3. A save of the program's terms that does not raise them over what the request read is still checked under the
 *    partner lock: a commission lowered meanwhile, and the room it left taken by a partner, is never put back above
 *    the 90% cap.
 * 4. A bulk change whose people could not be read names each of them, never skips them in silence; somebody no longer
 *    on the list is said as such, not "try again"; a product with its 10 partners is said as such, not "90%".
 * 5. The notes that list who was left out put the list in a block element, never a <ul> inside a <span>.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAffiliate, setAffiliateRate } from "@/lib/affiliates";
import { heldLines, readHeld } from "@/lib/affiliate-bulk-words";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
let peopleQueued = false;
let recordsQueued = false;
/** Runs once, just before the first lock this request takes on the store or the partners: another tab's writes. */
let beforeLock: (() => Promise<void>) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const people = one && /^nl:aff:[^:]+:people$/.test(String(one[1]));
  if (peopleQueued && people && one?.[0] === "HGETALL") {
    await real(commands);
    return ["QUEUED"];
  }
  if (recordsQueued && people && (one?.[0] === "HGET" || one?.[0] === "HMGET")) {
    await real(commands);
    return ["QUEUED"];
  }
  if (beforeLock && one?.[0] === "SET" && one.includes("NX") && /^(?:nl:store:lock:.*|.*:partners:lock)$/.test(String(one[1]))) {
    const run = beforeLock;
    beforeLock = null;
    await run();
  }
  return real(commands);
}) as typeof redis.pipeline;

type Reply = { status: number; body: { ok?: boolean; error?: string; before?: { id: string }[]; held?: unknown; refused?: unknown } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "joiner@example.com";
  await claimHandle(owner, "joinershop", "Joiner store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1joinershoe830", true);
  await setSubscription(owner, { customerId: "cus_joiner", subscriptionId: "sub_joiner", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>): Promise<Reply> => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  };
  const p = await addProduct(owner, "Oak Course", "", "40");
  const q = await addProduct(owner, "Pine Course", "", "40");
  const P = p.ok ? p.product.id : "";
  const Q = q.ok ? q.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 30, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 30% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const people = `nl:aff:${(await store()).statsId}:people`;
  const person = (id: string, status: string, rate: number | null, share: { percent: number; products: string[] } | null = null) =>
    JSON.stringify({ id, email: `${id}@example.com`, code: `c${id}`, status, appliedAt: 1, decidedAt: 1, note: "", rate, paypal: "", share, cleared: null, by: null });
  const A = "aaaaaaaaaaaa";
  const B = "bbbbbbbbbbbb";
  const X = "eeeeeeeeeeee";
  await real([["HSET", people, A, person(A, "approved", null)], ["HSET", people, B, person(B, "pending", null)]]);
  const rateOf = async (id: string) => (await readAffiliate(await store(), id))?.rate;

  part("1. Approving several, none approved: nobody is said to be emailed");
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  const note = studio.slice(studio.indexOf("{lastBulk ? ("), studio.indexOf("{lastBulk.held.length ? ("));
  is("the email sentence is said only when somebody was approved", /lastBulk\.decision === "approve" && lastBulk\.before\.length/.test(note), true);

  part("2. From the program's 30% to an own 20%: pays less on every product, so it is a reduction");
  peopleQueued = true;
  const lower = await setAffiliateRate(await store(), A, 20).then((a) => a?.rate, (error: unknown) => `error:${(error as Error).name}`);
  peopleQueued = false;
  is("written without reading the program's people", [lower, await rateOf(A)], [20, 20]);
  await real([["HSET", people, A, person(A, "approved", null)]]);
  is("(the oak course earns 10% of its own)", (await post({ ...terms, rates: { [P]: 10 } })).body.ok, true);
  peopleQueued = true;
  const raise = await setAffiliateRate(await store(), A, 20).then((a) => a?.rate, (error: unknown) => `error:${(error as Error).name}`);
  peopleQueued = false;
  is("an own 20% raises the oak course (10 to 20%): still checked, unknown people refused", [raise, await rateOf(A)], ["error:UnknownReplyError", null]);
  is("(the oak course back to the program's 30%)", (await post(terms)).body.ok, true);

  part("3. Saving 30% again from a tab read before the commission was lowered and a partner took the room");
  beforeLock = async () => {
    // Another tab: the commission is lowered to 10%, then X is made a partner with 80% of the oak course (80 + 10).
    await setAffiliateSetting(owner, { ...(await store()).affiliates, percent: 10 });
    await real([["HSET", people, X, person(X, "approved", null, { percent: 80, products: [P] })]]);
  };
  const stale = await post(terms);
  beforeLock = null;
  is("refused by the cap (80 + 30 = 110%), not saved", [stale.status, stale.body.error, (await store()).affiliates.percent], [409, "share_committed", 10]);
  await real([["HDEL", people, X]]);
  is("(back to 30%)", (await post(terms)).body.ok, true);

  part("4. Bulk changes whose people cannot be read, or are no longer on the list");
  recordsQueued = true;
  const blindApprove = await post({ action: "bulk", decision: "approve", ids: [B] });
  const blindRate = await post({ action: "bulk-rate", ids: [A], rate: 25 });
  recordsQueued = false;
  is("approving: B named as not checked", [blindApprove.status, readHeld(blindApprove.body.held).map((h) => [h.id, h.why])], [200, [[B, "unavailable"]]]);
  is("B still waits", (await readAffiliate(await store(), B))?.status, "pending");
  is("a share: A named as not checked", [blindRate.status, readHeld(blindRate.body.refused).map((h) => [h.id, h.why])], [200, [[A, "unavailable"]]]);
  is("A keeps theirs", await rateOf(A), null);
  const ghost = "ffffffffffff";
  const gone = await post({ action: "bulk", decision: "approve", ids: [ghost] });
  is("somebody no longer on the list is named as such", readHeld(gone.body.held).map((h) => [h.id, h.why]), [[ghost, "gone"]]);
  const goneWords = heldLines([{ id: ghost, email: "g@example.com", why: "gone" }], "approve");
  is("in words that do not ask to try again", goneWords, ["g@example.com is no longer on your list, so nothing was changed for them."]);
  is("one not named by the server is named from the studio's own list", heldLines(readHeld([{ id: ghost, email: "", why: "gone" }], [{ id: ghost, email: "g@example.com" }]), "rate"), ["g@example.com is no longer on your list, so nothing was changed for them."]);
  is(
    "a product with its 10 partners is said as such",
    heldLines([{ id: B, email: "b@example.com", why: "crowded" }], "approve"),
    ["b@example.com is still waiting. Approving them would give a product more than 10 partners. Lower the number of partners on it first, then approve them."],
  );

  part("5. The lists of who was left out are block elements");
  is("no <ul> inside a <span>", /<span>\s*\{`\$\{(lastBulk|last)\.before\.length/.test(studio), false);
  void Q;
  done();
}
main();
