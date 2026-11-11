import type { NextRequest } from "next/server";
import { StoreFullError, setAffiliateSetting, storeForEmail, storeForId, storeIdGone } from "@/lib/store";
import { readMoney } from "@/lib/money";
import { UnknownReplyError } from "@/lib/redis-reply";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_COMMISSION, MIN_COMMISSION, parseAffiliateSetting, readBonuses } from "@/lib/affiliate-setting";
import { parsePartnerShare } from "@/lib/partner-share";
import { readTermEnd } from "@/lib/partner-terms-rules";
import { LockBusyError, holdLock } from "@/lib/redis-lock";
import { readListings } from "@/lib/catalog";
import { answerInvite, waitingOne } from "@/lib/partner-invites";
import {
  MAX_REFERENCE_LENGTH,
  idleRemovalAllowed,
  acceptPartnership,
  addPayout,
  MAX_BULK_DECISIONS,
  decideMany,
  decideWhy,
  proposePartnerShare,
  setRatesMany,
  undoMany,
  undoRates,
  invitePartner,
  partnerShareProblem,
  commissionProblem,
  commissionRaised,
  readAffiliate,
  releaseHold,
  removePayout,
  setAffiliateRate,
  ShareCapError,
  StudioNotPaidError,
  type Charge,
  withPartnerLock,
} from "@/lib/affiliates";
import { holdStudio } from "@/lib/studio-route";
import { PROMO_ID_PATTERN, giveCode, takeCodeBack } from "@/lib/affiliate-codes";
import { leadProblem } from "@/lib/affiliate-lead-rules";
import { planTerms, readNoticeDays } from "@/lib/affiliate-notice";
import { idleProblem, readIdleDays } from "@/lib/affiliate-idle-rules";
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
 *   `idle` removes an approved affiliate with no sale and no lead for that
 *   many days (0, or 90 to 730), always after a warning (630 [HN6](3));
 *   `contacts` credits a sale nothing else credits to the affiliate whose
 *   confirmed lead the buyer is (lib/affiliate-leads.ts contactFor), only
 *   while the program pays per lead (creditsContacts);
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
  // What reads the whole program (the 90% cap's checks, a change in bulk) takes, before each read, the studio
  // requests it costs at its worst (lib/affiliates.ts bulkUnits), on top of the one this press took, and once read
  // gives back what it did not need (rule 30; coordinator, 2026-11-07). Not taken: nothing read, the press refused
  // (StudioNotPaidError, 429), or in bulk that part left out and named.
  const charge: Charge = async (units) => {
    const held = await holdStudio(guarded.store, units);
    return held.ok ? { give: held.give, force: held.force } : null;
  };

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
      // Removing affiliates who bring nothing (630 [HN6](3)): 0, or 90 to 730 days, refused otherwise.
      const idleRefused = idleProblem(body.idle);
      if (idleRefused) return fail(idleRefused);
      // Read again for the terms as they are this moment. The guard found the store, so a read that comes back
      // empty is not "no program yet": a cut would skip the notice its affiliates were promised. Nothing is saved.
      const fresh = await storeForEmail(guarded.ref);
      if (!fresh) return fail("unavailable", 503);
      const terms = (s: { percent: number; rates: Record<string, number>; days: number }) => ({ percent: s.percent, rates: s.rates, days: s.days });
      // What is saved, worked out from the store as read: the same whether it is read once, or again under the lock.
      const nextOf = (now: NonNullable<typeof fresh>) => {
        const before = now.affiliates;
        // A cut waits the longer of the notice the program had, as its affiliates were told, and the one chosen now;
        // and never ends before a notice already running.
        const plan = before
          ? planTerms(terms(before), terms(setting), Math.max(notice, before.notice ?? 0), Math.floor(Date.now() / 1000), before.pending ?? null)
          : { current: terms(setting), pending: null };
        // Not sent: kept as it was. Switched on or changed: a warning given before now is set aside (idleStep).
        // Never while the program credits memberships, whose sales are not written down (idleRemovalAllowed).
        const idle = !idleRemovalAllowed(setting) ? 0 : body.idle === undefined ? (before?.idle ?? 0) : readIdleDays(body.idle);
        // Switched on, changed, or the program switched back on after a pause (when no link could earn): the count starts now.
        const restart = idle !== (before?.idle ?? 0) || (setting.enabled && before?.enabled === false);
        const idleOn = idle > 0 ? (restart ? Math.floor(Date.now() / 1000) : (before?.idleOn ?? 0)) : 0;
        return { ...setting, ...plan.current, notice, pending: plan.pending, idle, idleOn };
      };
      const save = async (next: ReturnType<typeof nextOf>) => {
        const result = await setAffiliateSetting(guarded.ref, next);
        return result.ok ? Response.json({ ok: true }) : fail(result.reason);
      };
      // A program with no records yet has no partners to check, and nothing a partner could rely on.
      if (!fresh.statsId) return save(nextOf(fresh));
      // Every save is worked out and written under the program's partner lock, from the store read again exactly now
      // (pre-review L3): judged against what the request read, a commission lowered meanwhile, and the room it left
      // taken by a partner, would be put back by a save that "raises nothing". A commission that goes up anywhere (the
      // program's, or a product's) over the terms as they are now is checked against the 90% cap on every product with
      // partners, its people read exactly now (#2995 follow-up). Over it: 409, nothing saved.
      return await withPartnerLock(fresh, async (held) => {
        const now = await storeForEmail(guarded.ref);
        if (!now || now.statsId !== fresh.statsId) return fail("unavailable", 503);
        const again = nextOf(now);
        if (commissionRaised(now.affiliates, again)) {
          const problem = await commissionProblem(now, { terms: again }, charge);
          if (problem) return fail(`share_${problem}`, 409);
        }
        if (!(await holdLock(held))) return fail("unavailable", 503);
        return save(again);
      });
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
        // Those left waiting (over the cap, or not checked just now) are named, so the studio can say who and why.
        const { before, held } = await decideMany(store, ids, decision, charge);
        return Response.json({ ok: true, before, held });
      }
      const sent = Array.isArray(body.before) ? body.before.slice(0, MAX_BULK_DECISIONS) : [];
      const before = sent.flatMap((raw: unknown) => {
        const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const id = text(v.id, 20);
        const decidedAt = Number(v.decidedAt);
        // Only a pending application goes back: nothing else was decided in bulk.
        return id && v.status === "pending" && Number.isSafeInteger(decidedAt) && decidedAt >= 0 ? [{ id, status: "pending" as const, decidedAt }] : [];
      });
      // With the studio requests not taken nothing was put back: said as such (429), and the undo stays on the screen.
      const undone = await undoMany(store, before, decision, Date.now(), charge);
      if (undone.used) return fail("studio_used", 429);
      return Response.json({ ok: true, undone: undone.undone, left: undone.left });
    }
    // The share of several affiliates at once, and its undo (630 [HN6](4) unit 2).
    if (action === "bulk-rate" || action === "bulk-rate-undo") {
      const rate = body.rate === null || body.rate === "" ? null : Number(body.rate);
      if (rate !== null && (!Number.isInteger(rate) || rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return fail("rate");
      if (action === "bulk-rate") {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_BULK_DECISIONS).map((id) => text(id, 20)).filter(Boolean) : [];
        if (!ids.length) return fail("unknown");
        // Those whose new share would pass the cap, or could not be checked just now, keep theirs and are named.
        const changed = await setRatesMany(store, ids, rate, charge);
        return changed ? Response.json({ ok: true, before: changed.before, refused: changed.refused }) : fail("rate");
      }
      const sent = Array.isArray(body.before) ? body.before.slice(0, MAX_BULK_DECISIONS) : [];
      const before = sent.flatMap((raw: unknown) => {
        const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const id = text(v.id, 20);
        const was = v.rate === null ? null : Number(v.rate);
        return id && (was === null || (Number.isInteger(was) && was >= MIN_COMMISSION && was <= MAX_COMMISSION)) ? [{ id, rate: was }] : [];
      });
      const undone = await undoRates(store, before, rate, charge);
      if (undone.used) return fail("studio_used", 429);
      return Response.json({ ok: true, undone: undone.undone, left: undone.left });
    }
    if (action === "approve" || action === "decline" || action === "remove" || action === "restore") {
      // A share that would pass the cap once its holder is approved again: refused, nothing written (lib/affiliates.ts).
      const done = await decideWhy(store, text(body.id, 20), action, Math.floor(Date.now() / 1000), charge).catch((error: unknown) => {
        if (error instanceof ShareCapError) return error;
        throw error;
      });
      if (done instanceof ShareCapError) return fail(`share_${done.problem}`, 409);
      // A dated share still in force is not ended by the store alone (630 [HN6](39)): the studio says what to do instead.
      if (!done.ok && done.reason === "term") return fail("share_term_held");
      return done.ok ? Response.json({ ok: true }) : fail("unknown");
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
      const done = await setAffiliateRate(store, text(body.id, 20), rate, charge);
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
      // A store that could not be read is not gone: the offer is kept and the answer can be sent again. Only an
      // exact answer that no store has this id takes the offer out.
      const from = await storeForId(invite.sid).catch(() => undefined);
      if (from === undefined) return fail("unavailable", 503);
      if (!from) {
        if (!(await storeIdGone(invite.sid))) return fail("unavailable", 503);
        await answerInvite(guarded.email, invite.id);
        return fail("gone");
      }
      // The cap is checked again at acceptance (lib/affiliates.ts recordFromLink): over it, refused with the offer kept,
      // so it can be accepted once the store lowers a share. An unknown read or a busy lock throws: 503, offer kept.
      // Reading the inviting program's people for the cap is paid from the answering creator's own studio requests
      // (`charge`, guarded.store), taken at its worst first and given back down to what was read. Not taken: 429,
      // nothing read or written, the offer kept.
      const made = await acceptPartnership(from, guarded.email, invite.share, charge);
      if (!made.ok && made.reason === "resting") return fail("studio_used", 429);
      if (!made.ok && (made.reason === "committed" || made.reason === "crowded")) return fail(`offer_${made.reason}`, 409);
      if (!made.ok) return fail(made.reason === "full" ? "full" : "unavailable");
      await answerInvite(guarded.email, invite.id);
      return Response.json({ ok: true, accepted: true });
    }
    if (action === "invite") {
      // A partner the creator brings from outside: they need no account here,
      // only an address that can receive PayPal. Checked against the same cap
      // as any other share, before the email goes out.
      // An end date, when the creator chose one (630 [HN6](39)); empty is until revoked.
      const end = readTermEnd(body.ends, Math.floor(Date.now() / 1000));
      if (!end.ok) return fail("share_ends");
      const share = parsePartnerShare({ percent: body.percent, products: body.products, until: end.until ?? undefined });
      if (!share) return fail(Array.isArray(body.products) && body.products.length ? "share_percent" : "share_products");
      // Checked again, under the partner lock, when the invitation is accepted.
      const problem = await partnerShareProblem(store, share, null, charge);
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
      // A partner's share changes only under lib/partner-terms-rules.ts (630 [HN6](39), rewritten on the partner
      // lock): a new one starts at once, ending one that runs until revoked applies at once, anything else waits for
      // the partner's yes on their own page. Nothing already earned is touched either way. Every share asked for is
      // checked against the cap first, under the program's partner lock (lib/affiliates.ts proposePartnerShare), and
      // again at the partner's yes. Awaited here, so a busy lock or an unknown read reaches the catch below (503).
      const id = text(body.id, 20);
      const affiliate = await readAffiliate(store, id);
      if (!affiliate) return fail("unknown");
      // TODO(#1924, 4 open points awaiting Claude 1, canal para-claude-1 11/11/2026): #1924 refused a share for
      // somebody not approved (share_not_approved). Main lets the creator give one (it counts, cap checked, once they
      // are approved); kept until Claude 1 decides.
      const now = Math.floor(Date.now() / 1000);
      if (body.share === null || body.percent === "" || body.percent === null) {
        const ended = await proposePartnerShare(store, id, null, now, charge);
        return ended.ok ? Response.json({ ok: true, state: ended.state }) : fail("unknown");
      }
      const end = readTermEnd(body.ends, now);
      if (!end.ok) return fail("share_ends");
      const share = parsePartnerShare({ percent: body.percent, products: body.products, until: end.until ?? undefined });
      if (!share) return fail(Array.isArray(body.products) && body.products.length ? "share_percent" : "share_products");
      const saved = await proposePartnerShare(store, id, share, now, charge);
      if (saved.ok) return Response.json({ ok: true, state: saved.state });
      return fail(saved.reason === "cap" ? `share_${saved.problem}` : "unknown");
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
    // The studio requests a read of the whole program needs were not taken: nothing was read or saved.
    if (error instanceof StudioNotPaidError) return fail("studio_used", 429);
    // A reply that could not be read exactly (the program's people, for the partner-share cap): nothing was saved.
    if (error instanceof UnknownReplyError) {
      console.error("changing the affiliate programme stopped on an unknown reply", error);
      return fail("unavailable", 503);
    }
    // The partner lock stayed taken, or was lost before a share was written: nothing was saved, an offer is kept.
    if (error instanceof LockBusyError) return fail("unavailable", 503);
    // A commission or a share that would pass the 90% cap once written (lib/affiliates.ts): nothing was saved.
    if (error instanceof ShareCapError) return fail(`share_${error.problem}`, 409);
    console.error("changing the affiliate programme failed", error);
    return fail("server_error", 500);
  }
}
