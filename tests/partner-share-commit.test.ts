/**
 * A partner's share is decided on what was read and written only over it.
 *
 * Two reviewer findings on 630 [HN6](39) (PR #1924), held here for good:
 *
 *  - the per-person lock is a lease (lib/affiliates.ts withPerson): a write
 *    that resumes after it ran out must not put back a record somebody has
 *    changed since (PUT_AFFILIATE writes only over the exact field read);
 *  - locks per partner do not serialize partners of the same product: two
 *    shares checked against the same picture must not both be written, or a
 *    product promises more than MAX_COMMITTED_SHARE (every write moves the
 *    store's commitment version; a share that starts to count is written
 *    only while it has not moved since the check).
 *
 * Synthetic records in the in-memory Redis; no email, no payment.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import * as affiliates from "@/lib/affiliates";
import { acceptPartnership, answerShareChange, changeIdentity, decide, decideWhy, listPartners, proposePartnerShare, readAffiliate, setAffiliateRate, sharePromiseProblem } from "@/lib/affiliates";
import { MAX_COMMITTED_SHARE, shareReadsExactly } from "@/lib/partner-share";
import { LockBusyError } from "@/lib/redis-lock";
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
const version = async (statsId: string) => (await redis.pipeline([["GET", `nl:aff:${statsId}:sharever`]]))[0] ?? "0";
type Shop = Awaited<ReturnType<typeof fixture>>["store"];
const committedOn = async (store: Shop) =>
  20 + (await listPartners(store)).filter((a) => a.status === "approved").reduce((sum, a) => sum + (a.share?.products.includes(A) ? a.share.percent : 0), 0);
const seenOf = async (store: Shop, id: string) => {
  const change = (await readAffiliate(store, id))?.terms?.change;
  if (!change) throw new Error("fixture: no waiting change");
  return changeIdentity(change);
};

async function main() {
  part("A partner's yes that resumes after the person lock ran out writes nothing over a newer request");
  {
    const { store } = await fixture();
    await proposePartnerShare(store, p, { percent: 30, products: [A], until }, now);
    await proposePartnerShare(store, p, { percent: 20, products: [A], until }, now + 1);
    const shown = await seenOf(store, p);
    const answer = await answerShareChange(store, p, true, shown, now + 2, async () => {
      // A stalled function: the lease (10 s) runs out, and the store replaces its request meanwhile.
      redis.advance(11_000);
      const replaced = await proposePartnerShare(store, p, { percent: 5, products: [A], until }, now + 12);
      is("the store's newer request is saved while the old answer is stalled", replaced, { ok: true, state: "waiting" });
      return true;
    });
    const after = (await readAffiliate(store, p))!;
    is("the stalled yes is answered busy, nothing applied", answer, { ok: false, reason: "busy" });
    is("the share in force and the newer request survive", [after.share?.percent, after.terms?.change?.share?.percent], [30, 5]);
  }

  part("A stalled yes cannot bring back a partner the store removed meanwhile");
  {
    const { store } = await fixture();
    await proposePartnerShare(store, p, { percent: 30, products: [A] }, now);
    await proposePartnerShare(store, p, { percent: 25, products: [A] }, now + 1);
    const answer = await answerShareChange(store, p, true, await seenOf(store, p), now + 2, async () => {
      redis.advance(11_000);
      await decide(store, p, "remove", now + 12);
      return true;
    });
    const after = (await readAffiliate(store, p))!;
    is("answered busy", answer, { ok: false, reason: "busy" });
    is("still removed, with no share", [after.status, after.share], ["removed", null]);
  }

  part("Two partners saying yes at once on the same product never pass the cap together");
  {
    const { store } = await fixture();
    for (const id of [p, q]) {
      await proposePartnerShare(store, id, { percent: 10, products: [A], until }, now);
      await proposePartnerShare(store, id, { percent: 40, products: [A], until }, now + 1);
    }
    const seen = await Promise.all([p, q].map((id) => seenOf(store, id)));
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const answers = await Promise.all(
      [p, q].map((id, i) =>
        answerShareChange(store, id, true, seen[i], now + 2, async (share) => {
          const fits = (await sharePromiseProblem(store, id, share, now + 2)) === null;
          ready += 1;
          if (ready === 2) release();
          await barrier;
          return fits;
        }),
      ),
    );
    is("both checks passed on the same picture", ready, 2);
    is("exactly one yes is written", answers.filter((a) => a.ok).length, 1);
    is("the other is answered busy, so the partner reads the page again", answers.filter((a) => !a.ok).map((a) => (a.ok ? "" : a.reason)), ["busy"]);
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
    // Answered again, on what is there now, the second one no longer fits.
    const loser = answers[0].ok ? q : p;
    const waiting = (await readAffiliate(store, loser))?.terms?.change;
    const again = waiting
      ? await answerShareChange(store, loser, true, changeIdentity(waiting), now + 3, async (share) => (await sharePromiseProblem(store, loser, share, now + 3)) === null)
      : "no waiting change left";
    is("answered again, the second one is refused by the cap", again, { ok: false, reason: "cap" });
  }

  part("Three partners at once, with nobody's own check in between, still never pass the cap");
  {
    const { store } = await fixture([p, q, r]);
    for (const id of [p, q, r]) {
      await proposePartnerShare(store, id, { percent: 5, products: [A], until }, now);
      await proposePartnerShare(store, id, { percent: 30, products: [A], until }, now + 1);
    }
    const seen = await Promise.all([p, q, r].map((id) => seenOf(store, id)));
    // The caller's own check always says yes: the write itself has to hold the line.
    await Promise.all([p, q, r].map((id, i) => answerShareChange(store, id, true, seen[i], now + 2, async () => true)));
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
  }

  part("A share the store starts at once is checked as it is written");
  {
    const { store, statsId } = await fixture();
    is("the first partner starts at 60%", await proposePartnerShare(store, p, { percent: 60, products: [A] }, now), { ok: true, state: "started" });
    const before = await field(statsId, q);
    const moved = await version(statsId);
    const refused = await proposePartnerShare(store, q, { percent: 20, products: [A] }, now);
    is("a second at 20% would pass 90% with the commission: refused", refused, { ok: false, reason: "cap", problem: "committed" });
    is("nothing written for them", await field(statsId, q), before);
    is("and no commitment moved", await version(statsId), moved);
  }

  part("Two shares started at once by the store never pass the cap together");
  {
    const { store } = await fixture();
    const started = await Promise.all([p, q].map((id) => proposePartnerShare(store, id, { percent: 40, products: [A] }, now)));
    is("only one starts", started.filter((s) => s.ok && s.state === "started").length, 1);
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
  }

  part("An invitation whose share no longer fits writes and claims nothing");
  {
    const { store, statsId } = await fixture();
    await proposePartnerShare(store, p, { percent: 50, products: [A] }, now);
    const opened = await acceptPartnership(store, "late@example.test", { percent: 30, products: [A] });
    is("refused with cap", opened.ok ? "made" : opened.reason, "cap");
    const [byEmail] = await redis.pipeline([["HGET", `nl:aff:${statsId}:emails`, "late@example.test"]]);
    is("the address is not claimed", byEmail, null);
    await proposePartnerShare(store, p, null, now + 5);
    const later = await acceptPartnership(store, "late@example.test", { percent: 30, products: [A] });
    is("once there is room, the same address joins", later.ok ? [later.affiliate.status, later.affiliate.share?.percent] : later.reason, ["approved", 30]);
  }

  part("An invitation and a partner's yes at once never pass the cap together");
  {
    const { store } = await fixture();
    await proposePartnerShare(store, p, { percent: 10, products: [A], until }, now);
    await proposePartnerShare(store, p, { percent: 40, products: [A], until }, now + 1);
    const seen = await seenOf(store, p);
    const [answer, joined] = await Promise.all([
      answerShareChange(store, p, true, seen, now + 2, async () => true),
      acceptPartnership(store, "invited@example.test", { percent: 40, products: [A] }),
    ]);
    is("at most one of the two takes the room", [answer.ok, joined.ok].filter(Boolean).length <= 1, true);
    is(`what the product promises stays within ${MAX_COMMITTED_SHARE}%`, (await committedOn(store)) <= MAX_COMMITTED_SHARE, true);
  }

  part("Letting a partner back in counts their running share again, checked against the cap");
  {
    const { store, statsId } = await fixture();
    await proposePartnerShare(store, q, { percent: 40, products: [A] }, now);
    const removed = { id: p, email: `${p}@example.test`, code: `c${p}`, status: "removed", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: { percent: 40, products: [A] }, cleared: null, by: null };
    await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, p, JSON.stringify(removed)]]);
    is("restoring them would pass 90%: refused", await decideWhy(store, p, "restore", now), { ok: false, reason: "cap", problem: "committed" });
    is("still removed", (await readAffiliate(store, p))?.status, "removed");
  }

  part("Every write of a record moves the commitment version, in the same step");
  {
    const { store, statsId } = await fixture();
    const before = Number(await version(statsId));
    await setAffiliateRate(store, p, 15);
    await decide(store, q, "remove", now);
    is("a rate and a removal each move it", Number(await version(statsId)), before + 2);
  }

  part("PUT_AFFILIATE writes only over the field read, and with a fence only while the version stands");
  {
    const { statsId } = await fixture();
    const script = (affiliates as Record<string, unknown>).PUT_AFFILIATE;
    is("the script is exported for this check", typeof script, "string");
    if (typeof script === "string") {
      const people = `nl:aff:${statsId}:people`;
      const ver = `nl:aff:${statsId}:sharever`;
      const read = String(await field(statsId, p));
      const put = async (there: string, expected: string, fence: string, value: string) =>
        (await redis.pipeline([["EVAL", script, 2, people, ver, p, there, expected, fence, value]]))[0];
      const v0 = String(await version(statsId));
      is("a stale field is refused", await put("1", read.replace('"note":""', '"note":"x"'), "", "{}"), 0);
      is("a write expecting no record is refused while one is there", await put("0", "", "", "{}"), 0);
      is("an old version is refused", await put("1", read, String(Number(v0) + 7), "{}"), 0);
      is("nothing written by the refused ones", [await field(statsId, p), await version(statsId)], [read, v0]);
      const next = read.replace('"note":""', '"note":"kept"');
      is("the field read, at the version read, is written", await put("1", read, v0, next), 1);
      is("and the version moved with it", [await field(statsId, p), await version(statsId)], [next, String(Number(v0) + 1)]);
      is("the script carries its version marker", String(script).startsWith("-- marktmorgen:affiliate-put:v1\n"), true);
    }
  }

  // Codex G's review of #1924 (head 485c01c7), finding 1: a record whose share, or whose status beside a share,
  // does not read is not "no commitment"; the cap read is unknown and nothing is promised on it.
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
      const people = `nl:aff:${statsId}:people`;
      const stored = JSON.parse(String(await field(statsId, q))) as Record<string, unknown>;
      await redis.pipeline([["HSET", people, q, JSON.stringify(change(stored))]]);
      let refused: unknown = null;
      try {
        await sharePromiseProblem(store, p, { percent: 40, products: [A] }, now);
      } catch (error) {
        refused = error instanceof LockBusyError;
      }
      is(`a partner's ${what} that does not read makes the cap read unknown`, refused, true);
      const started = await proposePartnerShare(store, p, { percent: 40, products: [A] }, now + 1).catch((error) => (error instanceof LockBusyError ? "busy" : error));
      is(`a share started on it is answered busy (${what})`, started, "busy");
      is(`nothing is promised on it (${what})`, (await readAffiliate(store, p))?.share ?? null, null);
    }
    {
      const { store, statsId } = await fixture();
      // A record from before shares existed: no share field at all, still read as holding none.
      const old = { id: r, email: `${r}@example.test`, code: `c${r}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "" };
      await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, r, JSON.stringify(old)]]);
      is("a record from before shares still reads: the cap is known", await sharePromiseProblem(store, p, { percent: 40, products: [A] }, now), null);
    }
  }

  // Codex G's review of #1924 (head 485c01c7), finding 2: an invitation whose write's answer was lost and whose read
  // back is lost too may have landed; its address and code are never let go on that, and its own record found again
  // is the write made.
  part("A new record whose write may have landed keeps its address and code");
  {
    const original = redis.pipeline.bind(redis);
    const isPut = (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:affiliate-put:v1\n");
    const isReadBack = (statsId: string, commands: (string | number)[][]) =>
      commands.length === 1 && commands[0]?.[0] === "HGET" && commands[0][1] === `nl:aff:${statsId}:people`;
    const claims = async (statsId: string, email: string) => {
      const [id] = await original([["HGET", `nl:aff:${statsId}:emails`, email]]);
      const [raw] = typeof id === "string" ? await original([["HGET", `nl:aff:${statsId}:people`, id]]) : [null];
      const record = typeof raw === "string" ? (JSON.parse(raw) as { code: string; status: string }) : null;
      const [byCode] = record ? await original([["HGET", `nl:aff:${statsId}:codes`, record.code]]) : [null];
      return { id, record, byCode };
    };
    for (const lost of ["empty", "null", "thrown"] as const) {
      const { store, statsId } = await fixture();
      let puts = 0;
      let backs = 0;
      redis.pipeline = (async (commands: (string | number)[][]) => {
        const out = await original(commands);
        if (isPut(commands) && puts === 0) {
          puts += 1;
          return [];
        }
        if (puts === 1 && backs === 0 && isReadBack(statsId, commands)) {
          backs += 1;
          if (lost === "thrown") throw new Error("read back lost");
          return lost === "empty" ? [] : [null];
        }
        return out;
      }) as typeof redis.pipeline;
      let opened: Awaited<ReturnType<typeof acceptPartnership>>;
      try {
        opened = await acceptPartnership(store, "late@example.test", { percent: 20, products: [A] });
      } finally {
        redis.pipeline = original;
      }
      const held = await claims(statsId, "late@example.test");
      is(`${lost} read back: one lost answer and one lost read back`, [puts, backs], [1, 1]);
      is(`${lost} read back: its own record found again is the invitation opened`, opened.ok ? opened.affiliate.status : opened.reason, "approved");
      is(`${lost} read back: the address and the code still name the record written`, [held.record?.status, held.byCode === held.id], ["approved", true]);
    }
    {
      // Every write's answer and every read back lost (here none of the writes reached the store, which the code
      // cannot tell): whether it landed stays unknown, so it is said busy and nothing claimed is let go.
      const { store, statsId } = await fixture();
      redis.pipeline = (async (commands: (string | number)[][]) => {
        if (isPut(commands)) return [];
        if (isReadBack(statsId, commands)) return [];
        return original(commands);
      }) as typeof redis.pipeline;
      let thrown: unknown = null;
      try {
        await acceptPartnership(store, "late@example.test", { percent: 20, products: [A] });
      } catch (error) {
        thrown = error;
      } finally {
        redis.pipeline = original;
      }
      const [byEmail] = await original([["HGET", `nl:aff:${statsId}:emails`, "late@example.test"]]);
      const codes = (await original([["HGETALL", `nl:aff:${statsId}:codes`]]))[0] as string[];
      is("an outcome never known is answered busy", thrown instanceof LockBusyError, true);
      is("and the address stays claimed, not let go on an unknown answer", typeof byEmail, "string");
      is("and so does the code", codes.filter((_, i) => i % 2 === 1).includes(String(byEmail)), true);
    }
    {
      // The record read before a write in a shape that is not a string or nothing: unknown, never "no record".
      const { store, statsId } = await fixture();
      redis.pipeline = (async (commands: (string | number)[][]) => {
        const out = await original(commands);
        if (commands.length === 2 && commands[0]?.[0] === "HGET" && commands[0][1] === `nl:aff:${statsId}:people` && commands[1]?.[0] === "GET") return [7, out[1]];
        return out;
      }) as typeof redis.pipeline;
      let thrown: unknown = null;
      try {
        await setAffiliateRate(store, p, 15);
      } catch (error) {
        thrown = error;
      } finally {
        redis.pipeline = original;
      }
      is("a record read in another shape is answered busy", thrown instanceof LockBusyError, true);
      is("and nothing is written over it", (await readAffiliate(store, p))?.rate, null);
    }
    {
      // Codex G's review of #1924 (head 9aaa0011): the write landed, its answer was lost, and every read of the record
      // after it comes back as text that does not parse. Unreadable text proves no other record stands there: the
      // outcome stays unknown, so it is answered busy and the address and the code stay claimed for the record.
      const { store, statsId } = await fixture();
      let puts = 0;
      let cut = 0;
      redis.pipeline = (async (commands: (string | number)[][]) => {
        const out = await original(commands);
        if (isPut(commands) && puts === 0) {
          puts += 1;
          return [null];
        }
        if (puts === 1 && isReadBack(statsId, commands)) {
          cut += 1;
          return ["{cut"];
        }
        if (puts === 1 && commands.length === 2 && commands[0]?.[0] === "HGET" && commands[0][1] === `nl:aff:${statsId}:people` && commands[1]?.[0] === "GET") {
          cut += 1;
          return ["{cut", out[1]];
        }
        return out;
      }) as typeof redis.pipeline;
      let thrown: unknown = null;
      try {
        await acceptPartnership(store, "late@example.test", { percent: 20, products: [A] });
      } catch (error) {
        thrown = error;
      } finally {
        redis.pipeline = original;
      }
      const held = await claims(statsId, "late@example.test");
      is("unreadable reads: the lost answer and the unreadable reads were reached", [puts, cut > 1], [1, true]);
      is("unreadable reads: the record that landed is still there", held.record?.status, "approved");
      is("unreadable reads: answered busy, not expired", thrown instanceof LockBusyError, true);
      is("unreadable reads: the address and the code still name the record written", [typeof held.id, held.byCode === held.id], ["string", true]);
    }
  }

  // Codex M's review of #1924 (head de6839a3): an end that is present but does not read was dropped by the lenient
  // record parser, so the share read as having no end and earned on a sale after the agreement really ended. A share
  // that does not read exactly is unknown: no earning is written from it, while absent or null still means no end
  // and every other partner of the sale is still credited.
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
