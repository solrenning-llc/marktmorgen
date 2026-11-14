import Link from "next/link";
import type { Store } from "@/lib/store";
import { type CommunityEvent, eventTimeIn, isOver, joinWindow, lengthIn } from "@/lib/community-events";

export { eventTimeIn, lengthIn };
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "Starts in 3 days", "On now", "Ended", "Canceled", in the store's language. */
export function eventWhenIn(store: Pick<Store, "language">, event: CommunityEvent, now = Date.now()): string {
  const w = communityWords(store.language);
  if (event.cancelled) return w.canceled;
  if (isOver(event, now)) return w.ended;
  if (event.start <= now) return w.onNow;
  const ms = event.start - now;
  if (ms < HOUR) return w.startsInMinutes(Math.max(1, Math.round(ms / 60_000)));
  if (ms < DAY) return w.startsInHours(Math.round(ms / HOUR));
  return w.startsInDays(Math.round(ms / DAY));
}

/**
 * The pieces the community's events pages are made of: the date on its
 * little calendar leaf, and one event in a list. What the creator wrote
 * reaches the page as text through React, which escapes it.
 */

/** The month and the day, on a leaf, in the event's own time zone. */
export function DateLeaf({ event, size = "md", locale = "en-US" }: { event: Pick<CommunityEvent, "start" | "tz" | "cancelled">; size?: "md" | "lg"; locale?: string }) {
  const month = new Intl.DateTimeFormat(locale, { timeZone: event.tz, month: "short" }).format(new Date(event.start));
  const day = new Intl.DateTimeFormat(locale, { timeZone: event.tz, day: "numeric" }).format(new Date(event.start));
  return (
    <span aria-hidden="true" className={`ev-leaf ${size === "lg" ? "ev-leaf-lg" : ""} ${event.cancelled ? "ev-leaf-off" : ""}`}>
      <span className="ev-leaf-month">{month}</span>
      <span className="ev-leaf-day">{day}</span>
    </span>
  );
}

/** How many are coming, and how many places are left, in a few words; a count that could not be read is said so. */
export function placesWords(store: Pick<Store, "language">, event: CommunityEvent, going: number | null): string {
  const w = communityWords(store.language);
  if (going === null) return w.countUnchecked;
  const people = w.goingCount(going);
  if (!event.cap) return people;
  const left = Math.max(0, event.cap - going);
  return left === 0 ? `${people} · ${w.full}` : `${people} · ${w.placesLeft(left, event.cap)}`;
}

/** One event in a list: its date, title, time, and what the reader's part in it is. */
export function EventCard({
  store,
  event,
  going,
  mine,
  locked,
  now,
}: {
  store: Store;
  event: CommunityEvent;
  /** Null when it could not be read (lib/community-events.ts rsvpNumbers). */
  going: number | null;
  /** Null when it could not be read: never shown as going or not going. */
  mine: boolean | null;
  /** Kept for the buyers of products this reader does not have. */
  locked: boolean;
  /** When the page is drawn (eventClock). */
  now: number;
}) {
  const href = `/@${store.handle}/community/events/${event.id}`;
  const over = isOver(event, now);
  const live = !event.cancelled && !over && event.start <= now;
  const open = joinWindow(event, now).open;
  const labelId = `event-${event.id}`;
  const w = communityWords(store.language);
  return (
    <article aria-labelledby={labelId} className={`st-card ev-card p-4 sm:p-5 ${event.cancelled ? "cm-hidden" : ""}`}>
      <div className="flex items-start gap-4">
        <DateLeaf event={event} locale={LANGUAGES[store.language].locale} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap gap-1.5">
            {event.cancelled ? <span className="cm-badge cm-badge-warn">{w.canceled}</span> : null}
            {live ? <span className="cm-badge cm-badge-creator ev-live">{w.onNow}</span> : null}
            {!live && open ? <span className="cm-badge cm-badge-accent">{w.doorsOpen}</span> : null}
            {mine === true && !over && !event.cancelled ? <span className="cm-badge cm-badge-accent">{w.youAreGoing}</span> : null}
            {locked ? <span className="cm-badge">{w.forSomeMembers}</span> : null}
            {over && event.replay ? <span className="cm-badge cm-badge-accent">{w.replay}</span> : null}
          </p>
          <h3 id={labelId} className="font-display mt-1.5 break-words text-lg font-semibold leading-snug tracking-[-0.01em]">
            <Link href={href} className="st-title-link">{event.title}</Link>
          </h3>
          <p className="st-muted mt-1 text-sm">{`${eventTimeIn(store, event)} · ${lengthIn(store, event.minutes)}`}</p>
          {!event.cancelled ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold">
              <span>{eventWhenIn(store, event, now)}</span>
              <span className="st-muted">{over ? (going === null ? w.countUnchecked : w.rsvpd(going)) : placesWords(store, event, going)}</span>
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
