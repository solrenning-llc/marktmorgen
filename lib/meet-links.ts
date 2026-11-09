/**
 * A Google Meet or Zoom meeting for each booking, made on the creator's own
 * account, and kept in step when the booking moves or is refunded.
 *
 * The creator connects Google Calendar or Zoom in the studio
 * (lib/meet-connect.ts) and picks it as where a call happens
 * (CallSetup.meet). From then on:
 *
 *   - a one-to-one call gets its own meeting when it is confirmed: a Google
 *     Calendar event on the creator's primary calendar with a Meet link and
 *     the buyer on the guest list, or a scheduled Zoom meeting;
 *   - a group call or a dated session gets one meeting per time, made when
 *     its first seat is confirmed; on Google every buyer after that is added
 *     to the same event's guest list (up to MAX_GUESTS; the rest join by the
 *     link like anybody else), and buyers never see each other's addresses;
 *   - a one-to-one booking its buyer moves has its event or meeting moved
 *     to the new time, keeping its link; a seat moved to another time of a
 *     group leaves the old time's guest list and joins the new time's;
 *   - a booking refunded in full has its one-to-one event or meeting
 *     deleted, or its buyer taken off the group's guest list
 *     (lib/call-meetings.ts reads the refunds).
 *
 * Google is told to email nobody (sendUpdates=none): the buyer's
 * confirmation, reminders and calendar files come from us, as for every
 * other call, with the Meet or Zoom link in them, so nobody gets the same
 * news twice.
 *
 * A failure never holds a booking up. When the meeting cannot be made — the
 * provider did not answer, the connection was withdrawn, the account has
 * Meet switched off — the booking is given what the call falls back to (the
 * creator's own link, or a private video room when they have none,
 * lib/call-rooms.ts), the problem is written down for the studio, and the
 * five-minute job tries again after 5, 15, 60, 180 and 720 minutes. If a
 * try succeeds more than SWITCH_BEFORE_MS before the call, the people booked
 * are emailed the new link (at most MAX_TELL of them; a bigger group keeps
 * the link it has); closer to the call, nobody's link changes. A move or a
 * removal that fails is retried the same way.
 *
 * `meetingFor` is the one function anything else that needs a meeting —
 * a community event, later — calls, with a scope of its own.
 */
import { whereOf } from "@/lib/call-place";
import { type MeetProvider, type CallSetup, isGroup } from "@/lib/call-setup";
import {
  type MeetRecord,
  MEET_QUEUE,
  callScope,
  readRecord,
  readRecords,
  recordKey,
  writeRecord,
} from "@/lib/meet-records";
import { ACCOUNT_NAMES, NotConnected, accessFor, logProblem } from "@/lib/meet-connect";
import {
  ProviderError,
  eventId,
  lockWait,
  googleCreate,
  googleDelete,
  googleGuests,
  googleMove,
  zoomCreate,
  zoomDelete,
  zoomMove,
  zoomStartUrl,
} from "@/lib/meet-providers";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { noticeCreator } from "@/lib/account-notice";
import { roomOf } from "@/lib/call-rooms";
import type { Store } from "@/lib/store";
import { hostWriteTarget } from "@/lib/host-calendar";

/** Minutes between the tries after a failure; one more try than there are gaps is the first. */
export const RETRY_MINUTES = [5, 15, 60, 180, 720];
export const MAX_TRIES = RETRY_MINUTES.length + 1;
/** A meeting made later than this before the call does not replace the link people were given. */
export const SWITCH_BEFORE_MS = 2 * 3600_000;
/** People emailed a new link after a late success, at most; a bigger group keeps its link. */
export const MAX_TELL = 20;
/** Buyers put on one Google event's guest list, at most. */
export const MAX_GUESTS = 200;

/** Stores with meetings still to come, for the job that reads their refunds: "<callsId>|<handle>", by the last call's end. */
export const MEET_STORES = "nl:meet:stores";

/**
 * A store with a call ending at `end` (ms) is kept in MEET_STORES at least until then: ZADD GT, so a booking with an
 * earlier end never lowers the store's place below a later meeting's (the five-minute job takes a store whose last
 * meeting ended a day ago off the list, and its refunds are read no more). One command; a failure is only logged.
 */
export async function keepMeetStore(store: Pick<Store, "callsId" | "handle">, end: number): Promise<void> {
  if (!store.callsId) return;
  await redisPipeline([["ZADD", MEET_STORES, "GT", end, `${store.callsId}|${store.handle}`]]).catch((error: unknown) => {
    console.error("keeping a store among those with meetings to come failed", error);
  });
}

const lockKey = (scope: string) => `nl:meet:lock:${scope}`;

type StoreRef = Pick<Store, "statsId" | "handle" | "callsId" | "email">;

/** A problem, in words a creator can act on. */
export function problemWords(error: unknown, provider: MeetProvider): string {
  const name = ACCOUNT_NAMES[provider];
  if (error instanceof NotConnected) return error.message;
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case "auth":
        return `${name} needs connecting again`;
      case "scope":
        return `${name} did not give us permission for this; connect it again and allow everything asked`;
      case "limit":
        return `${name} asked us to slow down`;
      case "server":
      case "network":
        return `${name} did not answer`;
      case "gone":
        return `the ${provider === "google" ? "event is no longer in the calendar" : "meeting is no longer in Zoom"}`;
      default:
        return error.message.slice(0, 200);
    }
  }
  return "something went wrong on our side";
}

function brokenHook(store: StoreRef) {
  return async (provider: MeetProvider) => {
    await noticeCreator(store, { kind: "meeting-broken", name: ACCOUNT_NAMES[provider] });
  };
}

function nextTry(record: MeetRecord, now: number): MeetRecord {
  const tries = record.tries + 1;
  if (tries >= MAX_TRIES) return { ...record, tries, next: 0, todo: "", error: `${record.error} (gave up after ${tries} tries)`.slice(0, 300) };
  return { ...record, tries, next: now + RETRY_MINUTES[Math.max(0, tries - 1)] * 60_000 };
}

export type MeetingAsk = {
  store: StoreRef;
  provider: MeetProvider;
  scope: string;
  group: boolean;
  /** For calls: the product, and the checkout session of a one-to-one call. */
  product: string;
  session: string;
  title: string;
  description: string;
  start: number;
  end: number;
  /** The creator's time zone, for how the event reads in their calendar. */
  tz: string;
  /** Who to put on the guest list (Google), when anybody. */
  guest: string | null;
  /** What people get when the meeting cannot be made. */
  fallback: () => Promise<string | null>;
  /** A team booking: the host whose own Google Calendar it goes on, and which of their calendars. */
  host?: string;
  calendar?: string;
  /** Other people on the guest list from the start: a collective call's other hosts. */
  alsoInvite?: string[];
};

async function create(
  ask: Pick<MeetingAsk, "store" | "provider" | "title" | "description" | "start" | "end" | "tz" | "group" | "scope"> & { host?: string; calendar?: string },
  guests: string[],
) {
  const access = await accessFor(ask.store.statsId as string, ask.provider, brokenHook(ask.store), ask.host ?? "");
  const spec = {
    eventId: eventId(ask.scope),
    title: ask.title,
    description: ask.description,
    start: ask.start,
    end: ask.end,
    tz: ask.tz,
    guests: guests.slice(0, MAX_GUESTS),
    group: ask.group,
  };
  const made = ask.provider === "google" ? await googleCreate(access.token, spec, ask.calendar || "primary") : await zoomCreate(access.token, spec);
  return { ...made, account: access.account, added: ask.provider === "google" ? spec.guests : [] };
}

/**
 * The meeting for a scope: made now when there is none, found when there
 * is, with `guest` on its guest list. Never throws: whatever happens, the
 * record says which link to give, and it is written down.
 */
export async function meetingFor(ask: MeetingAsk): Promise<MeetRecord> {
  const guest = ask.guest ? ask.guest.trim().toLowerCase() : null;
  const work = async (): Promise<MeetRecord> => {
    const now = Date.now();
    const found = await readRecord(ask.scope);
    if (found && !found.gone) {
      if (!guest || found.guests.includes(guest) || ask.provider !== "google" || found.provider !== "google") return found;
      const guests = [...found.guests, guest].slice(0, MAX_GUESTS);
      let record: MeetRecord = { ...found, guests };
      if (found.made && found.todo === "") {
        try {
          const access = await accessFor(ask.store.statsId as string, "google", brokenHook(ask.store), found.host);
          if (access.account !== found.account) throw new NotConnected("the event was made on another Google account");
          await googleGuests(access.token, found.id, guests, found.added, found.calendar || "primary");
          record = { ...record, added: guests };
        } catch (error) {
          const words = problemWords(error, "google");
          await logProblem(ask.store.statsId as string, "google", `Adding a buyer to "${ask.title}"`, words);
          record = { ...record, todo: "guests", tries: 0, error: words, next: now };
          record = nextTry(record, now);
        }
      }
      // Otherwise something is already waiting to be done, and the guest list goes with it.
      await writeRecord(record);
      return record;
    }
    const base: MeetRecord = {
      provider: ask.provider,
      scope: ask.scope,
      statsId: ask.store.statsId ?? "",
      handle: ask.store.handle,
      callsId: ask.store.callsId ?? "",
      product: ask.product,
      session: ask.session,
      group: ask.group,
      id: "",
      account: "",
      link: "",
      made: false,
      start: ask.start,
      end: ask.end,
      tz: ask.tz,
      title: ask.title.slice(0, 300),
      guests: [...new Set([...(guest ? [guest] : []), ...(ask.alsoInvite ?? []).map((g) => g.trim().toLowerCase())])].slice(0, MAX_GUESTS),
      added: [],
      todo: "",
      tries: 0,
      next: 0,
      error: "",
      updates: 0,
      gone: false,
      host: ask.host ?? "",
      calendar: ask.calendar ?? "",
    };
    let record: MeetRecord;
    try {
      const made = await create(ask, base.guests);
      record = { ...base, id: made.id, link: made.link, made: true, account: made.account, added: made.added };
    } catch (error) {
      const words = problemWords(error, ask.provider);
      await logProblem(base.statsId, ask.provider, `Making the ${ask.provider === "google" ? "Google Meet" : "Zoom"} link for "${ask.title}"`, words);
      const fallback = (await ask.fallback().catch(() => null)) ?? "";
      record = { ...base, link: fallback, error: words };
      // Worth trying again only while a new link would still reach people in time.
      if (ask.start - now > SWITCH_BEFORE_MS) record = nextTry({ ...record, todo: "create" }, now);
    }
    await writeRecord(record);
    return record;
  };
  if (!isRedisConfigured() || !ask.store.statsId) {
    return { ...emptyRecord(ask), link: (await ask.fallback().catch(() => null)) ?? "" };
  }
  try {
    return await withLock(lockKey(ask.scope), 45, lockWait(15_000), work);
  } catch (error) {
    if (!(error instanceof LockBusyError)) console.error("arranging a meeting failed", error);
    // Whatever is there is the link; failing that, the fallback, unrecorded.
    const there = await readRecord(ask.scope).catch(() => null);
    return there ?? { ...emptyRecord(ask), link: (await ask.fallback().catch(() => null)) ?? "" };
  }
}

function emptyRecord(ask: MeetingAsk): MeetRecord {
  return {
    provider: ask.provider,
    scope: ask.scope,
    statsId: ask.store.statsId ?? "",
    handle: ask.store.handle,
    callsId: ask.store.callsId ?? "",
    product: ask.product,
    session: ask.session,
    group: ask.group,
    id: "",
    account: "",
    link: "",
    made: false,
    start: ask.start,
    end: ask.end,
    tz: ask.tz,
    title: ask.title,
    guests: [],
    added: [],
    todo: "",
    tries: 0,
    next: 0,
    error: "",
    updates: 0,
    gone: false,
    host: ask.host ?? "",
    calendar: ask.calendar ?? "",
  };
}

/** Runs `change` on a scope's record under its lock, and writes what it returns. */
async function onRecord(scope: string, change: (record: MeetRecord) => Promise<MeetRecord | null>): Promise<MeetRecord | null> {
  if (!isRedisConfigured()) return null;
  return withLock(lockKey(scope), 45, lockWait(15_000), async () => {
    const record = await readRecord(scope);
    if (!record) return null;
    const next = await change(record);
    if (next) await writeRecord(next);
    return next ?? record;
  });
}

/** What to do for a record, against the provider. Throws what the provider throws. */
async function perform(record: MeetRecord, store: StoreRef): Promise<MeetRecord> {
  const access = await accessFor(record.statsId, record.provider, brokenHook(store), record.host);
  const calendar = record.calendar || "primary";
  if (record.id && record.account && access.account !== record.account) {
    throw new NotConnected(`it was made on another ${ACCOUNT_NAMES[record.provider]} account, which is no longer connected`);
  }
  const when = { start: record.start, end: record.end, tz: record.tz };
  switch (record.todo) {
    case "patch":
      if (record.provider === "google") await googleMove(access.token, record.id, when, calendar);
      else await zoomMove(access.token, record.id, when);
      return { ...record, todo: "", tries: 0, next: 0, error: "" };
    case "delete":
      if (record.provider === "google") await googleDelete(access.token, record.id, calendar);
      else await zoomDelete(access.token, record.id);
      return { ...record, todo: "", tries: 0, next: 0, error: "" };
    case "guests":
      if (record.provider === "google") await googleGuests(access.token, record.id, record.guests, record.added, calendar);
      return { ...record, todo: "", tries: 0, next: 0, error: "", added: record.guests };
    default:
      return record;
  }
}

/**
 * A booking moved to a new time, keeping its meeting: the event or meeting
 * is moved too. Nothing to do when it never had one.
 */
export async function moveMeeting(store: StoreRef, scope: string, start: number, end: number, tz: string): Promise<MeetRecord | null> {
  return onRecord(scope, async (record) => {
    if (record.gone) return null;
    const moved: MeetRecord = { ...record, start, end, tz };
    // Not made yet: a later try makes it at the new time.
    if (!record.made) return moved;
    try {
      const access = await accessFor(record.statsId, record.provider, brokenHook(store), record.host);
      if (access.account !== record.account) throw new NotConnected(`it was made on another ${ACCOUNT_NAMES[record.provider]} account`);
      if (record.provider === "google") await googleMove(access.token, record.id, { start, end, tz }, record.calendar || "primary");
      else await zoomMove(access.token, record.id, { start, end, tz });
      return { ...moved, todo: record.todo === "patch" ? "" : record.todo, error: record.todo === "patch" ? "" : record.error };
    } catch (error) {
      const words = problemWords(error, record.provider);
      await logProblem(record.statsId, record.provider, `Moving "${record.title}" to its new time`, words);
      return nextTry({ ...moved, todo: "patch", tries: 0, error: words }, Date.now());
    }
  }).catch((error) => {
    console.error("moving a meeting failed", error);
    return null;
  });
}

/** A buyer no longer in a group's time (moved away, or refunded): taken off the guest list. */
export async function leaveMeeting(store: StoreRef, scope: string, guest: string | null): Promise<MeetRecord | null> {
  if (!guest) return null;
  const who = guest.trim().toLowerCase();
  return onRecord(scope, async (record) => {
    if (record.gone || !record.guests.includes(who)) return null;
    const guests = record.guests.filter((g) => g !== who);
    const left: MeetRecord = { ...record, guests };
    if (record.provider !== "google" || !record.made || !record.added.includes(who)) return left;
    try {
      const access = await accessFor(record.statsId, "google", brokenHook(store), record.host);
      if (access.account !== record.account) throw new NotConnected("it was made on another Google account");
      await googleGuests(access.token, record.id, guests, record.added, record.calendar || "primary");
      return { ...left, added: guests };
    } catch (error) {
      const words = problemWords(error, "google");
      await logProblem(record.statsId, "google", `Taking a buyer off "${record.title}"`, words);
      return nextTry({ ...left, todo: record.todo === "" ? "guests" : record.todo, tries: 0, error: words }, Date.now());
    }
  }).catch((error) => {
    console.error("taking a guest off a meeting failed", error);
    return null;
  });
}

/** A one-to-one booking refunded in full: its event or meeting is removed. */
export async function cancelMeeting(store: StoreRef, scope: string): Promise<MeetRecord | null> {
  return onRecord(scope, async (record) => {
    if (record.gone) return null;
    const gone: MeetRecord = { ...record, gone: true };
    if (!record.made) return { ...gone, todo: "", next: 0 };
    try {
      const access = await accessFor(record.statsId, record.provider, brokenHook(store), record.host);
      if (access.account !== record.account) throw new NotConnected(`it was made on another ${ACCOUNT_NAMES[record.provider]} account`);
      if (record.provider === "google") await googleDelete(access.token, record.id, record.calendar || "primary");
      else await zoomDelete(access.token, record.id);
      return { ...gone, todo: "", tries: 0, next: 0, error: "" };
    } catch (error) {
      const words = problemWords(error, record.provider);
      await logProblem(record.statsId, record.provider, `Removing "${record.title}" after a refund`, words);
      return nextTry({ ...gone, todo: "delete", tries: 0, error: words }, Date.now());
    }
  }).catch((error) => {
    console.error("removing a meeting failed", error);
    return null;
  });
}

export type RetryOutcome =
  | { kind: "done" | "failed" | "skipped"; record: MeetRecord }
  /** A meeting that had failed was made: the people booked have to be told its link. */
  | { kind: "switched"; record: MeetRecord; previous: string };

/**
 * One try of what a record still has to do, for the five-minute job.
 * `booked` counts the people who were given its link, for a late switch.
 */
export async function retryRecord(store: StoreRef, scope: string, booked: () => Promise<number>): Promise<RetryOutcome | null> {
  let outcome: RetryOutcome | null = null;
  await onRecord(scope, async (record) => {
    const now = Date.now();
    if (!record.todo || record.next > now) {
      outcome = { kind: "skipped", record };
      return null;
    }
    if (record.todo === "create") {
      if (record.gone) {
        outcome = { kind: "done", record };
        return { ...record, todo: "", next: 0 };
      }
      const people = await booked();
      if (record.start - now < SWITCH_BEFORE_MS || people > MAX_TELL) {
        const why = people > MAX_TELL ? `${people} people already have the other link` : "it is too close to the call to change the link";
        const gaveUp = { ...record, todo: "" as const, next: 0, error: `${record.error}; not tried again: ${why}`.slice(0, 300) };
        outcome = { kind: "failed", record: gaveUp };
        return gaveUp;
      }
      try {
        const made = await create({ ...record, store, description: descriptionFor(record) }, record.guests);
        const switched: MeetRecord = {
          ...record,
          id: made.id,
          account: made.account,
          added: made.added,
          made: true,
          link: made.link,
          todo: "",
          tries: 0,
          next: 0,
          error: "",
          updates: record.updates + 1,
        };
        outcome = { kind: "switched", record: switched, previous: record.link };
        return switched;
      } catch (error) {
        const words = problemWords(error, record.provider);
        const failed = nextTry({ ...record, error: words }, now);
        outcome = { kind: "failed", record: failed };
        return failed;
      }
    }
    try {
      const done = await perform(record, store);
      outcome = { kind: "done", record: done };
      return done;
    } catch (error) {
      // Gone already on their side: nothing left to move or remove.
      if (error instanceof ProviderError && error.kind === "gone") {
        const done = { ...record, todo: "" as const, next: 0, error: problemWords(error, record.provider) };
        outcome = { kind: "done", record: done };
        return done;
      }
      const failed = nextTry({ ...record, error: problemWords(error, record.provider) }, now);
      outcome = { kind: "failed", record: failed };
      return failed;
    }
  });
  return outcome;
}

function descriptionFor(record: MeetRecord): string {
  return record.group
    ? "Booked through your Marktmorgen store. Everyone booked is in your studio, under Upcoming calls."
    : "Booked through your Marktmorgen store. The booking is in your studio, under Upcoming calls.";
}

/** Records with something due, oldest first, for the five-minute job. */
export async function dueScopes(limit: number, now = Date.now()): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", MEET_QUEUE, 0, now, "LIMIT", 0, limit]]);
  return Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
}

/** Drops a scope from the queue whose record is gone. */
export async function dropScope(scope: string): Promise<void> {
  await redisPipeline([["ZREM", MEET_QUEUE, scope]]);
}

// ---- Calls -------------------------------------------------------------------------

type CallProduct = { id: string; title: string; call: CallSetup };

/**
 * The meeting of a confirmed booking, made when its product is set to make
 * them: returns the link the buyer is given, or null when the product does
 * not make meetings (the caller then uses lib/call-rooms.ts as always).
 */
export async function callMeeting(input: {
  store: Store;
  product: CallProduct;
  session: string;
  start: number;
  end: number;
  buyerEmail: string | null;
  buyerName?: string | null;
  /**
   * A team booking's hosts, by address, the first being the one it is
   * written for: when that host connected their own Google Calendar for it
   * (lib/host-calendar.ts), the event and its Meet link are made on their
   * chosen calendar, with the other hosts of a collective call as guests.
   * A call set to Zoom keeps making its Zoom meeting on the store's account.
   */
  team?: { hosts: string[] };
}): Promise<MeetRecord | null> {
  const { store, product, session, start, end } = input;
  const setup = product.call;
  if (!store.callsId) return null;
  // In person (lib/call-place.ts): no meeting, not even on a team host's own calendar.
  if (whereOf(setup).kind === "place") return null;
  const organizer = input.team?.hosts[0];
  const target = organizer && setup.meet !== "zoom" ? await hostWriteTarget(store, organizer).catch(() => null) : null;
  const provider = target ? "google" : setup.meet;
  if (!provider) return null;
  const group = isGroup(setup);
  const scope = callScope(store.callsId, { group, session, product: product.id, start });
  const who = input.buyerName || input.buyerEmail || "a buyer";
  const record = await meetingFor({
    store,
    provider,
    ...(target ? { host: target.host, calendar: target.calendar, alsoInvite: (input.team?.hosts ?? []).slice(1) } : {}),
    scope,
    group,
    product: product.id,
    session: group ? "" : session,
    title: group ? product.title : `${product.title} with ${who}`,
    description: [
      `Booked through your Marktmorgen store (marktmorgen.com/@${store.handle}).`,
      ...(group ? ["Everyone booked is in your studio, under Upcoming calls."] : [`Booked by ${input.buyerEmail ?? "a buyer who gave no address"}.`]),
    ].join("\n"),
    start,
    end,
    tz: setup.tz,
    guest: input.buyerEmail,
    // What the call falls back to: roomOf gives the creator's own link, or a
    // private room, for a product that makes meetings and has no record yet.
    fallback: () => roomOf(store.callsId, { product: product.id, setup, session, start, end }),
  });
  await keepMeetStore(store, end);
  return record;
}

/**
 * A booking its buyer moved: a one-to-one call's meeting moves with it; a
 * seat of a group leaves the old time's guest list and joins the new time's
 * meeting, made now if it has none.
 */
export async function callMoved(input: {
  store: Store;
  product: CallProduct;
  session: string;
  from: { start: number; end: number };
  start: number;
  end: number;
  email: string | null;
}): Promise<void> {
  const { store, product, session } = input;
  if (!store.callsId) return;
  const setup = product.call;
  const one = callScope(store.callsId, { group: false, session, product: product.id, start: input.from.start });
  const [own] = await readRecords([one]);
  if (own) {
    await moveMeeting(store, one, input.start, input.end, setup.tz);
    return;
  }
  if (!isGroup(setup)) {
    // A booking made before meetings were switched on keeps what it had.
    return;
  }
  await leaveMeeting(store, callScope(store.callsId, { group: true, session, product: product.id, start: input.from.start }), input.email);
  if (setup.meet) {
    await callMeeting({ store, product, session, start: input.start, end: input.end, buyerEmail: input.email });
  }
}

/** A booking refunded in full: its own meeting is removed, or its buyer leaves the group's. */
export async function callRefunded(
  store: StoreRef,
  booking: { session: string; product: string; start: number; email: string | null },
): Promise<boolean> {
  if (!store.callsId) return false;
  const one = callScope(store.callsId, { group: false, session: booking.session, product: booking.product, start: booking.start });
  const group = callScope(store.callsId, { group: true, session: booking.session, product: booking.product, start: booking.start });
  const [own, shared] = await readRecords([one, group]);
  if (own && !own.gone) return (await cancelMeeting(store, one)) !== null;
  if (shared && booking.email) return (await leaveMeeting(store, group, booking.email)) !== null;
  return false;
}

/** How many times the link of a booking was replaced after a failure, for its calendar file's sequence. */
export async function linkUpdates(callsId: string | null, booking: { session: string; product: string; start: number }): Promise<number> {
  if (!callsId || !isRedisConfigured()) return 0;
  const [own, shared] = await readRecords([
    callScope(callsId, { group: false, ...booking }),
    callScope(callsId, { group: true, ...booking }),
  ]).catch(() => [null, null]);
  return (own ?? shared)?.updates ?? 0;
}

/** Each booked time's meeting record, by "<product>|<start>", for the studio's list of upcoming calls. */
export async function slotMeetings(
  callsId: string | null,
  slots: { key: string; product: string; start: number; session: string | null }[],
): Promise<Map<string, MeetRecord>> {
  const out = new Map<string, MeetRecord>();
  if (!callsId || !slots.length || !isRedisConfigured()) return out;
  const scopes = slots.flatMap((s) => [
    s.session ? callScope(callsId, { group: false, session: s.session, product: s.product, start: s.start }) : "",
    callScope(callsId, { group: true, session: "", product: s.product, start: s.start }),
  ]);
  const records = await readRecords(scopes.map((s) => s || "x:none"));
  slots.forEach((s, i) => {
    const record = (scopes[i * 2] ? records[i * 2] : null) ?? records[i * 2 + 1];
    if (record) out.set(s.key, record);
  });
  return out;
}

/** A fresh host link for a Zoom meeting, for the creator in the studio only. */
export async function hostLink(store: StoreRef, scope: string): Promise<string | null> {
  const record = await readRecord(scope);
  if (!record || record.provider !== "zoom" || !record.made || record.gone || record.statsId !== store.statsId) return null;
  const access = await accessFor(record.statsId, "zoom", brokenHook(store));
  if (access.account !== record.account) return null;
  return zoomStartUrl(access.token, record.id);
}

export { recordKey };
