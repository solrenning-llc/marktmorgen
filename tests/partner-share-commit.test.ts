/**
 * A partner's share decided on what was read, under the program's partner lock (630 [HN6](39), PR #1924, ported onto
 * main's write path: withPartnerLock, partnerShareProblem, changeAffiliate's swap over the exact record read).
 *
 * Held here for good, from the reviews of #1924:
 *  - partners of the same product answering at once never promise more than MAX_COMMITTED_SHARE together (the
 *    partner lock serializes every write of a share, and each yes checks the cap against the people read under it);
 *  - an invitation accepted and a yes at the same instant never pass the cap together;
 *  - a partner's share or status that does not read is unknown to the cap, never "no share" (Codex G);
 *  - a partner's end that does not read never earns after the agreement (Codex M).
 * The per-person lock, the commitment version and PUT_AFFILIATE that this file used to hold are gone: main's own
 * tests hold its lock and swap (affiliate-record-swap, affiliate-partner-accept-cap, affiliate-partner-approve-cap).
 *
 * Synthetic records in the in-memory Redis; no email, no payment.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import * as affiliates from "@/lib/affiliates";
import { acceptPartnership, answerShareChange, changeIdentity, listPartners, partnerShareProblem, proposePartnerShare, readAffiliate } from "@/lib/affiliates";
import { MAX_COMMITTED_SHARE, shareReadsExactly } from "@/lib/partner-share";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, part, done } from "./check";

const A = "prodaaaaaa";
const p = "aaaaaaaaaaaa";
const q = "bbbbbbbbbbbb";
const r = "cccccccccccc";
const now = Math.floor(Date.now() / 1000);
const until = now + 90 * 86400;

async function fixture(ids: string[] = [p, q]) {
  redis.clear();
  const owner = "commit@example.test";
  await claimHandle(owner, "commitshop", "Commit Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Commitxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_commit", subscriptionId: "sub_commit", active: true, tier: "creator", period: paidPeriod() });
  // The affiliate commission on every product: 20%, which rides on the same sale as every partner.
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 20, days: 30 }));
  const store = (await storeForEmail(owner))!;
  for (const id of ids) {
    const record = { id, email: `${id}@example.test`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null };
    await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(record)]]);
  }
  return { store, statsId };
}

const field = async (statsId: string, id: string) => (await redis.pipeline([["HGET", `nl:aff:${statsId}:people`, id]]))[0];
type Shop = Awaited<ReturnType<typeof fixture>>["store"];
const committedOn = async (store: Shop) =>
  20 + (await listPartners(store)).filter((a) => a.status === "approved").reduce((sum, a) => sum + (a.share?.products.includes(A) ? a.share.percent : 0), 0);
const seenOf = async (store: Shop, id: string) => {
  const change = (await readAffiliate(store, id))?.terms?.change;
  if (!change) throw new Error("fixture: no waiting change");
  return changeIdentity(change);
};

async function main() {
  part("Three partners saying yes at once never pass the cap");
  {
    const { store } = await fixture([p, q, r]);
    for (const id of [p, q, r]) {
      await proposePartnerShare(store, id, { percent: 5, products: [A], until }, now);
      await proposePartnerShare(store, id, { percent: 30, products: [A], until }, now + 1);
    }
    const seen = await Promise.all([p, q, r].map((id) => seenOf(store, id)));
    await Promise.all([p, q, r].map((id, i) => answerShareChange(store, id, true, seen[i], now + 2)));
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
  }

  part("An invitation and a partner's yes at once never pass the cap together");
  {
    const { store } = await fixture();
    await proposePartnerShare(store, p, { percent: 10, products: [A], until }, now);
    await proposePartnerShare(store, p, { percent: 40, products: [A], until }, now + 1);
    const seen = await seenOf(store, p);
    const [answer, joined] = await Promise.all([
      answerShareChange(store, p, true, seen, now + 2),
      acceptPartnership(store, "invited@example.test", { percent: 40, products: [A] }),
    ]);
    is("at most one of the two takes the room", [answer.ok, joined.ok].filter(Boolean).length <= 1, true);
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
  }

  part("A partner's share that does not read is unknown to the cap, never no share");
  {
    is("absent and null shares read as no share", [shareReadsExactly(undefined), shareReadsExactly(null)], [true, true]);
    is("a whole share reads", shareReadsExactly({ percent: 40, products: [A], until }), true);
    is("a whole-number percent typed as a string still reads", shareReadsExactly({ percent: "40", products: [A] }), true);
    for (const [what, share] of [
      ["a word", "unknown"],
      ["a percent that is a word", { percent: "unknown", products: [A] }],
      ["a percent out of range", { percent: 0, products: [A] }],
      ["a product that does not read", { percent: 40, products: [A, 7] }],
      ["no product list", { percent: 40 }],
      ["an end that is a word", { percent: 40, products: [A], until: "soon" }],
      ["a list", [40]],
    ] as const) {
      is(`${what} does not read`, shareReadsExactly(share), false);
    }
    for (const [what, change] of [
      ["share", (value: Record<string, unknown>) => ({ ...value, share: "unknown" })],
      ["percent", (value: Record<string, unknown>) => ({ ...value, share: { ...(value.share as object), percent: "unknown" } })],
      ["status", (value: Record<string, unknown>) => ({ ...value, status: "unknown" })],
    ] as const) {
      const { store, statsId } = await fixture();
      await proposePartnerShare(store, q, { percent: 40, products: [A], until }, now);
      const stored = JSON.parse(String(await field(statsId, q))) as Record<string, unknown>;
      await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, q, JSON.stringify(change(stored))]]);
      const refused = await partnerShareProblem(store, { percent: 40, products: [A] }, p).then(
        () => false,
        (error: unknown) => error instanceof UnknownReplyError,
      );
      is(`a partner's ${what} that does not read makes the cap read unknown`, refused, true);
    }
    {
      const { store, statsId } = await fixture();
      // A record from before shares existed: no share field at all, still read as holding none.
      const old = { id: r, email: `${r}@example.test`, code: `c${r}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "" };
      await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, r, JSON.stringify(old)]]);
      is("a record from before shares still reads: the cap is known", await partnerShareProblem(store, { percent: 40, products: [A] }, p), null);
    }
  }

  part("A partner's end that does not read never earns after the agreement");
  {
    const start = now - 2 * 86400;
    const end = start + 86400;
    const sharesOf = async (statsId: string) => {
      const reply = (await redis.pipeline([["HGETALL", `nl:aff:${statsId}:shares`]]))[0] as string[];
      const out: Record<string, number> = {};
      for (let i = 0; i + 1 < reply.length; i += 2) out[reply[i]] = (JSON.parse(reply[i + 1]) as { percent: number }).percent;
      return out;
    };
    const sale = (ref: string, at: number) => ({ ref, pi: `pi_${ref}`, at, product: A, title: "Pottery", base: 1000, total: 1000, currency: "usd", buyer: "buyer@example.test" });
    // p holds a running 20% with no end; q a dated 40% that ended yesterday.
    const twoPartners = async () => {
      const shop = await fixture();
      is("p starts with no end", (await proposePartnerShare(shop.store, p, { percent: 20, products: [A] }, start)).ok, true);
      is("q starts with an end", (await proposePartnerShare(shop.store, q, { percent: 40, products: [A], until: end }, start)).ok, true);
      return shop;
    };
    const setUntil = async (statsId: string, value: unknown) => {
      const people = `nl:aff:${statsId}:people`;
      const stored = JSON.parse(String(await field(statsId, q))) as { share: Record<string, unknown> };
      if (value === undefined) delete stored.share.until;
      else stored.share.until = value;
      await redis.pipeline([["HSET", people, q, JSON.stringify(stored)]]);
    };
    for (const [what, bad] of [
      ["a word", "unknown"],
      ["a boolean", true],
      ["a fraction", end + 0.5],
    ] as const) {
      for (const route of ["read here", "read by the sweep"] as const) {
        const { store, statsId } = await twoPartners();
        await setUntil(statsId, bad);
        const ref = `cs_test_bad_${route === "read here" ? "here" : "sweep"}`;
        let outcome = "returned";
        try {
          if (route === "read here") await affiliates.notePartners(store, sale(ref, end + 1));
          else await affiliates.notePartners(store, sale(ref, end + 1), await listPartners(store));
        } catch {
          outcome = "thrown";
        }
        is(`${what} (${route}): the sale is still processed`, outcome, "returned");
        is(`${what} (${route}): no earning from the unreadable agreement, the other partner still credited`, await sharesOf(statsId), { [`${ref}:${p}`]: 20 });
      }
    }
    {
      const { store, statsId } = await twoPartners();
      await affiliates.notePartners(store, sale("cs_test_after", end + 1));
      is("a healthy end: nothing earned after it", await sharesOf(statsId), { [`cs_test_after:${p}`]: 20 });
      await affiliates.notePartners(store, sale("cs_test_before", end - 1));
      is("a healthy end: earned before it", (await sharesOf(statsId))[`cs_test_before:${q}`], 40);
    }
    for (const [what, value] of [
      ["no end field", undefined],
      ["an end that is null", null],
    ] as const) {
      const { store, statsId } = await twoPartners();
      await setUntil(statsId, value);
      await affiliates.notePartners(store, sale("cs_test_open", end + 1), await listPartners(store));
      is(`${what} still means no end: earned`, await sharesOf(statsId), { [`cs_test_open:${p}`]: 20, [`cs_test_open:${q}`]: 40 });
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
