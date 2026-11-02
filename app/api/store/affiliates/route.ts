import type { NextRequest } from "next/server";
import { StoreFullError, setAffiliateSetting, storeForEmail, storeForId } from "@/lib/store";
import { readMoney } from "@/lib/money";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_COMMISSION, MIN_COMMISSION, commissionRate, parseAffiliateSetting, readBonuses } from "@/lib/affiliate-setting";
import { parsePartnerShare, shareProblem } from "@/lib/partner-share";
import { readListings } from "@/lib/catalog";
import { answerInvite, waitingOne } from "@/lib/partner-invites";
import {
  MAX_REFERENCE_LENGTH,
  acceptPartnership,
  addPayout,
  MAX_BULK_DECISIONS,
  decide,
  decideMany,
  undoMany,
  invitePartner,
  listPartners,
  readAffiliate,
  releaseHold,
  removePayout,
  setAffiliateRate,
  setPartnerShare,
} from "@/lib/affiliates";
import { PROMO_ID_PATTERN, giveCode, takeCodeBack } from "@/lib/affiliate-codes";
import { leadProblem } from "@/lib/affiliate-lead-rules";
import { planTerms, readNoticeDays } from "@/lib/affiliate-notice";
import { MAX_LEAD_DECISIONS, decideLeads } from "@/lib/affiliate-leads";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The creator running their affiliate programme, one action at a time:
 *
 * `{ action: "settings", enabled, percent, days, rule, payday, hold, rates: { <product>: 0-90 } }`,
 *   where `payday` is the day of the month they pay (1-28, or 0 for no promised
 *   day), `hold` is how many days a sale waits before it can be paid, and
 *   `rule` is "last" or "first": which of two links a buyer followed earns it,
 *   and `lifetime` keeps a buyer with the affiliate who brought them, for good;
 * `{ action: "code", promo, id }`, giving one of the creator's own discount
 *   codes to one affiliate so a sale that used it earns them their share with
 *   no click at all; an empty `id` takes the code back;
 * `{ action: "approve" | "decline" | "remove" | "restore", id }`;
 * `{ action: "payout", id, amount: "25.50", date: "2026-09-26", reference }`,
 *   which only writes down a payment the creator made themselves;
 * `{ action: "unpay", payout }`, to take back one written down by mistake;
 * `{ action: "rate", id, rate: 1-90 | null }`, a share for this affiliate
 *   alone, or back to the program's own shares;
 * `{ action: "share", id, percent, products: [<product>] }`, a standing share
 *   of every sale of those products — what Hotmart calls co-production — or
 *   `{ action: "share", id, percent: null }` to end it. Refused when
 *   everything promised on one product, affiliate commission included, would
 *   pass the cap in lib/partner-share.ts;
 * `{ action: "invite", email, percent, products }`, the same thing for
 *   somebody not in the programme at all: they are emailed the terms and the
 *   record is made, already approved, when they open the link — unless that
 *   address already has a store here, in which case the offer waits in their
 *   own studio instead of their inbox;
 * `{ action: "answer", invite, accept: true | false }`, that creator
 *   answering one. Only the address it was left for can answer it;
 * `lead: { kind, cents, hold, daily, budget }` on "settings", pay per lead
 *   (lib/affiliate-lead-rules.ts), refused when any number is out of range;
 * `{ action: "leads", ids: [<lead>], decision: "approve" | "reverse" | "reopen", why }`,
 *   the creator's decision on confirmed leads (lib/affiliate-leads.ts decideLeads).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 16_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const action = text(body.action, 20);
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    if (action === "settings") {
      // A pending cut is never taken from the request: it is worked out below.
      const setting = parseAffiliateSetting({ ...body, enabled: body.enabled === true, pending: null });
      // Out-of-range numbers are refused, not quietly replaced by the defaults.
      if (Number(body.percent) !== setting.percent) return fail("percent");
      if (Number(body.days) !== setting.days) return fail("days");
      // A rule we do not have is refused rather than quietly becoming "last".
      if (body.rule !== undefined && body.rule !== setting.rule) return fail("rule");
      if (Number(body.payday) !== setting.payday) return fail("payday");
      if (Number(body.hold) !== setting.hold) return fail("hold");
      if (body.recurring !== undefined && Number(body.recurring) !== setting.recurring) return fail("recurring");
      if (readBonuses(body.bonuses) === null) return fail("bonus");
      if (body.secondTier !== undefined && Number(body.secondTier) !== setting.secondTier) return fail("tier");
      const leadRefused = leadProblem(body.lead);
      if (leadRefused) return fail(leadRefused);
      const asked = body.rates && typeof body.rates === "object" ? Object.keys(body.rates as object).length : 0;
      if (asked !== Object.keys(setting.rates).length) return fail("rate");
      // Notice before a cut (630 [HN6](2), lib/affiliate-notice.ts): none, or 3 to 90 days, refused otherwise.
      const notice = readNoticeDays(body.notice);
      if (body.notice !== undefined && body.notice !== null && body.notice !== "" && Number(body.notice) !== 0 && notice === 0) return fail("notice");
      const before = (await storeForEmail(guarded.ref))?.affiliates ?? null;
      const terms = (s: { percent: number; rates: Record<string, number>; days: number }) => ({ percent: s.percent, rates: s.rates, days: s.days });
      // A cut waits the longer of the notice the program had, as its affiliates were told, and the one chosen now;
      // and never ends before a notice already running.
      const plan = before
        ? planTerms(terms(before), terms(setting), Math.max(notice, before.notice ?? 0), Math.floor(Date.now() / 1000), before.pending ?? null)
        : { current: terms(setting), pending: null };
      const result = await setAffiliateSetting(guarded.ref, { ...setting, ...plan.current, notice, pending: plan.pending });
      if (!result.ok) return fail(result.reason);
      return Response.json({ ok: true });
    }

    const store = await storeForEmail(guarded.ref);
    if (!store) return fail("none");
    if (!store.statsId) return fail("unknown");

    // The creator looked at what was held (lib/affiliates.ts holdFlags) and lets it through.
    if (action === "release") {
      const done = await releaseHold(store, text(body.id, 20));
      return done ? Response.json({ ok: true }) : fail("unknown");
    }
    if (action === "leads") {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_LEAD_DECISIONS).map((id) => text(id, 30)) : [];
      const decision = body.decision === "approve" || body.decision === "reverse" || body.decision === "reopen" ? body.decision : null;
      if (!decision || !ids.length) return fail("unknown");
      const done = await decideLeads(store, ids, decision, text(body.why, 20));
      if (done.ok) return Response.json({ ok: true, changed: done.changed });
      // Another decision on this program's leads is being written this moment (MM-SA-09): the studio says to reload and try again.
      if (done.reason === "busy") return fail("busy", 409);
      return fail(done.reason === "reason" ? "lead_reason" : done.reason === "not_ready" ? "lead_not_ready" : "unknown");
    }
    // Several applications at once, and their undo (630 [HN6](4); lib/affiliates.ts decideMany, undoMany).
    if (action === "bulk" || action === "bulk-undo") {
      const decision = body.decision === "approve" || body.decision === "decline" ? body.decision : null;
      if (!decision) return fail("unknown");
      if (action === "bulk") {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_BULK_DECISIONS).map((id) => text(id, 20)).filter(Boolean) : [];
        if (!ids.length) return fail("unknown");
        const before = await decideMany(store, ids, decision);
        return Response.json({ ok: true, before });
      }
      const sent = Array.isArray(body.before) ? body.before.slice(0, MAX_BULK_DECISIONS) : [];
      const before = sent.flatMap((raw: unknown) => {
        const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const id = text(v.id, 20);
        const decidedAt = Number(v.decidedAt);
        // Only a pending application goes back: nothing else was decided in bulk.
        return id && v.status === "pending" && Number.isSafeInteger(decidedAt) && decidedAt >= 0 ? [{ id, status: "pending" as const, decidedAt }] : [];
      });
      const undone = await undoMany(store, before, decision);
      return Response.json({ ok: true, undone });
    }
    if (action === "approve" || action === "decline" || action === "remove" || action === "restore") {
      const done = await decide(store, text(body.id, 20), action);
      return done ? Response.json({ ok: true }) : fail("unknown");
    }
    if (action === "payout") {
      // In the store's currency, which is what the payout is written down in.
      const cents = readMoney(text(body.amount, 12), store.currency);
      if (cents === null || cents < 1) return fail("amount");
      const date = text(body.date, 10);
      if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return fail("date");
      const payout = await addPayout(store, {
        aff: text(body.id, 20),
        cents,
        currency: store.currency,
        date,
        reference: text(body.reference, MAX_REFERENCE_LENGTH * 2),
      });
      return payout ? Response.json({ ok: true }) : fail("unknown");
    }
    if (action === "rate") {
      const rate = body.rate === null || body.rate === "" ? null : Number(body.rate);
      if (rate !== null && !Number.isInteger(rate)) return fail("rate");
      if (rate !== null && (rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return fail("rate");
      const done = await setAffiliateRate(store, text(body.id, 20), rate);
      return done ? Response.json({ ok: true, rate: done.rate }) : fail("unknown");
    }
    if (action === "answer") {
      // The invited creator answering, from their own studio. `guarded.email`
      // is the person signed in — not `guarded.ref`, which is a store — so an
      // offer can only ever be answered by the address it was left for.
      const invite = await waitingOne(guarded.email, text(body.invite, 20));
      if (!invite) return fail("gone");
      if (body.accept !== true) {
        await answerInvite(guarded.email, invite.id);
        return Response.json({ ok: true, accepted: false });
      }
      const from = await storeForId(invite.sid).catch(() => null);
      if (!from) {
        await answerInvite(guarded.email, invite.id);
        return fail("gone");
      }
      const made = await acceptPartnership(from, guarded.email, invite.share);
      if (!made.ok) return fail(made.reason === "full" ? "full" : "unavailable");
      await answerInvite(guarded.email, invite.id);
      return Response.json({ ok: true, accepted: true });
    }
    if (action === "invite") {
      // A partner the creator brings from outside: they need no account here,
      // only an address that can receive PayPal. Checked against the same cap
      // as any other share, before the email goes out.
      const share = parsePartnerShare({ percent: body.percent, products: body.products });
      if (!share) return fail(Array.isArray(body.products) && body.products.length ? "share_percent" : "share_products");
      const others: Record<string, number[]> = {};
      for (const other of await listPartners(store)) {
        if (other.status !== "approved" || !other.share) continue;
        for (const product of other.share.products) (others[product] ??= []).push(other.share.percent);
      }
      const affiliatePercent: Record<string, number> = {};
      for (const product of share.products) affiliatePercent[product] = commissionRate(store.affiliates, product);
      const problem = shareProblem({ percent: share.percent, products: share.products, others, affiliatePercent });
      if (problem) return fail(`share_${problem}`);

      // Only the products being shared in, never the whole catalogue: a store
      // at the 2,000 ceiling would otherwise cost 2,000 reads to send one
      // invitation, and Upstash bills by the command.
      const titles = new Map((await readListings(store, share.products)).map((p) => [p.id, p.title]));
      const origin = new URL(request.url).origin;
      const to = text(body.email, 254);
      // Somebody who already has a store here is asked in their own studio
      // instead of an inbox (lib/partner-invites.ts). The agreement moves; it
      // is not skipped. Their own store is never offered a partnership.
      const theirs = to ? await storeForEmail(to).catch(() => null) : null;
      const alreadyHere = Boolean(theirs && theirs.sid !== store.sid);
      const sent = await invitePartner({ store, email: to, share, titles, origin, alreadyHere });
      if (sent === "sent" || sent === "waiting") return Response.json({ ok: true, waiting: sent === "waiting" });
      return fail(sent === "email" ? "invite_email" : sent);
    }
    if (action === "share") {
      const id = text(body.id, 20);
      const affiliate = await readAffiliate(store, id);
      if (!affiliate) return fail("unknown");
      // Clearing it: nothing already earned is touched.
      if (body.share === null || body.percent === "" || body.percent === null) {
        return (await setPartnerShare(store, id, null)) ? Response.json({ ok: true }) : fail("unknown");
      }
      const share = parsePartnerShare({ percent: body.percent, products: body.products });
      if (!share) return fail(Array.isArray(body.products) && body.products.length ? "share_percent" : "share_products");

      // The cap counts everything promised on each of these products at once:
      // the other partners' shares and the affiliate commission, which rides
      // on the same sale (lib/partner-share.ts).
      const others: Record<string, number[]> = {};
      for (const other of await listPartners(store)) {
        if (other.id === id || other.status !== "approved" || !other.share) continue;
        for (const product of other.share.products) {
          (others[product] ??= []).push(other.share.percent);
        }
      }
      const affiliatePercent: Record<string, number> = {};
      for (const product of share.products) affiliatePercent[product] = commissionRate(store.affiliates, product);

      const problem = shareProblem({ percent: share.percent, products: share.products, others, affiliatePercent });
      if (problem) return fail(`share_${problem}`);
      return (await setPartnerShare(store, id, share)) ? Response.json({ ok: true }) : fail("unknown");
    }
    if (action === "code") {
      const promo = text(body.promo, 90);
      if (!PROMO_ID_PATTERN.test(promo)) return fail("promo");
      const id = text(body.id, 20);
      if (!id) return (await takeCodeBack(store, promo)) ? Response.json({ ok: true }) : fail("unknown");
      // Only somebody already in the programme, so a code cannot be handed to
      // an address nobody has approved.
      const affiliate = await readAffiliate(store, id);
      if (affiliate?.status !== "approved") return fail("unknown");
      return (await giveCode(store, promo, id)) ? Response.json({ ok: true }) : fail("unknown");
    }
    if (action === "unpay") {
      return (await removePayout(store, text(body.payout, 20))) ? Response.json({ ok: true }) : fail("unknown");
    }
    return fail("unknown");
  } catch (error) {
    if (error instanceof StoreFullError) return fail("store_full", 409);
    console.error("changing the affiliate programme failed", error);
    return fail("server_error", 500);
  }
}
