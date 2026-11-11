/**
 * "Your sessions" in the buyer area: 34 [F3] (individual mentoring portal),
 * unit 2. What one client sees of their own bookings with a store, and of
 * what the creator shared with them, read for the page at
 * app/[handle]/orders/sessions/page.tsx.
 *
 * The opening is the purchases page's own (lib/buyer-orders.ts, openOrders):
 * the buyer's emailed link, ORDERS_OPEN_UNITS of the store's buyer requests
 * taken before anything is read, and the bookings read through that
 * opening's meter, their moves taken before they are read, exactly as the
 * purchases page reads its booked calls (callsFor), inside the same time
 * (withinOpening). It reads less than an opening of the purchases page does:
 * no purchases, listings, rooms, feeds or keys.
 *
 * Who sees what is lib/client-shared.ts (unit 1): only the client's own
 * bookings, and a note or task only when the creator marked it shared in so
 * many words and it belongs to one of those bookings.
 *
 * Rule 24: a link that cannot be used, a store with no room and a reading
 * that failed, ran late or answered in a shape it should not are each a state
 * of their own, never an empty list.
 */
import { type OrdersMeter, MAX_LISTED, OrdersBusy, openOrders, withinOpening } from "@/lib/buyer-orders";
import { ORDERS_CALL_MOVES, ORDERS_READ_MS, ordersMovesCommands } from "@/lib/buyer-orders-rules";
import { type PaidCall, paidCallsRead } from "@/lib/calls";
import { type ClientCall, type ClientNote, type ClientTask, type ShareableNote, type ShareableTask, sharedWithClient } from "@/lib/client-shared";
import type { Store } from "@/lib/store";

/** Sessions to come shown at the most: as many as the purchases page lists. */
export const SESSIONS_UPCOMING_MOST = MAX_LISTED;
/** Past sessions shown at the most, newest first; the page says how many more there are. */
export const SESSIONS_PAST_MOST = 20;

/** A session as the page shows it: what lib/client-shared.ts lets out, and the zone the client booked in. */
export type SessionCall = ClientCall & { tz: string };

export type ClientSessions =
  | {
      state: "shown";
      upcoming: SessionCall[];
      past: SessionCall[];
      /** Sessions to come, and past ones, left out by the caps. */
      upcomingMore: number;
      pastMore: number;
      /** The reading of the store's bookings stopped while Stripe still had older ones. */
      partial: boolean;
      notes: ClientNote[];
      tasks: ClientTask[];
    }
  /** expired: the link is not one, or no longer works; busy: the store has no room; unreadable: a read failed, ran late or was not understood. */
  | { state: "expired" | "busy" | "unreadable" };

/** The two reads the page makes, so a test can answer them. */
export type SessionsReads = {
  open: (store: Store, token: string) => Promise<{ admitted: boolean; email: string | null; meter: OrdersMeter }>;
  read: (store: Store, meter: OrdersMeter) => Promise<unknown>;
  /** How long the reading may run; ORDERS_READ_MS unless a test says less. */
  ms?: number;
};

const LIVE: SessionsReads = {
  open: (store, token) => openOrders(store, token),
  read: (store, meter) => meter.takeFor(ORDERS_CALL_MOVES, () => paidCallsRead(store), (read) => ordersMovesCommands(read.paid.length)),
};

/**
 * No note or task carries a share mark yet: notes and tasks are kept today
 * without one (lib/client-shared.ts, rule 1), so none of them can be shown.
 * Reading them would spend the store's requests on items that cannot show;
 * the unit of 34 [F3] that adds the creator's "shared with client" switch
 * adds their read here, with its cost.
 */
const NONE_MARKED_NOTES: readonly ShareableNote[] = [];
const NONE_MARKED_TASKS: readonly ShareableTask[] = [];

/** A zone the client booked in, when it is one this server can show times in; UTC otherwise, said on the page. */
function zone(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

/** The bookings' reading in the shape paidCallsRead answers, or null when it is anything else. */
function readingOf(raw: unknown): { paid: PaidCall[]; partial: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const { paid, partial } = raw as Record<string, unknown>;
  if (!Array.isArray(paid) || typeof partial !== "boolean") return null;
  return { paid: paid as PaidCall[], partial };
}

const trouble = (error: unknown): ClientSessions => ({ state: error instanceof OrdersBusy ? "busy" : "unreadable" });

/** What the client with this link sees of their sessions with this store. */
export async function clientSessions(store: Store, token: string, reads: SessionsReads = LIVE, now = Date.now()): Promise<ClientSessions> {
  let opened: Awaited<ReturnType<SessionsReads["open"]>>;
  try {
    opened = await reads.open(store, token);
  } catch (error) {
    return trouble(error);
  }
  if (!opened.admitted) return { state: "busy" };
  if (!opened.email) return { state: "expired" };

  // Disconnecting Stripe does not prove the buyer never booked: history is unavailable.
  if (!store.stripeAccountId) return { state: "unreadable" };
  let raw: unknown;
  try {
    const outcome = await withinOpening(reads.read(store, opened.meter), opened.meter, reads.ms ?? ORDERS_READ_MS);
    if (outcome === "late") return { state: "unreadable" };
    raw = outcome;
  } catch (error) {
    return trouble(error);
  }
  const reading = readingOf(raw);
  if (!reading) return { state: "unreadable" };

  const shared = sharedWithClient({ client: opened.email, calls: reading.paid, notes: NONE_MARKED_NOTES, tasks: NONE_MARKED_TASKS });
  if (!shared.ok) return { state: "unreadable" };

  // The zone of each of the client's own bookings, read from the booking itself once lib/client-shared.ts has said it is theirs.
  const zones = new Map<string, string>();
  for (const call of reading.paid) if (!zones.has(call.session)) zones.set(call.session, zone(call.buyerTz));
  const withZone = (call: ClientCall): SessionCall => ({ ...call, tz: zones.get(call.session) ?? "UTC" });

  const upcoming = shared.calls.filter((call) => call.end > now).map(withZone);
  const past = shared.calls.filter((call) => call.end <= now).reverse().map(withZone);
  const shownUp = upcoming.slice(0, SESSIONS_UPCOMING_MOST);
  const shownPast = past.slice(0, SESSIONS_PAST_MOST);
  const shown = new Set([...shownUp, ...shownPast].map((call) => call.session));
  return {
    state: "shown",
    upcoming: shownUp,
    past: shownPast,
    upcomingMore: upcoming.length - shownUp.length,
    pastMore: past.length - shownPast.length,
    partial: reading.partial,
    notes: shared.notes.filter((note) => shown.has(note.session)),
    tasks: shared.tasks.filter((task) => shown.has(task.session)),
  };
}
