/**
 * Booking a paid call, on the creator's own Stripe account.
 *
 * A buyer picks a time, the time is held while they pay, and it becomes
 * theirs once Stripe says the payment went through. Three sources decide
 * whether a time is free, and all three are consulted every time:
 *
 *   - holds: a time somebody is paying for right now, kept for as long as a
 *     Stripe checkout stays open, then released by itself;
 *   - bookings we wrote down when a buyer came back from paying;
 *   - the creator's own Stripe account, which is the ledger. A buyer who paid
 *     and closed the tab before coming back still blocks the time, because
 *     the paid checkout is read from Stripe.
 *
 * Every hold and booking is one seat: a one-to-one call has one per time, a
 * group call up to fifty, a dated live session up to five hundred (the rules
 * are in lib/call-setup.ts). The same booking can be seen twice — written
 * down here and read from Stripe — so seats are counted by checkout session,
 * once each.
 *
 * Emails go out once per booking — to the buyer and to the creator — each
 * with a calendar file, so the call is in both calendars without anybody
 * connecting anything. The buyer's has a link to move the booking to another
 * time themselves (moveBooking), within the creator's notice and at most
 * MAX_MOVES times; the reminders a day and an hour before are sent by the
 * mail job (lib/call-reminders.ts).
 *
 * Where the call happens is the creator's own link, a private video room
 * (lib/call-rooms.ts), or a Google Meet or Zoom meeting made on the
 * creator's connected account for each booking (lib/meet-links.ts), made
 * here when the booking is confirmed and moved here when the booking moves.
 *
 * A fourth source applies to weekly hours only: the creator's own calendars,
 * when they have pasted their private calendar addresses in the studio
 * (lib/calendar-sync.ts). A time they are busy there is not offered, and a
 * calendar that cannot be read takes nothing away — the bookings go on
 * without it. Dated sessions are never hidden by it: the creator put them on
 * that date themselves, so the studio shows the clash instead.
 *
 * A call with weekly hours and one seat can instead be a team event type
 * (lib/team-booking.ts): booked with whichever host is free, or with all of
 * them. Its times come from its hosts' own weeks and calendars, and each
 * booking also takes its hosts' time on every store at once, atomically
 * (lib/host-claims.ts), under the same lock as everything here.
 */
import type { DepositFigures } from "@/lib/deposit-code";
import { chargeNow, creatorDueLine, type DueInPerson, dueLines, readDue } from "@/lib/call-deposit";
import { type CallPlace, placeIcsLines, placeLine, whereOf } from "@/lib/call-place";
import { admitOrders } from "@/lib/order-admission";
import { CALL_ORDER_UNITS } from "@/lib/order-rules";
import { countOrder } from "@/lib/orders";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { StripeListUnreadable, plainObject, ownField, readStripePage } from "@/lib/stripe-list";
import { fieldReleaseBytes, orderWrite, releaseOrderData } from "@/lib/order-data";
import { PAST_CALL_DAYS } from "@/lib/store-data-rules";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isHouseStore } from "@/lib/house-store";
import { HOLD_SECONDS, checkoutClosesAt, onAccount } from "@/lib/stripe-account";
import { applyTax, applyTaxDocuments, openKeepingTheSale } from "@/lib/tax";
import { askForCallReminder, recoveryOn, refusedRecovery, withoutCallReminder } from "@/lib/recovery-setting";
import { inTheCurrencyShown, isSettled, onlyInstantMethods } from "@/lib/instant-pay";
import { keptUnlessLost, refundedInFull } from "@/lib/refunds";
import { type Answer, applyCheckoutFields, readAnswers } from "@/lib/checkout-fields";
import type { Listing, Product, Store } from "@/lib/store";
import { idsOfKind, listingFinder, readListing, readListings, sellsAny } from "@/lib/catalog";

/** A product that is a call, as listed: all a booking needs but its checkout questions. */
export type CallListing = Listing & { call: CallSetup };
import { formatMoney } from "@/lib/money";
import {
  type Busy,
  type CallSetup,
  type CancelPromise,
  KEEP_PAST_SESSION_DAYS,
  MAX_MOVES,
  isBookable,
  readCancelPromise,
  isTimeZone,
  lengthAt,
  movableUntil,
  openSessions,
  openSlots,
  readableTime,
  seatsTaken,
  zoneName,
} from "@/lib/call-setup";
import { bookingLength, ownLength } from "@/lib/call-lengths";
import { planCheck, planReminders, readMoves, unplanReminders, writeMove } from "@/lib/call-records";
import { calendarBusy } from "@/lib/calendar-sync";
import { fold, icsText, icsTime } from "@/lib/ics-write";
import { emitEvent } from "@/lib/webhooks";
import { recordLead } from "@/lib/affiliate-leads";
import { VIDEO_ROOM_NOTE, isVideoRoom, roomOf } from "@/lib/call-rooms";
import { alertCreator } from "@/lib/phone-alerts";
import { callMeeting, callMoved, keepMeetStore, linkUpdates } from "@/lib/meet-links";
import type { MeetRecord } from "@/lib/meet-records";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { type BookingWords, bookingWords } from "@/lib/buyer-words/booking";
import { applyShare, leastPaid, linesTotal, shareBps } from "@/lib/platform-share";
import { codesMayTakeOff } from "@/lib/discount";
import { hostId, isClaimId, isHostId, newClaimId } from "@/lib/host-claims";
import { chosenTeam, hostChoices, parseTeamSetup, teamBookable } from "@/lib/team-scheduling-rules";
import {
  type TeamBusy,
  activeTeam,
  confirmTeam,
  holdTeam,
  hostEmails,
  moveTeamClaim,
  readTeams,
  releaseClaim,
  teamContext,
  teamDays,
  teamMoveDays,
} from "@/lib/team-booking";

/** How far back Stripe is read for paid bookings. Longer than any horizon. */
const LOOKBACK_DAYS = 120;
const MAX_PAGES = 5;

/**
 * One seat, as written down here: its start and end, until when a hold lasts
 * (0 for a booking), the checkout session, and the product. Entries written
 * before group calls are filed under their start and carry no `s` or `p`.
 */
type Entry = {
  s?: number;
  e: number;
  until: number;
  session?: string;
  p?: string;
  /** A team booking (lib/team-booking.ts): its hosts' ids, and the claim taken on their time. */
  h?: string[];
  c?: string;
};

/** The hosts and claim of a team entry, when it is one and both read right. */
function teamOf(entry: Pick<Entry, "h" | "c">): { hosts: string[]; claim: string } | null {
  const hosts = Array.isArray(entry.h) ? entry.h.filter(isHostId).slice(0, 6) : [];
  return hosts.length && isClaimId(entry.c) ? { hosts, claim: entry.c } : null;
}

const busyKey = (callsId: string) => `nl:call:busy:${callsId}`;
// One lock for the whole diary, not one per start time: two call products,
// or two overlapping stretches of hours, can offer different starts that
// overlap, and both buyers must not pass the check at once. The same lock
// stops two buyers taking the last seat of a group call, and a buyer moving
// into a time while another books it.
const lockKey = (callsId: string) => `nl:call:lock:${callsId}`;
export const confirmedKey = (session: string) => `nl:call:confirmed:${session}`;
/**
 * How long a call's confirmation mark is kept: well past any call it can be
 * about (the furthest a call can be booked ahead, and its moves), and then
 * gone by itself, so a closed store leaves none for good (18 October 2026).
 */
export const CONFIRMED_SECONDS = 430 * 86_400;

/** A time as the diary's writers make it: a whole number of milliseconds since 1970, after 1970. */
const diaryTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * One diary entry, read exactly (CX-123 rule 24): a JSON object whose start
 * (`s` or, for an entry filed by its start before group calls, its field) and
 * end `e` are diary times with the end after the start, and whose `until` is 0
 * (a booking) or a diary time (a hold: holdAndCheckout writes Date.now() plus
 * the hold). Anything else throws UnknownReplyError: an entry that cannot be
 * read could be a held or booked seat, so it is never read as free, and never
 * deleted as stale (a negative `until` once read as a hold that ran out, and
 * the real hold was deleted and its time sold again: Codex Z on #3240).
 */
function entryOf(field: string, value: string): Entry & { start: number } {
  let entry: unknown;
  try {
    entry = JSON.parse(value);
  } catch {
    throw new UnknownReplyError("a call diary entry that does not parse");
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new UnknownReplyError("a call diary entry that is not an object");
  const { s, e, until } = entry as Entry;
  const start = s === undefined ? Number(field) : s;
  if ((until !== 0 && !diaryTime(until)) || !diaryTime(start) || !diaryTime(e) || e <= start) {
    throw new UnknownReplyError("a call diary entry whose times cannot be read");
  }
  return { ...(entry as Entry), start };
}

/** Every entry of a diary, each read exactly (entryOf): one that cannot be read throws, and nothing is read from the rest. */
function readEntries(flat: string[]): { field: string; value: string; entry: Entry & { start: number } }[] {
  const out: { field: string; value: string; entry: Entry & { start: number } }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ field: flat[i], value: flat[i + 1], entry: entryOf(flat[i], flat[i + 1]) });
  return out;
}

export { PAST_CALL_DAYS };

/**
 * The diary's fields and values as HGETALL gives them, read in their exact
 * shape (CX-123 rule 24): a list of strings in pairs, empty only when Redis
 * says the diary is empty. Anything else throws UnknownReplyError, never read
 * as "nothing held": a held or booked time would be offered and sold again.
 */
async function readDiary(callsId: string): Promise<string[]> {
  const one = repliesFor(await redisPipeline([["HGETALL", busyKey(callsId)]]), 1);
  const flat = one ? stringList(one[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("a call diary's holds");
  return flat;
}

async function heldAndBooked(store: Store, now: number): Promise<(TeamBusy & { field: string })[]> {
  const callsId = store.callsId as string;
  // Every entry is read before anything is decided or deleted: one that cannot be read throws (entryOf), and the
  // whole diary is then unknown, so no time is offered or sold and nothing is let go on it.
  const entries = readEntries(await readDiary(callsId));
  const busy: (TeamBusy & { field: string })[] = [];
  const stale: string[] = [];
  const past: string[] = [];
  let freed = 0;
  for (const { field, value, entry } of entries) {
    if (entry.until === 0 && entry.e < now - PAST_CALL_DAYS * 86_400_000) {
      past.push(field);
      freed += fieldReleaseBytes(field, value);
      continue;
    }
    if (entry.until !== 0 && entry.until < now) {
      stale.push(field);
      continue;
    }
    const team = teamOf(entry);
    busy.push({ start: entry.start, end: entry.e, product: entry.p, session: entry.session, field, ...(team ? { hosts: team.hosts, claim: team.claim } : {}) });
  }
  // Holds that ran out are tidied as they are noticed, and calls long over let go.
  if (stale.length) await redisPipeline([["HDEL", busyKey(callsId), ...stale]]).catch(() => {});
  if (past.length) {
    const [gone] = await redisPipeline([["HDEL", busyKey(callsId), ...past]]).catch(() => [0]);
    if (Number(gone) === past.length) await releaseOrderData(store, freed);
  }
  return busy;
}

type SessionRow = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown; name?: unknown } | null;
  created?: unknown;
  custom_fields?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
};

/**
 * Paid calls, read from the creator's own Stripe account, each at the time
 * it is booked for now: a booking its buyer moved is at its new time.
 */
export async function paidCalls(store: Store): Promise<
  {
    session: string;
    start: number;
    end: number;
    product: string;
    title: string;
    email: string | null;
    /** The name the buyer gave Stripe, when they gave one. */
    name: string | null;
    buyerTz: string;
    /** How many times its buyer has moved it. */
    moves: number;
    /** What the buyer answered to the creator's questions at checkout. */
    answers: Answer[];
    /** What was paid, in cents. */
    amount: number;
    /** The currency it was paid in, as the checkout session says; empty when it says none, and readers fall back to the store's (22 [E5], unit 2b). */
    currency: string;
    /** A team booking's hosts' ids and the claim on their time; empty for an ordinary call. */
    hosts: string[];
    claim: string;
    /** The affiliate a lead is credited to once the call has taken place (lib/affiliate-leads.ts), and the payment; empty otherwise. */
    lead: string;
    pi: string;
    /** What is left to pay in person, and a code taken off the whole price, as the sale keeps them (lib/call-deposit.ts). */
    due: DueInPerson | null;
    /** The cancellation deadline the buyer was promised when paying (lib/call-setup.ts, readCancelPromise). */
    cancel: CancelPromise | null;
  }[]
> {
  return (await readCallSessions(store)).paid;
}

/**
 * The same reading as paidCalls, with whether it stopped at its last page
 * while Stripe still had more (older checkouts, which may hold a booking for
 * a time still to come). For the studio's "Today" counts (lib/today-rules.ts),
 * which give no number they cannot stand behind.
 */
export async function paidCallsRead(store: Store): Promise<{ paid: Awaited<ReturnType<typeof paidCalls>>; partial: boolean }> {
  const { paid, partial } = await readCallSessions(store);
  return { paid, partial };
}

type CallRow = Awaited<ReturnType<typeof paidCalls>>[number];

/**
 * The most charges one reading of a store's bookings asks Stripe about a
 * dispute (queue 388 [TB14]): only a charge Stripe marks as disputed is
 * asked (GET /disputes?charge=, lib/refunds.ts, keptUnlessLost), which is
 * rare, and none else. Past it, or when Stripe cannot be asked, the booking
 * keeps its time: in the doubt the buyer keeps what they paid for, and a
 * later reading frees it (Claude 4, C4-20261105-2100-C6-4).
 */
export const DISPUTE_READS_PER_READING = 5;

/** Whether Stripe marks this booking's charge as disputed (the payment read with its latest charge expanded). */
function disputedCharge(row: SessionRow): boolean {
  const payment = row.payment_intent as { latest_charge?: { disputed?: unknown } | null } | null | undefined;
  return !!payment && typeof payment === "object" && !!payment.latest_charge && typeof payment.latest_charge === "object" && payment.latest_charge.disputed === true;
}

/**
 * callFromRow, with a disputed charge asked about while `reads.left` lasts: a
 * dispute lost frees the booking as a full refund does (lib/refunds.ts, the
 * owner's rule of 4 November 2026: whatever its amount).
 */
async function callOrLost(store: Store, row: SessionRow, handles: Set<string>, reads: { left: number }): Promise<CallRow | "refunded" | null> {
  const call = callFromRow(row, handles);
  if (!call || call === "refunded" || !disputedCharge(row) || !store.stripeAccountId) return call;
  if (reads.left <= 0) {
    console.warn("a disputed booking keeps its time: this reading asked Stripe about as many disputes as it may", store.handle, call.session);
    return call;
  }
  reads.left -= 1;
  return (await keptUnlessLost(store.stripeAccountId, row.payment_intent)) ? "refunded" : call;
}

/**
 * A paid booking of this store from one checkout session, or null. A booking
 * refunded in full is `refunded`: it no longer holds its time or gets reminders.
 * A dispute lost is read by callOrLost, which asks Stripe.
 */
function callFromRow(row: SessionRow, handles: Set<string>): CallRow | "refunded" | null {
  const meta = row.metadata ?? {};
  if (meta.kind !== "call" || !handles.has(meta.store ?? "")) return null;
  if (!isSettled(row)) return null;
  const start = Number(meta.start);
  const end = Number(meta.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (refundedInFull(row.payment_intent)) return "refunded";
  const email = row.customer_details?.email;
  const name = row.customer_details?.name;
  return {
    session: typeof row.id === "string" ? row.id : "",
    start,
    end,
    product: meta.product ?? "",
    title: meta.title ?? "",
    email: typeof email === "string" && email ? email : null,
    name: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null,
    buyerTz: isTimeZone(meta.tz) ? meta.tz : "UTC",
    moves: 0,
    answers: readAnswers(row),
    amount: typeof row.amount_total === "number" ? row.amount_total : 0,
    currency: typeof row.currency === "string" && row.currency ? row.currency.toLowerCase() : "",
    ...(teamOf({ h: (meta.hosts ?? "").split(","), c: meta.claim }) ?? { hosts: [], claim: "" }),
    lead: /^[0-9a-f]{12}$/.test(meta.lead_via ?? "") ? (meta.lead_via as string) : "",
    pi: paymentOf(row.payment_intent),
    due: readDue(meta),
    cancel: readCancelPromise(meta),
  };
}

/** A checkout's payment's id, whether Stripe gave the id or the payment itself. */
export function paymentOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "";
}

async function withMoves(found: CallRow[]): Promise<CallRow[]> {
  const moves = await readMoves(found.map((call) => call.session));
  return found.map((call) => {
    const move = moves.get(call.session);
    return move ? { ...call, start: move.s, end: move.e, moves: move.n } : call;
  });
}

/**
 * A completed checkout row as Stripe gives it: its metadata a plain object.
 * A row whose metadata cannot be read could be a booking, so it is not read
 * as "not a call".
 */
function sessionRowKnown(row: Record<string, unknown>): boolean {
  return plainObject(ownField(row, "metadata"));
}

/**
 * The paid bookings Stripe lists for this store, and the sessions of those
 * refunded in full. Only completed checkouts are read, so holds that ran out
 * never use up the pages.
 *
 * Each page is read in its exact shape (lib/stripe-list.ts; CX-123 rule 24):
 * a page in another shape, a row that cannot be read, or a page that says
 * there is more without a row to read on from throws StripeListUnreadable,
 * never read as "no booking", so a paid time is never offered again.
 */
async function readCallSessions(store: Store): Promise<{ paid: CallRow[]; refunded: Set<string>; partial: boolean }> {
  const refunded = new Set<string>();
  if (!store.stripeAccountId) return { paid: [], refunded, partial: false };
  const handles = saleHandles(store);
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const found: CallRow[] = [];
  const reads = { left: DISPUTE_READS_PER_READING };
  let after = "";
  // Whether the last page read still said there were more: older bookings were then left out.
  let partial = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const list = readStripePage(
      await onAccount(
        "GET",
        store.stripeAccountId,
        `/checkout/sessions?limit=100&status=complete&created[gte]=${since}&expand[]=data.payment_intent.latest_charge${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
      ),
      sessionRowKnown,
    );
    if (list.unreadable > 0) throw new StripeListUnreadable(`${list.unreadable} checkout row(s) could not be read`);
    if (list.hasMore && !list.lastId) throw new StripeListUnreadable("more checkouts, with no row to read on from");
    const rows = list.rows as SessionRow[];
    for (const row of rows) {
      const call = await callOrLost(store, row, handles, reads);
      if (call === "refunded") {
        if (typeof row.id === "string") refunded.add(row.id);
      } else if (call) found.push(call);
    }
    if (!list.hasMore) break;
    if (page === MAX_PAGES - 1) partial = true;
    after = list.lastId as string;
  }
  return { paid: await withMoves(found), refunded, partial };
}

/**
 * One booking read straight from its checkout session, for a booking too far
 * back in a busy account to be among the sessions paidCalls reads. Null when
 * it is not a paid, unrefunded booking of this store.
 */
export async function paidCall(store: Store, session: string): Promise<CallRow | null> {
  if (!store.stripeAccountId || !/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(session)) return null;
  const row = (await onAccount(
    "GET",
    store.stripeAccountId,
    `/checkout/sessions/${encodeURIComponent(session)}?expand[]=payment_intent.latest_charge`,
  )) as SessionRow;
  const call = await callOrLost(store, row, saleHandles(store), { left: 1 });
  if (!call || call === "refunded") return null;
  return (await withMoves([call]))[0] ?? null;
}

export type PaidCall = Awaited<ReturnType<typeof paidCalls>>[number];

/**
 * Everything that makes a seat or a time unavailable, the paid calls behind
 * it, and the times the creator's own calendars say they are busy.
 */
async function readBusy(
  store: Store,
  now: number,
): Promise<{ busy: TeamBusy[]; paid: PaidCall[]; blocked: Busy[]; sessions: Busy[] }> {
  const local = store.callsId && isRedisConfigured() ? await heldAndBooked(store, now) : [];
  let paid: PaidCall[] = [];
  // Read alongside Stripe, and never a reason to fail: a calendar that does
  // not answer blocks nothing.
  const weekly = sellsAny(store, "weekly");
  const calendar = weekly
    ? calendarBusy(store, now).catch(() => ({ busy: [] as Busy[] }))
    : Promise.resolve({ busy: [] as Busy[] });
  // The creator's dated sessions count against weekly hours only.
  const sessions = weekly ? readListings(store, idsOfKind(store, "call")).then((calls) => sessionTimes(calls, now)) : Promise.resolve([]);
  // Awaited below; marked here so a failure while Stripe is being read is not left unheard.
  sessions.catch(() => {});
  let refunded = new Set<string>();
  try {
    let partial: boolean;
    ({ paid, refunded, partial } = await readCallSessions(store));
    // A reading that stopped at its last page while Stripe said there were more left older completed checkouts
    // unread: a paid booking among them, whose diary entry is missing, would be offered and sold again. Not every
    // paid booking is known then, so no time is offered or sold on this reading (Claude 2 on #3233).
    if (partial) throw new StripeListUnreadable(`more completed checkouts than ${MAX_PAGES} pages; paid bookings not all read`);
  } catch (error) {
    // Without Stripe's answer a paid time could be offered twice. Refusing to
    // show any time is the safe failure; the caller treats the throw as that.
    console.error("reading paid calls failed", error);
    throw error;
  }
  // Stripe's copy wins over ours: it is the ledger, and it is read with any
  // move applied. Each checkout session is one seat, however often it is seen.
  const fromStripe = new Set(paid.map((c) => c.session).filter(Boolean));
  // A booking refunded in full gives its time back.
  const gone = local.filter((b) => b.session && refunded.has(b.session));
  if (gone.length && store.callsId) {
    await redisPipeline([["HDEL", busyKey(store.callsId), ...gone.map((b) => b.field)]]).catch(() => {});
    // A team booking refunded in full gives its hosts their time back too.
    for (const b of gone) if (b.hosts && b.claim) await releaseClaim(b.hosts, b.claim).catch(() => {});
  }
  const busy: TeamBusy[] = [
    ...local.filter((b) => (!b.session || !fromStripe.has(b.session)) && !(b.session && refunded.has(b.session))),
    ...paid.map((c) => ({ start: c.start, end: c.end, product: c.product, session: c.session, ...(c.claim ? { hosts: c.hosts, claim: c.claim } : {}) })),
  ];
  return { busy, paid, blocked: (await calendar).busy, sessions: await sessions };
}

/** Every seat taken or held in this store, right now. */
export async function busyTimes(store: Store, now = Date.now()): Promise<Busy[]> {
  return (await readBusy(store, now)).busy;
}

/**
 * The creator's dated sessions still to come, as time they are not free for
 * a weekly call. A session keeps its time whether or not anybody booked it:
 * the creator put it in their diary.
 */
function sessionTimes(calls: Listing[], now: number): Busy[] {
  const out: Busy[] = [];
  for (const product of calls) {
    if (!product.call || product.call.kind !== "live") continue;
    for (const session of product.call.sessions) {
      const end = session.start + session.minutes * 60_000;
      if (end > now) out.push({ start: session.start, end, product: product.id });
    }
  }
  return out;
}

/**
 * What a product is checked against: its seats, and for weekly hours the
 * creator's dated sessions and the busy times of their own calendars too.
 * A team booking takes the store owner's time only when the owner is one of
 * its hosts; the other hosts' bookings leave the owner's own calls alone.
 */
function against(product: CallListing, busy: TeamBusy[], sessions: Busy[], blocked: Busy[] = [], owner = ""): Busy[] {
  const theirs = owner ? busy.filter((b) => !b.hosts || !b.hosts.length || b.hosts.includes(owner)) : busy;
  return product.call.kind === "weekly" ? [...theirs, ...sessions, ...blocked] : theirs;
}

/** The store owner's host id, for `against`. */
function ownerOf(store: Pick<Store, "email">): string {
  return hostId(store.email);
}

/**
 * Lets a buyer who went back from Stripe's page pick again.
 *
 * Their browser remembers the checkout it opened. When it asks for another
 * time in the same store, that checkout is closed at Stripe first — so it can
 * never be paid as well — and only then is its time let go. A checkout that
 * was paid in the meantime cannot be closed, and its time stays booked.
 */
export async function releaseOwnHold(store: Store, session: string): Promise<void> {
  if (!store.stripeAccountId || !store.callsId || !isRedisConfigured()) return;
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(session)) return;
  // A diary that cannot be read throws: the hold is left alone, as when it is not found, and runs out by itself.
  const flat = await readDiary(store.callsId);
  const held = readEntries(flat).filter(({ entry }) => entry.session === session && entry.until !== 0);
  const fields = held.map(({ field }) => field);
  if (!fields.length) return;
  try {
    const closed = await onAccount(
      "POST",
      store.stripeAccountId,
      `/checkout/sessions/${encodeURIComponent(session)}/expire`,
      new URLSearchParams(),
    );
    if (closed.status !== "expired") return;
  } catch {
    // Paid, or already closed by Stripe: either way the hold is left alone and
    // runs out by itself if nobody paid.
    return;
  }
  await redisPipeline([["HDEL", busyKey(store.callsId), ...fields]]);
  // A team hold lets its hosts' time go too, now that it can never be paid.
  for (const { entry } of held) {
    const team = teamOf(entry);
    if (team) await releaseClaim(team.hosts, team.claim).catch(() => {});
  }
}

/**
 * Sends the booking emails for paid calls whose buyer never came back.
 *
 * A buyer who pays and closes the tab before Stripe sends them back would
 * otherwise leave both inboxes empty. Every time the paid calls are read from
 * Stripe anyway — the booking page and the studio — any that were never
 * confirmed are confirmed now, and the mail job looks at every checkout once
 * it has closed (lib/call-reminders.ts). confirmBooking is guarded, so this
 * never sends the same pair twice.
 */
export async function catchUpBookings(store: Store, paid: PaidCall[], origin: string): Promise<void> {
  if (!isRedisConfigured() || !store.callsId) return;
  const now = Date.now();
  const due = paid.filter((c) => c.session && c.end > now).slice(0, 20);
  if (!due.length) return;
  const seen = await redisPipeline(due.map((c) => ["EXISTS", confirmedKey(c.session)]));
  const find = listingFinder(store);
  for (let i = 0; i < due.length; i += 1) {
    if (Number(seen[i]) === 1) continue;
    const call = due[i];
    const product = await find(call.product);
    if (!product || !isCallProduct(product)) continue;
    await confirmBooking({
      store,
      product,
      session: call.session,
      start: call.start,
      end: call.end,
      buyerEmail: call.email,
      buyerName: call.name,
      buyerTz: call.buyerTz,
      moves: call.moves,
      answers: call.answers,
      amountCents: call.amount,
      currency: call.currency,
      lead: call.lead,
      pi: call.pi,
      due: call.due,
      cancel: call.cancel,
      origin,
    }).catch((error) => console.error("catching up a booking failed", error));
  }
}

/** Whether a product can be booked right now. */
export function isCallProduct<T extends Listing>(product: T): product is T & { call: CallSetup } {
  return product.call !== null;
}

/** Whether a booking was already confirmed, so the mail job knows to leave it. */
export async function isConfirmed(session: string): Promise<boolean> {
  const [seen] = await redisPipeline([["EXISTS", confirmedKey(session)]]);
  return Number(seen) === 1;
}

// ---- Saving a product's setup --------------------------------------------

export type ChangeProblem = "past" | "upcoming" | "booked" | "booked_seats" | "kind" | "error";

/**
 * Checks a new setup against what buyers already hold, and tidies it.
 *
 * Whatever a buyer paid for stays as it was sold: a dated session somebody
 * booked keeps its date, time and length, and keeps at least as many seats
 * as are taken; a product with bookings still to come keeps its kind. The
 * meeting link and everything else can change. Sessions long over are let
 * go, and a new or changed session has to be in the future. Stripe is only
 * asked when a change could touch a booking.
 */
export async function checkCallChange(
  store: Store,
  productId: string,
  next: CallSetup,
  now = Date.now(),
): Promise<CallSetup | ChangeProblem> {
  const before = (await readListing(store, productId))?.call ?? null;
  const was = before && before.kind === "live" ? before.sessions : [];
  const byId = new Map(was.map((s) => [s.id, s]));

  let setup = next;
  if (next.kind === "live") {
    const keepFrom = now - KEEP_PAST_SESSION_DAYS * 86_400_000;
    const sessions = next.sessions.filter((s) => s.start + s.minutes * 60_000 > keepFrom);
    for (const session of sessions) {
      if (session.start > now) continue;
      const old = byId.get(session.id);
      if (!old || old.start !== session.start || old.minutes !== session.minutes) return "past";
    }
    if (!sessions.some((s) => s.start > now)) return "upcoming";
    setup = { ...next, sessions, minutes: sessions[0].minutes };
  }

  // Online to in person, or back (lib/call-place.ts), is a change of kind too: whoever booked was told where, or given a link.
  const switching = before !== null && (before.kind !== setup.kind || whereOf(before).kind !== whereOf(setup).kind);
  const touched = was.filter((old) => {
    if (old.start + old.minutes * 60_000 <= now) return false;
    const kept = setup.kind === "live" ? setup.sessions.find((s) => s.id === old.id) : undefined;
    return !kept || kept.start !== old.start || kept.minutes !== old.minutes || kept.seats < old.seats;
  });
  if (!switching && touched.length === 0) return setup;

  let busy: Busy[];
  try {
    busy = await busyTimes(store, now);
  } catch {
    return "error";
  }
  if (switching && busy.some((b) => b.product === productId && b.end > now)) return "kind";
  for (const old of touched) {
    const taken = seatsTaken(busy, productId, old.start);
    if (taken === 0) continue;
    const kept = setup.kind === "live" ? setup.sessions.find((s) => s.id === old.id) : undefined;
    if (!kept || kept.start !== old.start || kept.minutes !== old.minutes) return "booked";
    if (kept.seats < taken) return "booked_seats";
  }
  return setup;
}

// ---- The lock around a check and a write ---------------------------------

/** The one reply of a single command, in a reply list of exactly one; UnknownReplyError otherwise. */
async function onlyReply(command: (string | number)[], what: string): Promise<unknown> {
  const one = repliesFor(await redisPipeline([command]), 1);
  if (!one) throw new UnknownReplyError(what);
  return one[0];
}

/**
 * Takes the store's lock: true when it is ours, false when somebody else
 * holds it. Each reply is read exactly (CX-123 rule 24; Claude 6, audit round
 * 5): only "OK" to the SET NX takes the lock and nil is somebody else's; any
 * other answer throws UnknownReplyError, and the caller refuses, opening no
 * checkout and writing no move. A held lock is taken over only when its GET
 * is a time in milliseconds that is 15 seconds old, and only on an "OK" to
 * that SET; a GET in another shape, or one that says the lock is gone while
 * SET NX still says it is held, is never read as a lock left behind.
 */
async function takeLock(callsId: string): Promise<boolean> {
  const lock = lockKey(callsId);
  const take = async (): Promise<boolean> => {
    const got = await onlyReply(["SET", lock, String(Date.now()), "NX", "EX", 15], "a call lock's SET NX");
    if (got === "OK") return true;
    if (got === null) return false;
    throw new UnknownReplyError("a call lock's SET NX");
  };
  // Another buyer of this store may be picking a time right now. They hold
  // the lock for a second or two, so wait for it rather than turn this one
  // away over a time nobody took.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    if (await take()) return true;
  }
  const held = await onlyReply(["GET", lock], "a call lock's GET");
  // Gone since: tried once more, never taken over.
  if (held === null) return take();
  if (typeof held !== "string" || !/^\d{1,16}(\.\d{1,9})?$/.test(held)) throw new UnknownReplyError("a call lock's GET");
  // A lock left behind by a request that died is taken over after 15 seconds.
  if (Date.now() - Number(held) < 15_000) return false;
  if ((await onlyReply(["SET", lock, String(Date.now()), "EX", 15], "a call lock's take-over")) !== "OK") {
    throw new UnknownReplyError("a call lock's take-over");
  }
  return true;
}

async function dropLock(callsId: string): Promise<void> {
  await redisPipeline([["DEL", lockKey(callsId)]]).catch(() => {});
}

/**
 * Whether this store's bookings write to anybody.
 *
 * Every store does, but the demo store (lib/house-store.ts), whose checkout
 * takes any address and charges nothing: a confirmation from it would be a
 * way to send mail to anybody who was typed into it, and its own owner is an
 * address nobody reads. Its buyers are given the time and the meeting link on
 * the page instead, which is where a booking shows them anyway.
 */
function writesAboutBookings(store: Store): boolean {
  return isSenderConfigured() && !isHouseStore(store);
}

export type HoldResult =
  | { ok: true; url: string; session: string }
  | { ok: false; reason: "taken" | "invalid" | "unavailable" | "error" | "host-changed" };


/**
 * Holds a seat and opens a checkout for it, on the creator's account.
 *
 * The time is checked again here, against fresh data, because a page that
 * listed it a minute ago may be out of date. A short lock around the check
 * and the hold stops two buyers from winning the same seat at once — the
 * only seat of a one-to-one call, or the last of a group call.
 */
/**
 * The checkout of one booking, as Stripe is sent it: its price, what the
 * store needs to know about it, and — for a session from a package — the
 * coupon that makes it free. Kept apart from the holding of the time so the
 * same request can be checked against Stripe itself (app/api/verify/stripe).
 */
export function callCheckoutBody(input: {
  store: Store;
  product: Product;
  start: number;
  end: number;
  buyerTz: string;
  origin: string;
  via: { aff: string; rate: number } | null;
  fromPackage: { id: string; coupon: string; email: string; back: string } | null;
  /** The channel this sale is credited to, as Stripe metadata (lib/visit-channel.ts). */
  channel?: Record<string, string>;
  /** A team booking: its hosts' ids and the claim on their time, kept on the sale so the ledger knows them. */
  team?: { hosts: string[]; claim: string } | null;
  /** The affiliate a lead is credited to once the call takes place, where the store pays per booking (lib/affiliate-leads.ts). */
  lead?: string | null;
  /**
   * A discount code on a booking with a deposit (lib/deposit-code.ts): off
   * the whole price, already read and figured; the deposit is never more
   * than the discounted price, and the rest is what is left of it.
   */
  code?: { id: string; code: string; figures: DepositFigures } | null;
  /**
   * The length the buyer chose, on a call with several (lib/call-lengths.ts,
   * bookingLength): its price is what is charged, and the length is said on
   * the line and kept on the sale. None: the product's own price.
   */
  length?: { minutes: number; cents: number } | null;
}): URLSearchParams {
  const { store, product, start, end, buyerTz, origin } = input;
  const pkg = input.fromPackage;
  const length = product.call?.lengths?.length ? input.length ?? null : null;
  const priceCents = length ? length.cents : product.priceCents;
  // Said in the buyer's own time zone: they are the one reading Stripe's page,
  // in the store's language (lib/store-language.ts). The same title is kept
  // on the sale, as what the buyer saw.
  const lang = LANGUAGES[parseLanguage(store.language)];
  const when = `${readableTime(start, buyerTz, lang.locale)} (${zoneName(start, buyerTz, lang.locale)})`;
  // Never from a package: the package was the payment.
  const code = pkg ? null : input.code ?? null;
  const due = pkg
    ? { cents: priceCents, rest: 0 }
    : code
      ? { cents: code.figures.charged, rest: code.figures.rest }
      : chargeNow({ priceCents, currency: store.currency, deposit: product.call?.deposit ?? null, inPerson: Boolean(product.call?.place) });
  // A call with several lengths says the one chosen, in the store's language, on Stripe's page and on the sale.
  const name = `${product.title}${length ? bookingWords(store.language).chosenLength(length.minutes) : ""} \u2014 ${when}`;
  const body = new URLSearchParams({
    mode: "payment",
    locale: lang.stripe,
    "line_items[0][quantity]": "1",
    // In the store's own currency (lib/money.ts), like every price it has.
    "line_items[0][price_data][currency]": store.currency,
    // A deposit on an in-person booking (lib/call-deposit.ts): only it is charged here; the rest is paid in person.
    "line_items[0][price_data][unit_amount]": String(due.cents),
    "line_items[0][price_data][product_data][name]": name.slice(0, 250),
    "metadata[store]": store.handle,
    "metadata[product]": product.id,
    "metadata[title]": name.slice(0, 480),
    "metadata[kind]": "call",
    ...Object.fromEntries(Object.entries(input.channel ?? {}).map(([key, value]) => [`metadata[${key}]`, value])),
    "metadata[start]": String(start),
    "metadata[end]": String(end),
    "metadata[tz]": buyerTz,
    "payment_intent_data[metadata][store]": store.handle,
    "payment_intent_data[metadata][product]": product.id,
    "payment_intent_data[metadata][kind]": "call",
    "payment_intent_data[metadata][start]": String(start),
    success_url: `${origin}/@${store.handle}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    // Back from Stripe's page, the length chosen is still chosen (3.3.7).
    cancel_url: `${origin}/@${store.handle}/book/${product.id}${length && length.minutes !== product.call?.minutes ? `?length=${length.minutes}` : ""}`,
  });
  if (product.summary) body.set("line_items[0][price_data][product_data][description]", product.summary);
  // The creator's cancellation deadline (lib/call-setup.ts, cancelHours): said before paying; never for a session from a package, which pays nothing here.
  // A time already inside it when booked is told so, never promised a refund nobody owes.
  const cancelHours = pkg ? 0 : product.call?.cancelHours ?? 0;
  const cancelLate = cancelHours > 0 && start - Date.now() < cancelHours * 3_600_000;
  if (due.rest > 0 || code || cancelHours) {
    // Said on Stripe's own page, before paying, and kept on the sale for the creator.
    const said = formatMoney(due.rest, store.currency, lang.locale);
    const bw = bookingWords(store.language);
    // The creator's own summary first, then the sentence, kept whole within Stripe's 500 characters.
    // With a code, what it took off the whole price is said too (the owner's decision of 2 November 2026).
    const sentence = [
      code ? bw.codeOffPrice(code.code, formatMoney(code.figures.off, store.currency, lang.locale)) : "",
      due.rest > 0 ? bw.depositRest(said, store.name) : "",
      cancelHours ? (cancelLate ? bw.cancelTooLate(cancelHours, store.name) : bw.cancelPolicy(cancelHours, store.name)) : "",
    ].filter(Boolean).join(" ");
    const summary = product.summary ? product.summary.slice(0, Math.max(0, 500 - sentence.length - 3)) : "";
    body.set("line_items[0][price_data][product_data][description]", summary ? `${summary} \u2014 ${sentence}` : sentence.slice(0, 500));
    if (due.rest > 0) {
      body.set("metadata[deposit]", String(due.cents));
      body.set("metadata[rest]", String(due.rest));
      body.set("payment_intent_data[metadata][rest]", String(due.rest));
    }
    if (cancelHours) {
      // The promise as made, kept on the sale: the confirmation and any refund read it from there (lib/call-setup.ts, readCancelPromise).
      body.set("metadata[cancel_hours]", String(cancelHours));
      if (cancelLate) body.set("metadata[cancel_late]", "1");
    }
    if (code) {
      // The whole price, the code and what it took off, on the sale for the creator's orders.
      body.set("metadata[price]", String(priceCents));
      body.set("metadata[code]", code.code);
      body.set("metadata[code_off]", String(code.figures.off));
      body.set("payment_intent_data[metadata][code]", code.code);
    }
  }
  if (length) body.set("metadata[minutes]", String(length.minutes));
  if (input.team) {
    body.set("metadata[hosts]", input.team.hosts.join(","));
    body.set("metadata[claim]", input.team.claim);
  }
  if (pkg) {
    body.set("discounts[0][coupon]", pkg.coupon);
    body.set("customer_email", pkg.email);
    body.set("metadata[package]", pkg.id);
    body.set("cancel_url", pkg.back);
    // Nothing is paid, so Stripe makes no payment of it to carry these.
    for (const key of [...body.keys()]) if (key.startsWith("payment_intent_data")) body.delete(key);
  } else if (store.hasDiscounts && due.rest === 0 && !code) body.set("allow_promotion_codes", "true");
  // With a deposit, Stripe's box would take a code off the deposit alone: the code is typed on the booking page instead and taken off the whole price (lib/deposit-code.ts).
  // Sent by an affiliate: credited to them, at today's share (lib/affiliates.ts).
  // A booking is one product, with nothing else able to ride along, so a
  // share of nothing is a sale that earns nothing and is not written down.
  if (input.via && input.via.rate > 0 && !pkg) {
    body.set("metadata[via]", input.via.aff);
    body.set("metadata[via_rate]", String(input.via.rate));
    body.set("payment_intent_data[metadata][via]", input.via.aff);
  }
  // A lead, where the store pays per call that takes place: carried whatever the share, never from a package,
  // whose purchase was the sale, and credited only once Stripe says it is paid (confirmBooking).
  if (input.lead && /^[0-9a-f]{12}$/.test(input.lead) && !pkg) body.set("metadata[lead_via]", input.lead);
  // What the creator wants to know before the call, asked before paying.
  applyCheckoutFields(body, product.fields);
  applyTax(store, body);
  // Not for a session from a package: nothing is paid, so there is nothing to
  // invoice, and the package's own checkout already asked (lib/call-packages.ts).
  if (!pkg) applyTaxDocuments(store, body, false);
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  // Stripe will not keep a checkout open for less than half an hour, counted
  // from when it makes it, so the closing time is set at the last moment;
  // the hold is counted from after, and lasts a minute longer, so the time
  // is never released while the page that pays for it is still open.
  body.set("expires_at", String(checkoutClosesAt()));
  return body;
}

/**
 * The listed site an embedded calendar booked from, kept on the sale: written
 * after everything else (the platform's share included, lib/platform-share.ts),
 * and only while Stripe's fifty metadata fields have room, as
 * lib/store-checkout.ts writes it, so it is never what stops a booking.
 */
export function keepEmbedSite(body: URLSearchParams, site: string | null | undefined, fromPackage: boolean): void {
  if (!site || !/^https:\/\//.test(site) || fromPackage) return;
  // Back from Stripe's page, the listed site stays with the booking page, so a second try is still the site's (3.3.7).
  const cancel = body.get("cancel_url");
  if (cancel) {
    const url = new URL(cancel);
    url.searchParams.set("site", site.slice(0, 700));
    body.set("cancel_url", url.toString());
  }
  if ([...body.keys()].filter((key) => key.startsWith("metadata[")).length >= 50) return;
  body.set("metadata[embed_site]", site.slice(0, 300));
}

/** The API version a checkout with nothing to pay is made at (lib/call-packages.ts). */
export const NO_COST_VERSION = "2026-08-26.dahlia";

export async function holdAndCheckout(input: {
  store: Store;
  product: Product & { call: CallSetup };
  start: number;
  buyerTz: string;
  origin: string;
  /**
   * On a team that lets buyers choose (lib/team-scheduling-rules.ts,
   * chosenTeam): the host's position and name as the page showed them; only
   * that host is held, or the booking is refused as "host-changed".
   */
  host?: { key: string; label: string } | null;
  /** A discount code on a booking with a deposit, already read and figured (lib/deposit-code.ts). */
  code?: { id: string; code: string; figures: DepositFigures } | null;
  /** The affiliate whose link the buyer followed, and the share it earns. */
  via?: { aff: string; rate: number } | null;
  /** The affiliate a lead is credited to once the call takes place (callCheckoutBody). */
  lead?: string | null;
  /**
   * A session from a package already paid for (lib/call-packages.ts): the
   * checkout carries a coupon for the whole of it, so nothing is charged, and
   * the package's address, so the booking is theirs.
   */
  fromPackage?: { id: string; coupon: string; email: string; back: string } | null;
  /** The channel this sale is credited to, as Stripe metadata (lib/visit-channel.ts channelOfRequest). */
  channel?: Record<string, string>;
  /** The length the buyer chose, in minutes, on a call with several (lib/call-lengths.ts); none is the setup's own. */
  minutes?: unknown;
  /** The listed site the calendar embedded there booked from, already checked against the creator's list (app/api/store/book). */
  embedSite?: string | null;
}): Promise<HoldResult> {
  const { store, product, start, origin } = input;
  if (!store.stripeAccountId || !store.callsId || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // Weekly hours: the length chosen, at its own price, or the booking is refused, never charged at another length's price.
  const booked = product.call.kind === "weekly" ? bookingLength(product.call, product.priceCents, input.minutes) : null;
  if (product.call.kind === "weekly" && !booked) return { ok: false, reason: "invalid" };
  // Another length than the setup's own is never had from a package, with a deposit or with a code, whose figures are the product's own price.
  const other = booked !== null && booked.minutes !== product.call.minutes;
  if (other && (input.fromPackage || product.call.deposit || input.code)) return { ok: false, reason: "invalid" };
  // Every check below, and the hold, are at the chosen length.
  const setup: CallSetup = booked ? { ...product.call, minutes: booked.minutes } : product.call;
  const length = lengthAt(setup, start);
  // A dated session the creator has since taken off.
  if (length === null) return { ok: false, reason: "taken" };
  const end = start + length;
  const buyerTz = isTimeZone(input.buyerTz) ? input.buyerTz : setup.tz;

  const whole = await activeTeam(store, product).catch(() => "closed" as const);
  if (whole === "closed") return { ok: false, reason: "unavailable" };
  // The host the buyer chose, never anyone else: a team edited since the page was drawn is said, not guessed.
  const chosen = whole && input.host?.key ? chosenTeam(whole, input.host.key, input.host.label) : null;
  if (chosen === "changed") return { ok: false, reason: "host-changed" };
  const team = chosen ?? whole;
  // A team's hosts' times are read at the setup's own length (lib/call-lengths.ts).
  if (team && other) return { ok: false, reason: "invalid" };

  // Counted as orders, admitted before anything is held or opened: nobody is stopped while paying.
  const admitted = await admitOrders(store, CALL_ORDER_UNITS);
  // Past the store's orders the buyer is told the call cannot be booked right now, and nothing is charged.
  if (!admitted.ok) return { ok: false, reason: "unavailable" };

  // A lock that cannot be read is not ours: refused, and nothing is opened. It is not let go either (it may be
  // somebody else's); it runs out at its own 15 seconds.
  let locked: boolean;
  try {
    locked = await takeLock(store.callsId);
  } catch (error) {
    console.error("taking a call's lock failed", error);
    return { ok: false, reason: "error" };
  }
  if (!locked) return { ok: false, reason: "taken" };

  // A team booking's claim on its hosts' time, once taken: let go again if no checkout comes of it.
  let claimed: { hosts: string[]; claim: string } | null = null;
  let opened = false;
  try {
    // Read once the lock is ours, so the check is about this moment.
    const now = Date.now();
    if (team) {
      try {
        const read = await readBusy(store, now);
        // Inside the lock nobody waits on a calendar: the reading the page just made is used.
        const ctx = await teamContext(store, product, team, [...read.busy, ...read.sessions, ...read.blocked], now, { refresh: false });
        if (!teamBookable(setup, team, ctx.states, now, start)) return { ok: false, reason: "taken" };
        const held = await holdTeam({ store, product, ctx, start, end, claim: newClaimId(), holdMs: HOLD_SECONDS * 1000, now });
        if (!held.ok) return { ok: false, reason: held.reason };
        claimed = { hosts: held.hosts, claim: held.claim };
      } catch {
        return { ok: false, reason: "error" };
      }
    } else {
      let busy: Busy[];
      try {
        const read = await readBusy(store, now);
        busy = against(product, read.busy, read.sessions, read.blocked, ownerOf(store));
      } catch {
        return { ok: false, reason: "error" };
      }
      if (!isBookable(setup, now, busy, start, product.id)) return { ok: false, reason: "taken" };
    }

    const pkg = input.fromPackage ?? null;
    const body = callCheckoutBody({ store, product, start, end, buyerTz, origin, via: input.via ?? null, fromPackage: pkg, channel: input.channel, team: claimed, length: booked, lead: input.lead ?? null, code: input.code ?? null });
    // The share of the sale, when the store's plan has one (lib/platform-share.ts).
    // A session from a package pays nothing here: its share was taken on the package.
    if (!pkg) {
      // A code typed on the booking page is already off the amount, and Stripe's page offers none then.
      const mayComeOff = store.hasDiscounts && shareBps(store) > 0 && !input.code ? await codesMayTakeOff(store.stripeAccountId, store.currency) : [];
      applyShare(body, store, { recurring: false, least: leastPaid(linesTotal(body).cents, mayComeOff) });
    }
    // Kept on the sale last, after the share (keepEmbedSite).
    keepEmbedSite(body, input.embedSite, Boolean(pkg));

    // A session from a package is a checkout with nothing to pay, which Stripe
    // takes only at API version 2023-08-16 or later
    // (docs.stripe.com/payments/checkout/no-cost-orders). A creator's own
    // account may default to an older one, so that checkout names its version.
    const account = store.stripeAccountId;
    // A store with reminders on: Stripe asks the buyer whether they want to
    // hear from the creator, and a buyer who said yes and left gets one email
    // leading back to the times still open (lib/checkout-recovery.ts). The
    // checkout keeps its own closing time, which the hold is counted from.
    let asking = !pkg && recoveryOn(store) && store.recovery.asks;
    if (asking) askForCallReminder(body);
    const open = () => onAccount("POST", account, "/checkout/sessions", body, pkg ? NO_COST_VERSION : undefined);
    const session = await openKeepingTheSale(body, async () => {
      try {
        return await open();
      } catch (error) {
        if (!asking || !refusedRecovery(error)) throw error;
        // Stripe decides which accounts it asks for consent for: refused, the call still sells.
        console.error("call checkout refused the reminder fields; opened without them", error);
        withoutCallReminder(body);
        asking = false;
        return open();
      }
    });
    if (typeof session.url !== "string" || !session.url || typeof session.id !== "string") {
      return { ok: false, reason: "error" };
    }
    // A checkout that can be paid keeps its hosts' claim, whatever happens next.
    opened = true;
    const until = Date.now() + HOLD_SECONDS * 1000;
    const entry: Entry = { s: start, e: end, until, session: session.id, p: product.id, ...(claimed ? { h: claimed.hosts, c: claimed.claim } : {}) };
    await redisPipeline([["HSET", busyKey(store.callsId), session.id, JSON.stringify(entry)]]);
    // Once the checkout can no longer be open, the mail job looks at it: a
    // buyer who paid and never came back is confirmed then.
    await planCheck(store.callsId, store.handle, session.id, start, until + 60_000).catch((error) =>
      console.error("planning a booking check failed", error),
    );
    return { ok: true, url: session.url, session: session.id };
  } catch (error) {
    console.error("holding a call failed", error);
    return { ok: false, reason: "error" };
  } finally {
    // No checkout was opened for the claim: nobody can pay for it, so its hosts get the time back.
    if (claimed && !opened) await releaseClaim(claimed.hosts, claimed.claim).catch(() => {});
    await dropLock(store.callsId);
  }
}

export type Offer = {
  /** Weekly hours: open times, by the creator's day. */
  days: ReturnType<typeof openSlots>;
  /** Group calls: seats left at each open time, by start. */
  left: Record<string, number>;
  /** Dated sessions still on sale. */
  sessions: ReturnType<typeof openSessions>;
};

function offerFrom(product: CallListing, now: number, seats: TeamBusy[], sessions: Busy[], blocked: Busy[], owner = ""): Offer {
  const setup = product.call;
  if (setup.kind === "live") return { days: [], left: {}, sessions: openSessions(setup, now, seats, product.id) };
  const days = openSlots(setup, now, against(product, seats, sessions, blocked, owner), product.id);
  const left: Record<string, number> = {};
  if (setup.seats > 1) {
    for (const day of days) {
      for (const start of day.starts) left[String(start)] = setup.seats - seatsTaken(seats, product.id, start);
    }
  }
  return { days, left, sessions: [] };
}

/**
 * Every open time or session for a call product, or null when it cannot be
 * read, and the paid calls read on the way, for catchUpBookings.
 */
export async function slotsForProduct(store: Store, product: CallListing, pick?: { key: string } | null, minutes?: number | null) {
  // One of a call's lengths (lib/call-lengths.ts): its times, at that length. Never on a team, whose hosts' times are read
  // at the setup's own length: there the length asked is not read, and `team` says so, so the page offers no lengths.
  const atLength = Boolean(minutes && product.call.kind === "weekly" && minutes !== product.call.minutes && product.call.lengths?.some((l) => l.minutes === minutes));
  try {
    const now = Date.now();
    const { busy, paid, blocked, sessions } = await readBusy(store, now);
    const whole = await activeTeam(store, product);
    // A team event type the plan or the team no longer allows: nothing on offer.
    if (whole === "closed") return { days: [], left: {}, sessions: [], paid, team: true };
    if (atLength && !whole) product = { ...product, call: { ...product.call, minutes: minutes as number } };
    if (whole) {
      // A team that lets buyers choose: who they may pick, and only the chosen host's times once they have.
      const hosts = hostChoices(whole);
      const picked = pick?.key ? hosts.find((h) => h.key === pick.key) ?? null : null;
      const narrowed = picked ? chosenTeam(whole, picked.key, picked.label) : null;
      const team = narrowed && narrowed !== "changed" ? narrowed : whole;
      // The page is where each host's calendar is read again, when its last reading is old.
      const ctx = await teamContext(store, product, team, [...busy, ...sessions, ...blocked], now, { refresh: true });
      return { days: teamDays(product.call, ctx, now), left: {}, sessions: [], paid, hosts, picked, team: true };
    }
    return { ...offerFrom(product, now, busy, sessions, blocked, ownerOf(store)), paid, team: false };
  } catch {
    return null;
  }
}

/**
 * The times a booking may move to: everything open, counted as if its own
 * seat were already free — so a one-hour call can move half an hour later —
 * and never the time it already has.
 */
export async function slotsForMove(
  store: Store,
  product: CallListing,
  session: string,
  current: number,
  /** How long the booking is, in milliseconds: times are offered at the booking's own length (lib/call-lengths.ts, ownLength). */
  bookedMs: number,
): Promise<Offer | null> {
  const kept = ownLength(product.call, bookedMs);
  if (kept === "unknown") return null;
  // The team is read as it is kept, at the call's own length, as moveBooking reads it; only its hosts' times are read at the
  // length paid for. Read at the paid length, a host stretch shorter than it would drop the whole team, and the page would
  // fall back to the store's hours, which the move then refuses.
  const listed = product;
  if (kept !== null) product = { ...product, call: { ...product.call, minutes: kept } };
  try {
    const now = Date.now();
    const { busy, blocked, sessions } = await readBusy(store, now);
    // A team booking moves with the host it has: only their free times are offered. The
    // team as it was saved is used, so a plan that now allows fewer never takes a buyer's move away.
    const own = busy.find((b) => b.session === session && b.hosts && b.claim);
    const team = own ? await teamForMove(store, listed) : null;
    if (team && own && own.hosts && own.claim) {
      const ctx = await teamContext(store, product, team, [...busy, ...sessions, ...blocked], now, { refresh: true, except: { session, claim: own.claim } });
      return { days: teamMoveDays(product.call, ctx, own.hosts, current, now), left: {}, sessions: [] };
    }
    const offer = offerFrom(product, now, busy.filter((b) => b.session !== session), sessions, blocked, ownerOf(store));
    return {
      days: offer.days
        .map((day) => ({ ...day, starts: day.starts.filter((start) => start !== current) }))
        .filter((day) => day.starts.length > 0),
      left: offer.left,
      sessions: offer.sessions.filter((s) => s.start !== current),
    };
  } catch {
    return null;
  }
}

// ---- Moving a booking ------------------------------------------------------

/** Where a buyer moves their booking. The checkout session is the key, as on the thanks page. */
export function moveLink(origin: string, store: Store, productId: string, session: string): string {
  return `${origin}/@${store.handle}/book/${productId}?move=${encodeURIComponent(session)}`;
}

/**
 * Whether a booking at `start` may still be moved by its buyer: before the
 * creator's notice runs out, fewer than MAX_MOVES times, and — for a dated
 * session — only when there is another session to go to.
 */
export function canMove(setup: CallSetup, start: number, moves: number, now = Date.now()): boolean {
  return whyNotMove(setup, start, moves, now) === null;
}

/** Why a booking cannot be moved any more, or null when it can. */
export function whyNotMove(
  setup: CallSetup,
  start: number,
  moves: number,
  now = Date.now(),
): "limit" | "late" | "nowhere" | null {
  if (moves >= MAX_MOVES) return "limit";
  if (now > movableUntil(setup, start)) return "late";
  if (setup.kind === "live") {
    const closes = setup.noticeHours * 3600_000;
    if (!setup.sessions.some((s) => s.start !== start && s.start - closes > now)) return "nowhere";
  }
  return null;
}

export type MoveResult =
  | { ok: true; start: number; end: number; moves: number }
  | { ok: false; reason: "late" | "limit" | "same" | "taken" | "unavailable" | "error" };

/**
 * Moves a paid booking to another open time, for its buyer.
 *
 * `booked` is the booking as Stripe has it, read by the caller from the
 * checkout session. The move record is read again inside the lock, so two
 * tabs moving the same booking at once cannot both count as the first move,
 * and the new time is checked the way a new booking is. The old seat is let
 * go in the same step, and both people are told, with a new calendar file.
 */
export async function moveBooking(input: {
  store: Store;
  product: CallListing;
  session: string;
  booked: { start: number; end: number; email: string | null; buyerTz: string };
  start: number;
  origin: string;
}): Promise<MoveResult> {
  const { store, product, session, start, origin } = input;
  const setup = product.call;
  if (!store.callsId || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const length = lengthAt(setup, start);
  if (length === null) return { ok: false, reason: "taken" };
  let end = start + length;
  const callsId = store.callsId;
  // Moves keep their hosts, so the team as it was saved is used whatever the plan allows now. A team that cannot be read
  // is not known, never "no team" (rule 24): moved by the store's own hours, its hosts' claim would be let go below.
  let team: Awaited<ReturnType<typeof teamForMove>>;
  try {
    team = await teamForMove(store, product);
  } catch (error) {
    console.error("reading a moved booking's team failed", error);
    return { ok: false, reason: "error" };
  }

  // As in holdAndCheckout: a lock that cannot be read refuses the move, and is left to run out.
  let locked: boolean;
  try {
    locked = await takeLock(callsId);
  } catch (error) {
    console.error("taking a call's lock for a move failed", error);
    return { ok: false, reason: "error" };
  }
  if (!locked) return { ok: false, reason: "taken" };
  let from: { start: number; end: number; moves: number };
  let teamOwn: { hosts: string[]; claim: string } | null = null;
  // A team booking whose call is no longer a team event: its hosts' old claim is let go after the move.
  let letGo: { hosts: string[]; claim: string } | null = null;
  try {
    const now = Date.now();
    const recorded = (await readMoves([session])).get(session);
    from = recorded
      ? { start: recorded.s, end: recorded.e, moves: recorded.n }
      : { start: input.booked.start, end: input.booked.end, moves: 0 };
    if (from.moves >= MAX_MOVES) return { ok: false, reason: "limit" };
    // Weekly hours move at the length paid for, whatever the setup says now (lib/call-lengths.ts, ownLength).
    const kept = ownLength(setup, from.end - from.start);
    if (kept === "unknown") return { ok: false, reason: "error" };
    if (kept !== null) end = start + kept * 60_000;
    const at: CallSetup = kept !== null ? { ...setup, minutes: kept } : setup;
    if (now > movableUntil(setup, from.start)) return { ok: false, reason: "late" };
    if (start === from.start) return { ok: false, reason: "same" };

    let busy: TeamBusy[];
    let blocked: Busy[];
    let sessions: Busy[];
    try {
      ({ busy, blocked, sessions } = await readBusy(store, now));
    } catch {
      return { ok: false, reason: "error" };
    }
    const own = busy.find((b) => b.session === session && b.hosts && b.claim);
    if (own && own.hosts && own.claim && !team) letGo = { hosts: own.hosts, claim: own.claim };
    if (team && own && own.hosts && own.claim) {
      // The booking keeps its hosts, and their claim moves to the new time in one step.
      teamOwn = { hosts: own.hosts, claim: own.claim };
      try {
        // The hosts are checked at the length paid for (`at`), the length the booking is written at, never the call's
        // length now: a paid hour never runs past a host's working hours or into their next event.
        const paid: CallListing = { ...product, call: at };
        const ctx = await teamContext(store, paid, team, [...busy, ...sessions, ...blocked], now, { refresh: false, except: { session, claim: own.claim } });
        if (!(await moveTeamClaim({ store, product: paid, ctx, hosts: own.hosts, claim: own.claim, start, end, now }))) return { ok: false, reason: "taken" };
      } catch {
        return { ok: false, reason: "error" };
      }
    } else {
      const others = against(product, busy.filter((b) => b.session !== session), sessions, blocked, ownerOf(store));
      if (!isBookable(at, now, others, start, product.id)) return { ok: false, reason: "taken" };
    }

    await writeMove(session, { s: start, e: end, n: from.moves + 1 });
    // The seat moves in the diary too: whatever was written under this
    // checkout — a hold, a booking, one filed by its start before group calls
    // — gives way to one entry at the new time.
    //
    // The move is written by now, so this reading is tidying only: read exactly (readDiary, entryOf), and when the
    // diary or an entry cannot be read, nothing is deleted and the move is still reported as done. An old entry
    // left in place keeps its old time taken (never a time freed on an unknown reply) until it runs out or the
    // call is long past.
    let old: string[] = [];
    try {
      old = readEntries(await readDiary(callsId))
        .filter(({ field, entry }) => entry.session === session && field !== session)
        .map(({ field }) => field);
    } catch (error) {
      console.error("reading a moved booking's old entries failed; left in place", error);
    }
    const entry: Entry = { s: start, e: end, until: 0, session, p: product.id, ...(teamOwn ? { h: teamOwn.hosts, c: teamOwn.claim } : {}) };
    // Counted in the store's room at what it really adds (lib/order-data.ts).
    await orderWrite(store, [
      ...(old.length ? [["HDEL", busyKey(callsId), ...old]] : []),
      ["HSET", busyKey(callsId), session, JSON.stringify(entry)],
      // Moved before it was ever confirmed: the move email says it all, and
      // no "Booked" email for the old time follows it.
      ["SET", confirmedKey(session), "1", "NX", "EX", CONFIRMED_SECONDS],
    ]);
  } catch (error) {
    console.error("moving a booking failed", error);
    return { ok: false, reason: "error" };
  } finally {
    await dropLock(callsId);
  }

  const moves = from.moves + 1;
  if (letGo) await releaseClaim(letGo.hosts, letGo.claim).catch(() => {});
  try {
    await unplanReminders(callsId, store.handle, session, from.start);
    if (writesAboutBookings(store)) await planReminders(callsId, store.handle, session, start);
  } catch (error) {
    console.error("planning reminders after a move failed", error);
  }
  // A Google Meet or Zoom meeting moves with the booking (lib/meet-links.ts),
  // before anybody is told, so the emails carry the link of the new time.
  await callMoved({ store, product, session, from, start, end, email: input.booked.email }).catch((error) =>
    console.error("moving a booking's meeting failed", error),
  );
  const hosts = team && teamOwn ? hostEmails(team, teamOwn.hosts) : [];
  await tellMoved({ store, product, session, from, start, end, moves, email: input.booked.email, buyerTz: input.booked.buyerTz, origin, hosts }).catch(
    (error) => console.error("sending the move emails failed", error),
  );
  await emitEvent(store, "call.moved", `${session}|${moves}`, {
    checkout_session: session,
    product: { id: product.id, title: product.title },
    from: { start: new Date(from.start).toISOString(), end: new Date(from.end).toISOString() },
    to: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    moves,
    buyer: { email: input.booked.email, timezone: input.booked.buyerTz },
  }).catch((error) => console.error("queueing the call.moved webhook failed", error));
  return { ok: true, start, end, moves };
}

async function tellMoved(input: {
  store: Store;
  product: CallListing;
  session: string;
  from: { start: number; end: number };
  start: number;
  end: number;
  moves: number;
  email: string | null;
  buyerTz: string;
  origin: string;
  /** A team booking's hosts, by address: the creator's email goes to them (hostRecipient). */
  hosts?: string[];
}): Promise<void> {
  if (!writesAboutBookings(input.store)) return;
  const { store, product, session, from, start, end, moves, email, origin } = input;
  const hosts = input.hosts ?? [];
  const setup = product.call;
  const buyerTz = isTimeZone(input.buyerTz) ? input.buyerTz : setup.tz;
  // A one-to-one booking keeps its video room when it moves; a seat in a
  // group moves into the room of its new time (lib/call-rooms.ts).
  // In person (lib/call-place.ts): the address, and no link, not even a room kept from when it was online.
  const place = whereOf(setup).kind === "place" ? setup.place! : null;
  const room = place ? null : await roomOf(store.callsId, { product: product.id, setup, session, start, end });
  const video = isVideoRoom(room);
  // A link replaced after a failure counts too, so this file replaces every one sent before.
  const sequence = moves + (await linkUpdates(store.callsId, { session, product: product.id, start }));
  const invite = (note: string, words?: BookingWords) =>
    Buffer.from(
      callInvite({ uid: session, start, end, title: product.title, storeName: store.name, room, place, note, sequence, words }),
    ).toString("base64");
  const at = (ms: number, tz: string) => `${readableTime(ms, tz)} (${zoneName(ms, tz)})`;

  if (email) {
    // The buyer's email speaks the store's language (lib/buyer-words/booking.ts).
    const b = bookingWords(store.language);
    const locale = LANGUAGES[parseLanguage(store.language)].locale;
    const buyerAt = (ms: number) => `${readableTime(ms, buyerTz, locale)} (${zoneName(ms, buyerTz, locale)})`;
    const again = canMove(setup, start, moves);
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: storeSender(store),
      to: email,
      subject: b.movedSubject(product.title, store.name),
      text: [
        b.movedHead(store.name),
        "",
        b.titleLength(product.title, Math.round((end - start) / 60_000)),
        b.nowAt(buyerAt(start)),
        b.wasAt(buyerAt(from.start)),
        "",
        place ? b.whereAt(placeLine(place)) : room ? b.joinAtNewTime(room) : b.willSendLink(store.name),
        ...(video ? [b.videoRoomNote] : []),
        "",
        b.newTimeAttached,
        again ? b.moveAgainLink(moveLink(origin, store, product.id, session), MAX_MOVES) : b.cannotMoveAgain(store.name),
        b.toCancel(store.name),
      ].join("\n"),
      replyTo: store.email,
      attachments: [{ filename: "call.ics", content: invite(buyerNote(b, store, room, place), b) }],
    });
  }

  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: hostRecipient(store, hosts),
    subject: `Moved: ${product.title}, now ${readableTime(start, setup.tz)}`,
    text: [
      `${email ?? "A buyer"} moved their booking of ${product.title}.`,
      ...(hosts.length ? [hostLine(hosts)] : []),
      "",
      `Now: ${at(start, setup.tz)}, your time zone`,
      `Was: ${at(from.start, setup.tz)}`,
      "",
      "The old time is free again for somebody else. The calendar file attached has the new time; delete the old event from your calendar if it is still there.",
      ...(place ? ["", `In person, at: ${placeLine(place)}`] : room ? ["", `${video ? "The video room" : "The meeting link"}: ${room}`, ...(video ? [VIDEO_ROOM_NOTE] : [])] : []),
      "Every booking is also in your studio, under Upcoming calls.",
    ].join("\n"),
    ...(email ? { replyTo: email } : {}),
    attachments: [{ filename: "call.ics", content: invite(place ? `With ${email ?? "your buyer"}. In person, at: ${placeLine(place)}` : `With ${email ?? "your buyer"}.${room ? ` Join: ${room}` : ""}${video ? `\n\n${VIDEO_ROOM_NOTE}` : ""}`) }],
  });
}

/** The team a booking moves with: the one saved for its call, or null for an ordinary call. */
async function teamForMove(store: Store, product: CallListing) {
  if (!store.callsId || product.call.kind !== "weekly" || product.call.seats !== 1) return null;
  const raw = (await readTeams(store)).get(product.id);
  return raw === undefined ? null : parseTeamSetup(raw, product.call);
}

/**
 * Who the creator's side of a team booking's emails goes to: the store's
 * owner when they host it, else its first host. One email either way, as for
 * every other call; the other hosts of a collective call see it on the event
 * in their Google Calendar, when they connected one, and in the studio.
 */
export function hostRecipient(store: Pick<Store, "email">, hosts: string[]): string {
  const owner = store.email.trim().toLowerCase();
  return !hosts.length || hosts.includes(owner) ? store.email : hosts[0];
}

function hostLine(hosts: string[]): string {
  return hosts.length === 1 ? `Host: ${hosts[0]}` : `Hosts: ${hosts.join(", ")}`;
}

// ---- Calendar files ------------------------------------------------------

/**
 * A calendar file for one booked call. A moved booking keeps its event id
 * and counts up `sequence`, which is how a calendar knows the new file is the
 * same event at a new time.
 */
export function callInvite(input: {
  uid: string;
  start: number;
  end: number;
  title: string;
  storeName: string;
  room: string | null;
  /** In person (lib/call-place.ts): the address is the LOCATION, and there is no link. */
  place?: CallPlace | null;
  note: string;
  sequence?: number;
  /** The buyer's file speaks the store's language (lib/buyer-words/booking.ts); the creator's, English. */
  words?: BookingWords;
}): string {
  const words = input.words ?? bookingWords("en");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Marktmorgen//Paid calls//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.uid}@marktmorgen.com`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `SEQUENCE:${input.sequence ?? 0}`,
    `DTSTART:${icsTime(input.start)}`,
    `DTEND:${icsTime(input.end)}`,
    `SUMMARY:${icsText(words.icsSummary(input.title, input.storeName))}`,
    `DESCRIPTION:${icsText(input.note)}`,
    ...(input.place ? placeIcsLines(input.place) : input.room ? [`LOCATION:${icsText(input.room)}`, `URL:${input.room}`] : []),
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(words.icsAlarm(input.title))}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * What a buyer's calendar file says about joining, in the store's language:
 * the link, and the note on a video room made here, or that the link will come.
 */
export function buyerNote(words: BookingWords, store: Store, room: string | null, place: CallPlace | null = null): string {
  if (place) return words.whereAt(placeLine(place));
  return room ? `${words.icsJoin(room)}${isVideoRoom(room) ? `\n\n${words.videoRoomNote}` : ""}` : words.icsWillSend(store.name);
}

/**
 * What the creator is told about the cancellation deadline the buyer was
 * promised, in English as every creator email is. The refund is made on the
 * store's Stripe account: by them, or by the store's owner when the email
 * goes to a host on the team.
 */
export function creatorCancelLine(cancel: CancelPromise, owner: boolean): string {
  const who = owner ? "You make a refund in your Stripe dashboard." : "A refund is made by the store's owner, in their Stripe dashboard.";
  return cancel.late
    ? `They were told this time starts within the ${cancel.hours}-hour cancellation deadline, so what they paid online does not have to be refunded if they cancel or miss it; if the store cancels, they get it all back. ${who}`
    : `They were told: cancel at least ${cancel.hours} hours before, by replying, and what they paid online is refunded; if they cancel later or miss it, it does not have to be; if the store cancels, they get it all back. ${who}`;
}

/** Where a calendar file for a booking can be fetched again, from an email. */
export function icsLink(origin: string, store: Store, session: string): string {
  return `${origin}/api/store/ics?handle=${encodeURIComponent(store.handle)}&session_id=${encodeURIComponent(session)}`;
}

// ---- Confirming a booking ------------------------------------------------

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

export function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/** The From line of an email a buyer gets about a creator's call. */
export function storeSender(store: Store): string {
  return `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`;
}

/**
 * Writes the booking down and sends the two emails, once.
 *
 * Called when the buyer comes back from paying. The session id is checked
 * against Stripe before this is reached, and the write is guarded so a page
 * refreshed ten times sends one pair of emails. The reminders a day and an
 * hour before are planned here too.
 */
export async function confirmBooking(input: {
  store: Store;
  product: CallListing;
  session: string;
  start: number;
  end: number;
  buyerEmail: string | null;
  /** The name the buyer gave Stripe, for the creator's webhooks. */
  buyerName?: string | null;
  buyerTz: string;
  /** How many times it was moved before this, when that is known. */
  moves?: number;
  /** The buyer's answers to the creator's questions, told to the creator. */
  answers?: Answer[];
  /** What was paid, in cents, for the creator's phone; left out when not known. */
  amountCents?: number | null;
  /** The currency it was paid in; the store's when not known (a store may have changed its currency since). */
  currency?: string;
  /** The affiliate a lead is credited to (metadata lead_via), and the booking's payment, which a refund is made against. */
  lead?: string;
  pi?: string;
  /**
   * What is left to pay in person and the code taken off the whole price
   * (lib/call-deposit.ts, readDue): null when nothing is; left out when not
   * read, and then read from the sale here for an in-person booking.
   */
  due?: DueInPerson | null;
  /** The cancellation deadline promised when paying, read from the sale like `due`; left out when not read. */
  cancel?: CancelPromise | null;
  origin: string;
}): Promise<void> {
  const { store, product, session, start, end, buyerEmail, origin } = input;
  if (!isRedisConfigured() || !store.callsId) return;
  // A deposit and a code are only ever in person: what is left is read from the sale when the caller did not
  // hand it, before the once-only mark, so a failed read leaves the booking for the next confirmation
  // (catchUpBookings, the daily job), which carries it, instead of sending both emails without it.
  // The deadline promised when paying is read the same way whenever it was not handed, whatever the product says now:
  // a deadline the creator turned off after the sale is still the promise the buyer paid under (lib/call-setup.ts, readCancelPromise).
  let due = input.due;
  let cancel = input.cancel;
  const needDue = due === undefined && whereOf(product.call).kind === "place";
  const needCancel = cancel === undefined;
  if (needDue || needCancel) {
    try {
      const sale = await paidCall(store, session);
      if (due === undefined) due = sale?.due ?? null;
      if (cancel === undefined) cancel = sale?.cancel ?? null;
    } catch (error) {
      console.error("reading the sale's note failed; confirmed later", error);
      return;
    }
  }
  due = due ?? null;
  cancel = cancel ?? null;
  // A team booking's hosts are read before the once-only mark too, the same way: a failed read is not known, never "no
  // team" (rule 24), which would confirm the booking without them and let their claim run out with the hold. It is
  // left for the next confirmation, and thrown rather than returned (Codex G on #3080): the mail job counts a
  // confirmation that returned and takes it off its queue, so only a throw keeps it there for the next run; the
  // thanks page and catchUpBookings catch it and try again later.
  let team: Awaited<ReturnType<typeof bookingTeam>>;
  try {
    team = await bookingTeam(store, product, session);
  } catch (error) {
    throw new Error("reading a team booking's hosts failed; confirmed later", { cause: error });
  }
  const [fresh] = await orderWrite(store, [["SET", confirmedKey(session), "1", "NX", "EX", CONFIRMED_SECONDS]]);
  if (fresh === null) return;
  // Booked: the orders it was admitted as are the window's (lib/orders.ts), once, by the checkout.
  for (let unit = 1; unit <= CALL_ORDER_UNITS; unit += 1) await countOrder(store, `call:${session}:${unit}`, input.amountCents ?? 0);
  // Booked through an affiliate's link, where the store pays per call that takes place: written down now,
  // earning only once the call's time has passed, it was not refunded and the creator approves it (lib/affiliate-leads.ts).
  if (input.lead && buyerEmail) {
    await recordLead(store, { aff: input.lead, kind: "booking", email: buyerEmail, end: Math.floor(end / 1000), ref: session, pi: input.pi ?? "", paid: input.amountCents ?? 0, title: product.title });
  }

  // A team booking keeps its hosts and the claim on their time, now for good (read above).
  const entry: Entry = { s: start, e: end, until: 0, session, p: product.id, ...(team ? { h: team.hosts, c: team.claim } : {}) };
  // Kept for good now that it is paid: written anew, so the store's room is
  // charged the whole entry (lib/order-data.ts), not only what it grew by
  // since its checkout held the time.
  await orderWrite(store, [["HDEL", busyKey(store.callsId), session], ["HSET", busyKey(store.callsId), session, JSON.stringify(entry)]]);
  if (team) {
    await confirmTeam(store, product.id, team.hosts, team.claim, start, end).catch((error) => console.error("confirming a team booking's hosts failed", error));
    // The five-minute job reads this store's refunds while it has team bookings to come, so a refund gives the hosts their time back.
    await keepMeetStore(store, end);
  }
  const hosts = team?.emails ?? [];
  // Reminders are emails too, so the demo plans none (writesAboutBookings).
  if (writesAboutBookings(store)) {
    await planReminders(store.callsId, store.handle, session, start).catch((error) =>
      console.error("planning call reminders failed", error),
    );
  }
  await emitEvent(store, "call.booked", session, {
    checkout_session: session,
    product: { id: product.id, title: product.title },
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    kind: product.call.kind === "live" ? "live_session" : product.call.seats > 1 ? "group_call" : "call",
    buyer: { email: buyerEmail, name: input.buyerName ?? null, timezone: input.buyerTz },
    answers: (input.answers ?? []).map((answer) => ({ question: answer.label, answer: answer.value })),
  }).catch((error) => console.error("queueing the call.booked webhook failed", error));
  // The creator's phone, when a device of theirs asked for bookings
  // (lib/phone-alerts.ts): what, when in their own time zone, and what was paid.
  // In the currency it was paid in: the store's own, unless the store changed its currency since.
  const paid = typeof input.amountCents === "number" && input.amountCents > 0 ? formatMoney(input.amountCents, input.currency || store.currency) : "";
  await alertCreator(
    store,
    "booking",
    {
      title: paid ? `New booking: ${paid}` : "New booking",
      body: `${product.title} · ${readableTime(start, product.call.tz)}`,
      url: store.sid ? `/studio?store=${store.sid}` : "/studio",
    },
    { seed: session },
  ).catch((error) => console.error("a booking notification failed", error));
  // A Google Meet or Zoom meeting, when the product makes them: made now, on
  // the creator's account, so both emails carry its link, and made even
  // where email is off, since the pages show it too (lib/meet-links.ts). It
  // never holds the booking up: a failure gives the fallback link.
  const meeting = await callMeeting({ store, product, session, start, end, buyerEmail, buyerName: input.buyerName, ...(hosts.length ? { team: { hosts } } : {}) }).catch((error) => {
    console.error("making a booking's meeting failed", error);
    return null;
  });
  if (!writesAboutBookings(store)) return;

  const setup = product.call;
  const buyerTz = isTimeZone(input.buyerTz) ? input.buyerTz : setup.tz;
  // Made here, the first time it is needed, when the product makes rooms.
  // In person (lib/call-place.ts): the address, and no link, not even a room kept from when it was online.
  const place = whereOf(setup).kind === "place" ? setup.place! : null;
  const room = place ? null : await roomOf(store.callsId, { product: product.id, setup, session, start, end });
  const video = isVideoRoom(room);
  const paidIn = input.currency || store.currency;
  const invite = (note: string, words?: BookingWords) =>
    Buffer.from(
      callInvite({ uid: session, start, end, title: product.title, storeName: store.name, room, place, note, sequence: (input.moves ?? 0) + (meeting?.updates ?? 0), words }),
    ).toString("base64");
  const minutes = Math.round((end - start) / 60_000);

  if (buyerEmail) {
    // The buyer's email speaks the store's language (lib/buyer-words/booking.ts).
    const b = bookingWords(store.language);
    const locale = LANGUAGES[parseLanguage(store.language)].locale;
    const hours = Math.max(setup.noticeHours, 1);
    await sendEmail({ meter: { by: "order" },
      from: storeSender(store),
      to: buyerEmail,
      subject: b.bookedSubject(product.title, store.name),
      text: [
        // In person (lib/call-place.ts): a time at the address, never "a call".
        setup.kind === "live" ? b.seatBooked(store.name) : place ? b.timeBooked(store.name) : setup.seats > 1 ? b.groupBooked(store.name) : b.callBooked(store.name),
        "",
        b.titleLength(product.title, minutes),
        `${readableTime(start, buyerTz, locale)} (${zoneName(start, buyerTz, locale)})`,
        "",
        place ? b.whereAt(placeLine(place)) : room ? b.joinAtThatTime(room) : b.willSendLink(store.name),
        // The same sentences Stripe's page showed before paying: the code, and what is left to pay in person.
        ...dueLines(b, due, { currency: paidIn, locale, storeName: store.name }),
        ...(video ? [b.videoRoomNote] : []),
        "",
        // The reminders planned above: each only while it is at least an hour away (lib/call-records.ts).
        `${b.calendarAttached}${
          start - Date.now() >= 25 * 3600_000 ? b.remindDayHour : start - Date.now() >= 2 * 3600_000 ? b.remindHour : ""
        }`,
        ...(canMove(setup, start, input.moves ?? 0) ? [b.moveYourself(hours, moveLink(origin, store, product.id, session))] : []),
        b.toCancel(store.name),
        // The creator's deadline, as Stripe's page said it; a session from a package paid nothing here.
        ...(cancel ? [cancel.late ? b.cancelTooLate(cancel.hours, store.name) : b.cancelPolicy(cancel.hours, store.name)] : []),
        "",
        `${store.name}${b.colon}${origin}/@${store.handle}`,
      ].join("\n"),
      // Replies reach the creator, which the studio tells them before they
      // offer a single call.
      replyTo: store.email,
      attachments: [{ filename: "call.ics", content: invite(buyerNote(b, store, room, place), b) }],
    });
  }

  const creatorSide = hostRecipient(store, hosts);
  const theirs = onTheirCalendar(meeting, creatorSide, store.email);
  // The reminders before the call go to the store's own address (lib/call-reminders.ts, remindCreator).
  const toOwner = creatorSide.trim().toLowerCase() === store.email.trim().toLowerCase();
  await sendEmail({ meter: { by: "order" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: creatorSide,
    subject: `New booking: ${product.title}, ${readableTime(start, setup.tz)}`,
    text: [
      `${buyerEmail ?? "A buyer"} booked ${product.title} (${minutes} minutes) ${input.amountCents === 0 ? "as one session of a package they bought from you, so nothing more was charged" : "and paid on your Stripe account"}.`,
      ...(hosts.length ? [hostLine(hosts)] : []),
      "",
      ...(input.answers?.length
        ? ["What they answered before paying:", ...input.answers.map((answer) => `${answer.label}: ${answer.value}`), ""]
        : []),
      `${readableTime(start, setup.tz)} (${zoneName(start, setup.tz)}, your time zone)`,
      "",
      place ? `In person, at: ${placeLine(place)}` : meeting ? meetingLine(meeting, setup.kind === "live" || setup.seats > 1) : room
        ? video
          ? `A private video room was made for ${setup.kind === "live" || setup.seats > 1 ? "this time" : "this booking"}, and they were given it: ${room}\n${VIDEO_ROOM_NOTE} Open it a few minutes early and sign in, so they are not left waiting.`
          : `They were given your meeting link: ${room}`
        : `You have not set a meeting link, so send them one before the call${buyerEmail ? ` at ${buyerEmail}` : ""}.`,
      ...(meeting && !meeting.made && video ? [VIDEO_ROOM_NOTE] : []),
      // What is left to collect in person, whatever the booking is now, so the creator never misses it.
      ...(due ? [creatorDueLine(due, { paidCents: input.amountCents, currency: paidIn })] : []),
      // What the buyer was told about cancelling: the refund it promises is the creator's to make.
      ...(cancel ? [creatorCancelLine(cancel, creatorSide.trim().toLowerCase() === store.email.trim().toLowerCase())] : []),
      "",
      `${
        theirs
          ? "It is already in your Google Calendar, so no calendar file is attached."
          : "The calendar file attached adds it to your calendar."
      } Every booking is also in your studio, under Upcoming calls${
        // The same reminders the buyer is told about: each only while it is still ahead, and only to the store's own address.
        !toOwner
          ? "."
          : start - Date.now() >= 25 * 3600_000
          ? ", and you get a reminder with everyone booked a day and an hour before."
          : start - Date.now() >= 2 * 3600_000
            ? ", and you get a reminder with everyone booked an hour before."
            : "."
      }`,
    ].join("\n"),
    ...(buyerEmail ? { replyTo: buyerEmail } : {}),
    // A booking already in this person's own Google Calendar is not sent to it twice.
    ...(theirs
      ? {}
      : { attachments: [{ filename: "call.ics", content: invite(place ? `With ${buyerEmail ?? "your buyer"}. In person, at: ${placeLine(place)}` : `With ${buyerEmail ?? "your buyer"}.${room ? ` Join: ${room}` : ""}${video ? `\n\n${VIDEO_ROOM_NOTE}` : ""}`) }] }),
  });
}

/**
 * The hosts of one team booking: from what was written down when its time
 * was held, or, for a buyer who paid after the hold ran out, from the
 * checkout itself. Null for an ordinary call. Read from the team as it was
 * saved, whatever the plan allows today: a paid booking is kept.
 */
async function bookingTeam(store: Store, product: CallListing, session: string): Promise<{ hosts: string[]; claim: string; emails: string[] } | null> {
  if (!store.callsId || product.call.kind !== "weekly" || product.call.seats !== 1) return null;
  const teams = await readTeams(store);
  if (!teams.has(product.id)) return null;
  const setup = parseTeamSetup(teams.get(product.id), product.call);
  const [raw] = await redisPipeline([["HGET", busyKey(store.callsId), session]]);
  let found: { hosts: string[]; claim: string } | null = null;
  try {
    found = typeof raw === "string" ? teamOf(JSON.parse(raw) as Entry) : null;
  } catch {
    found = null;
  }
  if (!found) {
    const paid = await paidCall(store, session);
    found = paid && paid.claim ? { hosts: paid.hosts, claim: paid.claim } : null;
  }
  return found ? { ...found, emails: hostEmails(setup, found.hosts) } : null;
}

/** Whether a booking's meeting is an event already in the creator's Google Calendar. */
/**
 * Whether a booking's Google event is on the calendar of the person its
 * creator-side email goes to: the store's owner when no host made it (its
 * host is ""), or the team host whose calendar it was made on. A team host
 * who is sent the email while the event sits on someone else's calendar is
 * sent the calendar file.
 */
export function onTheirCalendar(meeting: Pick<MeetRecord, "made" | "provider" | "host"> | null, to: string, ownerEmail: string): boolean {
  if (!meeting || !meeting.made || meeting.provider !== "google") return false;
  const who = (meeting.host || ownerEmail).trim().toLowerCase();
  return who === to.trim().toLowerCase();
}

/** What the creator is told about the meeting made, or not made, for a booking. */
function meetingLine(meeting: MeetRecord, group: boolean): string {
  const what = group ? "this time" : "this booking";
  if (meeting.made) {
    return meeting.provider === "google"
      ? `A Google Meet link was made for ${what} on your Google Calendar, with them on the guest list, and they were given it: ${meeting.link}`
      : `A Zoom meeting was made for ${what} on your Zoom account, and they were given its join link: ${meeting.link}\nStart it as the host from Zoom, or with Start in Zoom next to the booking in your studio.`;
  }
  const name = meeting.provider === "google" ? "Google Meet" : "Zoom";
  return [
    `The ${name} link could not be made (${meeting.error || "no answer"}), so they were given ${meeting.link ? `this link instead: ${meeting.link}` : "no link: send them one before the call"}.`,
    meeting.todo === "create"
      ? `We try again over the next several hours; if it works while there are more than two hours to go, you and they are emailed the ${name} link.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Tells the people booked into a call that its Google Meet or Zoom link was
 * made after all, replacing the link they were given when it could not be
 * (lib/call-meetings.ts, after a later try worked). The calendar file counts
 * up its sequence, so it replaces the one sent before.
 */
export async function tellNewLink(input: {
  store: Store;
  product: CallListing;
  meeting: MeetRecord;
  previous: string;
  people: PaidCall[];
  origin: string;
}): Promise<number> {
  if (!writesAboutBookings(input.store)) return 0;
  const { store, product, meeting, previous, people, origin } = input;
  const setup = product.call;
  const name = meeting.provider === "google" ? "Google Meet" : "Zoom";
  let told = 0;
  // The buyers' emails speak the store's language (lib/buyer-words/booking.ts).
  const b = bookingWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  for (const call of people) {
    if (!call.email) continue;
    const tz = isTimeZone(call.buyerTz) ? call.buyerTz : setup.tz;
    const note = b.icsJoin(meeting.link);
    const invite = Buffer.from(
      callInvite({ uid: call.session, start: call.start, end: call.end, title: product.title, storeName: store.name, room: meeting.link, note, sequence: call.moves + meeting.updates, words: b }),
    ).toString("base64");
    const sent = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: storeSender(store),
      to: call.email,
      subject: b.newLinkSubject(product.title, store.name),
      text: [
        b.newLinkHead(product.title, store.name),
        "",
        `${readableTime(call.start, tz, locale)} (${zoneName(call.start, tz, locale)})`,
        "",
        b.joinOn(name, meeting.link),
        ...(previous ? [b.oldLink(previous)] : []),
        "",
        b.replacesFile,
        `${store.name}${b.colon}${origin}/@${store.handle}`,
        b.toCancel(store.name),
      ].join("\n"),
      replyTo: store.email,
      attachments: [{ filename: "call.ics", content: invite }],
      idempotencyKey: `meet-link:${meeting.scope}:${meeting.updates}:${call.session}`.slice(0, 256),
    }).catch(() => false);
    if (sent) told += 1;
  }
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: store.email,
    subject: `${name} link made: ${product.title}, ${readableTime(meeting.start, setup.tz)}`,
    text: [
      `The ${name} link for ${product.title} could not be made when ${people.length === 1 ? "it was booked" : "it was first booked"}, and it has been made now.`,
      "",
      `${readableTime(meeting.start, setup.tz)} (${zoneName(meeting.start, setup.tz)}, your time zone)`,
      `The ${name} link: ${meeting.link}`,
      ...(previous ? [`It replaces the link they were given before: ${previous}`] : []),
      "",
      `${told} ${told === 1 ? "person was" : "people were"} emailed the new link.`,
    ].join("\n"),
    idempotencyKey: `meet-link:${meeting.scope}:${meeting.updates}:creator`.slice(0, 256),
  }).catch(() => false);
  return told;
}
