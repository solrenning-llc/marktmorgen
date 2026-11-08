/**
 * Pay per lead (added 18 October 2026; HighLevel audit H29): recording the
 * confirmed leads affiliates bring, and the creator's decisions on them. The
 * terms and how a lead stands are in lib/affiliate-lead-rules.ts; the book,
 * the payments and the PayPal batches read the leads with everything else
 * (lib/affiliates.ts readBook), so a lead is paid the way a sale's commission
 * is: by the creator, from their own account, never by Marktmorgen.
 *
 * Where a lead is recorded, always after it was confirmed:
 *
 *   - a sign-up: the button in the emailed link pressed, and the address new
 *     to the list (app/api/store/join/confirm). The affiliate was read from
 *     the visit when the address was typed (lib/store-join.ts, askToJoin) and
 *     travelled in the emailed link;
 *   - a free product: its emailed link used, the first time that address got
 *     that product (app/api/store/free/download, the visit read when it was
 *     asked for, lib/free.ts requestCopy);
 *   - a booking: once Stripe says it is paid (lib/calls.ts confirmBooking),
 *     carried on the checkout from the visit; it counts once its call's time
 *     has passed, it was not refunded and the creator says it took place.
 *
 * What it costs, and where that is counted: a lead is written with a few
 * database commands inside a request that is already counted and priced
 * (tests/plan-cost-registry.ts): a sign-up's confirmation takes one of the
 * store's public requests first (lib/traffic.ts takePublicRequest), and is
 * not credited when the store has none left; a free product and a booking
 * are orders. What it keeps is counted in the store's data room before it is
 * written, and refused past it. No email is sent for a lead.
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { DataRoomError, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { readMoves } from "@/lib/call-records";
import { forgetBookSnapshot } from "@/lib/affiliate-book-snapshot";
import { affiliateCookieName, affiliatesOn, attributedAffiliate, canonicalEmail, payAddress, readAffiliate } from "@/lib/affiliates";
import { creditsContacts, viaCookieName } from "@/lib/affiliate-setting";
import {
  LEAD_REASONS,
  type LeadKind,
  type LeadReason,
  type LeadRecord,
  leadsKey,
  parseLead,
  parseLeadExact,
  settleLeads,
} from "@/lib/affiliate-lead-rules";

/** Where a program's leads are counted in the store's data room (lib/store-data.ts). */
const LEADS_SLOT = "aff:leads";
/** Leads one decision may name at once. */
export const MAX_LEAD_DECISIONS = 200;
/** Bookings whose moves are read at once when a decision needs them. */
const MOVES_AT_ONCE = 200;
/**
 * The lock a decision or a person's deletion holds while it reads the leads
 * and writes them back (docs/security-audit-2026-10-18.md, MM-SA-09): ten
 * seconds at the most, waited for up to five. Both hands read, change and
 * write whole records, so without it an approval that had read a lead before
 * the person's deletion wrote their address back, a deletion that had read it
 * before its approval wrote it back open, and an approval that had read it
 * before a reversal paid a lead marked fake. Its own family, so the store's
 * data room never counts it (lib/data-families.ts). The lock's own two
 * commands ride inside the studio request (or the erasure) that decides.
 */
const leadsLockKey = (statsId: string) => `nl:aff:leads:lock:${statsId}`;
const LOCK_SECONDS = 10;
const LOCK_WAIT_MS = 5_000;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The person's one-way fingerprint in this program: their address written any
 * way (canonicalEmail), with the store's own id, so it cannot be lined up
 * against another store's. It is the lead's id, so a person is one lead, ever.
 */
export function leadId(statsId: string, email: string): string {
  return sha(`nimbus-aff-lead:${statsId}:${canonicalEmail(email)}`).slice(0, 24);
}

/** Whether this store pays for this kind of lead now. */
export function paysLeads(store: Store, kind: LeadKind): boolean {
  return affiliatesOn(store) && store.affiliates.lead.kind === kind;
}

/**
 * The affiliate a lead of this kind would be credited to, read from the visit
 * now: the approved affiliate its click cookie names, within the store's
 * window, never from that affiliate's own browser, and never for their own
 * address (`email`, when it is known yet) or the creator's. Null otherwise.
 */
export async function leadAffiliate(
  store: Store,
  kind: LeadKind,
  cookies: { via: string | undefined; session: string | undefined },
  email?: string,
): Promise<string | null> {
  if (!paysLeads(store, kind)) return null;
  const affiliate = await attributedAffiliate(store, cookies).catch(() => null);
  if (!affiliate) return null;
  if (email && isOwn(store, affiliate, email)) return null;
  return affiliate.id;
}

/** The two cookies a visit to this store carries that credit an affiliate: their click, and an affiliate's own sign-in. */
export function visitCookies(request: { cookies: { get(name: string): { value: string } | undefined } }, handle: string): { via: string | undefined; session: string | undefined } {
  return { via: request.cookies.get(viaCookieName(handle))?.value, session: request.cookies.get(affiliateCookieName(handle))?.value };
}

function isOwn(store: Store, affiliate: { email: string; paypal: string }, email: string): boolean {
  const person = canonicalEmail(email);
  return person === canonicalEmail(store.email) || person === canonicalEmail(affiliate.email) || person === canonicalEmail(payAddress(affiliate));
}

/**
 * The affiliate who brought this buyer as a confirmed lead, or "" (630 [HN6](1)).
 *
 * Read only for a sale that no click, no code and no bond could credit, and
 * only where the creator switched it on (creditsContacts). One HGET on the
 * lead the address would be, when the sale is written down (the thank-you
 * page; the checkout sweep once lib/checkout-sweep.ts passes such sales on):
 * nothing new is kept, because the lead and its fingerprint were written when
 * it was confirmed. Only a lead confirmed before the checkout was opened
 * (`before`, seconds), and never the lead made by this checkout itself
 * (`checkout`, a paid booking's own session), so writing a sale down again
 * later never reaches back to a lead that came after it. A lead counts from
 * when it was confirmed, in its hold or past the day's cap alike: those decide
 * what the lead itself earns, not who brought the person. Never a lead the
 * creator reversed as not genuine before the sale was written down, and never
 * one whose person asked to be deleted: their address came off it
 * (forgetLeadPerson), and what is left is only there so they are not counted
 * as a lead again, never to tie a new purchase back to them. Whether the
 * affiliate is still approved is checked by the caller, as for a code or a bond.
 * A lead that does not read exactly (parseLeadExact) credits nobody: a reversal
 * whose state no longer reads is never taken for an open lead (rule 24).
 */
export async function contactFor(store: Store, email: string, before: number, checkout = ""): Promise<string> {
  if (!affiliatesOn(store) || !creditsContacts(store.affiliates) || !store.statsId || !email || !isRedisConfigured()) return "";
  const address = normaliseEmail(email);
  if (!EMAIL_PATTERN.test(address)) return "";
  try {
    const [raw] = await redisPipeline([["HGET", leadsKey(store.statsId), leadId(store.statsId, address)]]);
    const lead = parseLeadExact(raw);
    if (!lead || !lead.email || lead.state === "reversed") return "";
    if (!(lead.at > 0 && lead.at < before) || (checkout && lead.ref === checkout)) return "";
    // The fingerprint is of the address written any way; the address kept must be the same person's.
    if (canonicalEmail(lead.email) !== canonicalEmail(address)) return "";
    return lead.aff;
  } catch (error) {
    // A read that fails costs this sale its contact credit, never the sale.
    console.error("reading an affiliate's contact failed", error);
    return "";
  }
}

export type LeadResult = "recorded" | "duplicate" | "self" | "off" | "full" | "unavailable";

/**
 * Writes down one confirmed lead, once per person per program. Never throws:
 * a lead that cannot be written must not cost anybody their sign-up, their
 * file or their booking.
 *
 * `count` is set for a sign-up, whose confirmation is not otherwise one of the
 * store's counted requests: one is taken first, and the lead is not credited
 * when the store has none left this window.
 */
export async function recordLead(
  store: Store,
  input: {
    aff: string;
    kind: LeadKind;
    email: string;
    at?: number;
    end?: number;
    ref?: string;
    pi?: string;
    paid?: number;
    title?: string;
    count?: boolean;
  },
): Promise<LeadResult> {
  try {
    if (!paysLeads(store, input.kind) || !store.statsId || !isRedisConfigured()) return "off";
    const email = normaliseEmail(input.email);
    if (!EMAIL_PATTERN.test(email)) return "off";
    // Read again now: the affiliate the visit named may have been removed since, and is never their own lead.
    const affiliate = await readAffiliate(store, input.aff);
    if (!affiliate || affiliate.status !== "approved") return "off";
    if (isOwn(store, affiliate, email)) return "self";
    if (input.count && !(await takePublicRequest(store))) return "unavailable";
    const terms = store.affiliates.lead;
    const lead: LeadRecord = {
      id: leadId(store.statsId, email),
      aff: affiliate.id,
      kind: input.kind,
      at: Math.floor(input.at ?? Date.now() / 1000),
      end: Math.max(0, Math.floor(input.end ?? 0)),
      ref: (input.ref ?? "").slice(0, 220),
      pi: (input.pi ?? "").slice(0, 120),
      paid: Math.max(0, Math.floor(input.paid ?? 0)),
      title: (input.title ?? "").slice(0, 200),
      email,
      cents: terms.cents,
      currency: store.currency,
      hold: terms.hold,
      daily: terms.daily,
      budget: terms.budget,
      state: "open",
      d: 0,
      why: "",
    };
    const json = JSON.stringify(lead);
    // A decision later writes its time and reason into the same record: room for them is taken now.
    const bytes = dataBytes([lead.id, json, "0000000000other"], 1);
    try {
      await needData(store, [{ slot: LEADS_SLOT, bytes }]);
    } catch (error) {
      if (error instanceof DataRoomError) return "full";
      throw error;
    }
    // Read exactly (CX-123 rule 24): 1 is written, 0 is the person's lead already there (its room given back). Any
    // other reply may have written the lead, so its room is kept, never given back for a lead that may exist, and
    // the answer is "unavailable" (thrown here, said by the catch below), never "duplicate".
    const won = countOf(repliesFor(await redisPipeline([["HSETNX", leadsKey(store.statsId), lead.id, json]]), 1)?.[0]);
    if (won === 0) {
      await giveData(store, [{ slot: LEADS_SLOT, bytes }]);
      return "duplicate";
    }
    if (won !== 1) throw new UnknownReplyError("an affiliate lead's write");
    return "recorded";
  } catch (error) {
    console.error("recording an affiliate's lead failed", error);
    return "unavailable";
  }
}

/**
 * Every lead of the program, as kept, read exactly (CX-123 rule 24): one HGETALL answered with an even list of
 * strings (an empty list is a program with no leads), and every lead in it read whole (parseLeadExact). Throws
 * UnknownReplyError otherwise, never a shorter list: a lead left out would leave the month's budget, the day's cap
 * and the hour's limit summed without it, so a decision could approve a lead over them (decideLeads).
 * The caller already says "not done" on a throw: the studio's decision answers 503 "unavailable" and is tried
 * again (app/api/store/affiliates/route.ts). A person's copy of their data reads only their own lead (leadOf), so
 * another person's lead that does not read never blocks it. A lead that does not read cannot be
 * counted conservatively instead: its affiliate, day, month, currency and amount are exactly what is not known.
 */
export async function readLeads(store: Pick<Store, "statsId">): Promise<LeadRecord[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const list = stringList(repliesFor(await redisPipeline([["HGETALL", leadsKey(store.statsId)]]), 1)?.[0]);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError("an affiliate program's leads");
  const out: LeadRecord[] = [];
  for (let i = 0; i < list.length; i += 2) {
    const lead = parseLeadExact(list[i + 1]);
    if (!lead) throw new UnknownReplyError("an affiliate program's lead");
    out.push(lead);
  }
  return out;
}

/**
 * A person's own lead in the program, read exactly (CX-123 rule 24), for their copy of their data
 * (lib/person-copy.ts): one HGET of their field, leadId(statsId, address), since a person is one lead, ever. Only an
 * exact nil is no lead. A reply of another shape, or a kept lead that does not read whole (parseLeadExact), throws
 * UnknownReplyError, and copyPerson fails the whole copy instead of handing one over without it. Only this one
 * field is read, so another person's lead that does not read never blocks this person's copy (review of #3157);
 * a decision still reads, and fails closed on, every lead (readLeads).
 */
export async function leadOf(store: Pick<Store, "statsId">, email: string): Promise<LeadRecord | null> {
  if (!store.statsId || !isRedisConfigured() || !email) return null;
  const replies = repliesFor(await redisPipeline([["HGET", leadsKey(store.statsId), leadId(store.statsId, email)]]), 1);
  if (!replies) throw new UnknownReplyError("a person's affiliate lead");
  const [raw] = replies;
  if (raw === null) return null;
  const lead = parseLeadExact(raw);
  if (!lead) throw new UnknownReplyError("a person's affiliate lead");
  return lead;
}

/** Where open bookings' calls end now, read from their moves, in seconds. */
export async function bookingEnds(leads: LeadRecord[]): Promise<Map<string, number>> {
  const sessions = leads.filter((l) => l.kind === "booking" && l.state === "open" && l.ref).map((l) => l.ref).slice(0, MOVES_AT_ONCE);
  const ends = new Map<string, number>();
  if (!sessions.length) return ends;
  const moves = await readMoves(sessions);
  for (const [session, move] of moves) ends.set(session, Math.floor(move.e / 1000));
  return ends;
}

export type LeadDecision = "approve" | "reverse" | "reopen";
export type DecisionResult = { ok: true; changed: number } | { ok: false; reason: "unknown" | "reason" | "not_ready" | "busy" };

/**
 * The creator's decision on leads, one or many at once:
 *
 *   approve  only a lead whose hold has passed (a booking: after its call),
 *            within its caps and budget: it becomes payable, and for a
 *            booking this is the creator saying the call took place;
 *   reverse  not genuine, with the reason the affiliate is shown: it earns
 *            nothing, and if it was paid already what it earned comes off
 *            what is owed, as a refund does;
 *   reopen   a reversal taken back.
 *
 * Asked for leads that are not in a state for it, nothing is changed and the
 * answer says why. When the program's leads cannot be read exactly, it throws
 * UnknownReplyError (readLeads) and nothing is written.
 */
export async function decideLeads(store: Store, ids: string[], decision: LeadDecision, why: string = ""): Promise<DecisionResult> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "unknown" };
  const statsId = store.statsId;
  const wanted = [...new Set(ids.filter((id) => /^[0-9a-f]{24}$/.test(id)))].slice(0, MAX_LEAD_DECISIONS);
  if (!wanted.length) return { ok: false, reason: "unknown" };
  if (decision === "reverse" && !(LEAD_REASONS as readonly string[]).includes(why)) return { ok: false, reason: "reason" };
  try {
    // Read, judged and written under the leads' lock, so nothing another hand wrote meanwhile is written over (MM-SA-09).
    return await withLock(leadsLockKey(statsId), LOCK_SECONDS, LOCK_WAIT_MS, async (): Promise<DecisionResult> => {
      const all = await readLeads(store);
      const byId = new Map(all.map((l) => [l.id, l]));
      const chosen = wanted.map((id) => byId.get(id)).filter((l): l is LeadRecord => Boolean(l));
      if (chosen.length !== wanted.length) return { ok: false, reason: "unknown" };
      const now = Math.floor(Date.now() / 1000);
      let next: LeadRecord[];
      if (decision === "approve") {
        // Judged as the book judges them: the caps, the budget and a booking's call where its buyer moved it.
        const status = new Map(settleLeads(all, now, () => 0, await bookingEnds(chosen)).map((s) => [s.lead.id, s.status]));
        if (chosen.some((l) => status.get(l.id) !== "needs approval")) return { ok: false, reason: "not_ready" };
        next = chosen.map((l) => ({ ...l, state: "approved", d: now, why: "" }));
      } else if (decision === "reverse") {
        if (chosen.some((l) => l.state === "reversed")) return { ok: false, reason: "not_ready" };
        next = chosen.map((l) => ({ ...l, state: "reversed", d: now, why: why as LeadReason }));
      } else {
        if (chosen.some((l) => l.state !== "reversed")) return { ok: false, reason: "not_ready" };
        next = chosen.map((l) => ({ ...l, state: "open", d: 0, why: "" }));
      }
      await redisPipeline(next.map((l) => ["HSET", leadsKey(statsId), l.id, JSON.stringify(l)]));
      return { ok: true, changed: next.length };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    throw error;
  }
}

/**
 * Deleting a person (lib/person-erasure.ts): their address comes off the lead
 * an affiliate was credited for. The lead itself stays, without it, because
 * it is the affiliate's money record, paid or owed; so does its id, a one-way
 * fingerprint that cannot be turned back into the address, so the same person
 * joining again is not counted as a new lead.
 */
export async function forgetLeadPerson(store: Store, email: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured() || !email) return 0;
  const statsId = store.statsId;
  const id = leadId(statsId, email);
  // Under the leads' lock, so a decision being written at the same moment cannot write the address back (MM-SA-09).
  // A busy lock throws, and the erasure reports this part as not done and tries again (lib/person-erasure.ts).
  return withLock(leadsLockKey(statsId), LOCK_SECONDS, LOCK_WAIT_MS, async () => {
    const replies = repliesFor(await redisPipeline([["HGET", leadsKey(statsId), id]]), 1);
    if (!replies) throw new UnknownReplyError("a person's affiliate lead");
    const [raw] = replies;
    // Only an exact nil is "no lead". A kept lead that does not read, or whose address is of another type, may still
    // hold the address, so it is never said to be forgotten: the deletion reports this part as not done and tries
    // again (rule 24).
    if (raw === null) return 0;
    const kept = typeof raw === "string" && parseLead(raw) ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!kept || typeof kept.email !== "string") throw new UnknownReplyError("a person's affiliate lead");
    // The program's kept book shows the address masked (lib/affiliate-book-snapshot.ts): deleted whole, worked out again at the next load.
    // After the address comes off the lead, so a refresh that read the lead before is thrown away by the raised version and one that
    // reads it after never sees the address; and again when the address is already off, so a deletion tried again after this step
    // failed still deletes the book. A failure throws, and the deletion is tried again.
    if (!kept.email) {
      await forgetBookSnapshot(statsId);
      return 0;
    }
    // Only the address changes: every other field is written back as it was kept, never filled in with parseLead's
    // defaults, so a money field of another type stays unreadable to readLeads instead of becoming a readable 0.
    const json = JSON.stringify({ ...kept, email: "" });
    await redisPipeline([["HSET", leadsKey(statsId), id, json]]);
    await forgetBookSnapshot(statsId);
    const freed = dataBytes([id, String(raw)], 1) - dataBytes([id, json], 1);
    if (freed > 0) await giveData(store, [{ slot: LEADS_SLOT, bytes: freed }]);
    return 1;
  });
}
