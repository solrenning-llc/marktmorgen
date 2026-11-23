/**
 * A Google Meet or Zoom meeting for a community live event, made on the
 * store's own connected account — the same machinery a call uses
 * (lib/meet-links.ts, meetingFor), with a scope of the event's own.
 *
 * The creator picks "Google Meet (automatic)" or "Zoom (automatic)" as where
 * an event happens, offered only while that account is connected and works
 * (lib/meet-connect.ts, usableProviders). Then:
 *
 *   - scheduling it makes one meeting for the event, a Google Calendar event
 *     on the creator's primary calendar with a Meet link, or a scheduled
 *     Zoom meeting;
 *   - moving it moves the meeting, keeping its link; cancelling it removes
 *     the meeting; switching to another place removes it too;
 *   - nobody is put on the meeting's guest list. A call's buyer is (their
 *     link is in their emails anyway), but an event's way in is its page
 *     alone, shown fifteen minutes before, only to members who may come,
 *     asked again on every visit (lib/community-events.ts). A guest list
 *     would put the Meet link in each member's own Google Calendar days
 *     early, keep it there after their membership lapsed, and let them
 *     straight in — and would send members' addresses to Google. So on
 *     Google Meet members ask to join and the host lets them in; on Zoom
 *     they wait until the host starts it.
 *
 * The fallback is the call's: when the meeting cannot be made — the provider
 * did not answer, the connection broke — the event uses the private video
 * room it always has (lib/community-events.ts), the problem is written down
 * for the studio, and the five-minute job tries again (lib/call-meetings.ts)
 * while the event is more than two hours away. Nobody has been given a link
 * by then: the way in is only written into the event's page from fifteen
 * minutes before the start, and emails, calendar files and the feed never
 * carry it, so a meeting made late replaces the room without anybody having
 * to be told. Nearer the start, the link people will see does not change.
 *
 * Each provider has its own scope, so a switch from one to the other never
 * writes over a removal that is still being retried:
 *
 *   e:<community id>:<event id>:g    the Google event
 *   e:<community id>:<event id>:z    the Zoom meeting
 */
import type { Store } from "@/lib/store";
import type { MeetProvider } from "@/lib/call-setup";
import { type CommunityEvent, eventAddress, eventEnd, readEvent } from "@/lib/community-events";
import { type MeetRecord, readRecord, readRecords } from "@/lib/meet-records";
import { cancelMeeting, meetingFor, moveMeeting } from "@/lib/meet-links";

const LETTER: Record<MeetProvider, string> = { google: "g", zoom: "z" };
const EVENT_SCOPE = /^e:([0-9a-f]{32}):([0-9a-f]{12}):([gz])$/;

/** The scope of an event's meeting on one provider. */
export function eventScope(communityId: string, eventId: string, provider: MeetProvider): string {
  return `e:${communityId}:${eventId}:${LETTER[provider]}`;
}

/** The community and event a scope names, when it is an event's. */
export function readEventScope(scope: string): { community: string; event: string; provider: MeetProvider } | null {
  const m = EVENT_SCOPE.exec(scope);
  if (!m) return null;
  return { community: m[1], event: m[2], provider: m[3] === "g" ? "google" : "zoom" };
}

/** Whether a scope is one of this community's events. */
export function isEventScopeOf(scope: string, communityId: string | undefined): boolean {
  const read = readEventScope(scope);
  return Boolean(read && communityId && read.community === communityId);
}

function scopeOf(store: Pick<Store, "community">, event: CommunityEvent): string | null {
  const id = store.community?.id;
  return id && event.where === "meet" && event.meet ? eventScope(id, event.id, event.meet) : null;
}

/**
 * The event's meeting, made now when it has none. Returns its record, which
 * says the link members will be given; null for an event that is not on
 * Google Meet or Zoom. Never throws for a provider's failure (meetingFor
 * falls back to the event's room and writes the problem down), but a meeting
 * record that cannot be read (one that does not read, or a database that does
 * not answer) is unknown, never "no meeting": that read's error goes to the
 * caller, which keeps the event without a meeting record (CX-123 rule 24; Codex
 * X6's LOW on #2619, #5285 row #2619; Claude 5 icEJ's LEVE on #5418). Nobody is
 * put on its guest list (see above).
 */
export async function eventMeeting(store: Store, event: CommunityEvent): Promise<MeetRecord | null> {
  const scope = scopeOf(store, event);
  if (!scope || !event.meet) return null;
  return meetingFor({
    store,
    provider: event.meet,
    scope,
    group: true,
    product: "",
    session: "",
    title: event.title,
    description: [
      `A live event in your community on your Marktmorgen store (marktmorgen.com/@${store.handle}).`,
      `Members join from its page: ${eventAddress(store, event.id)}`,
      "Who is coming is in your studio, under Community.",
    ].join("\n"),
    start: event.start,
    end: eventEnd(event),
    tz: event.tz,
    guest: null,
    fallback: async () => event.room || null,
  });
}

/**
 * After the creator saved an event: the meeting follows what changed. A new
 * place removes the old meeting; a new time moves it; choosing Google Meet
 * or Zoom makes one.
 */
export async function eventMeetingAfterEdit(store: Store, before: CommunityEvent, after: CommunityEvent): Promise<MeetRecord | null> {
  const id = store.community?.id;
  if (!id) return null;
  const was = before.where === "meet" ? before.meet : null;
  const now = after.where === "meet" ? after.meet : null;
  if (was && was !== now) await cancelMeeting(store, eventScope(id, before.id, was));
  if (!now) return null;
  if (was === now) {
    const scope = eventScope(id, after.id, now);
    const record = await readRecord(scope);
    if (record && !record.gone) {
      const moved = after.start !== before.start || after.minutes !== before.minutes || after.tz !== before.tz;
      return moved ? ((await moveMeeting(store, scope, after.start, eventEnd(after), after.tz)) ?? record) : record;
    }
  }
  return eventMeeting(store, after);
}

/** A cancelled event: its meeting is removed. */
export async function eventMeetingCancelled(store: Store, event: CommunityEvent): Promise<void> {
  const scope = scopeOf(store, event);
  if (scope) await cancelMeeting(store, scope);
}

/** The meeting records of these events, by event id, in one read: for the studio's list and the event's page. */
export async function eventMeetings(store: Pick<Store, "community">, events: CommunityEvent[]): Promise<Map<string, MeetRecord>> {
  const out = new Map<string, MeetRecord>();
  const wanted = events.flatMap((e) => {
    const scope = scopeOf(store, e);
    return scope ? [{ id: e.id, scope }] : [];
  });
  if (!wanted.length) return out;
  const records = await readRecords(wanted.map((w) => w.scope));
  wanted.forEach((w, i) => {
    const record = records[i];
    if (record) out.set(w.id, record);
  });
  return out;
}

/**
 * For the five-minute job, before it retries an event's meeting: whether the
 * event still wants it — there, not cancelled, still on that provider.
 * "retry" goes on with the try (a removal still to finish counts); "done"
 * means the meeting was just removed instead, for an event that no longer
 * wants it; "drop" means the store's community is not the one it was made
 * for, and nothing may be done with it.
 */
export async function eventStillWants(store: Store, record: MeetRecord): Promise<"retry" | "done" | "drop"> {
  const scope = readEventScope(record.scope);
  if (!scope || store.community?.id !== scope.community) return "drop";
  if (record.gone) return "retry";
  const event = await readEvent(scope.community, scope.event);
  if (event && !event.cancelled && event.where === "meet" && event.meet === scope.provider) return "retry";
  await cancelMeeting(store, record.scope);
  return "done";
}
