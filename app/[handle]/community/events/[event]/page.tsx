import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readListings } from "@/lib/catalog";
import { communityVisitor } from "@/lib/community-page";
import { ITEM_ID } from "@/lib/community-text";
import { isVideoRoom, roomKind, videoRoomNote } from "@/lib/call-rooms";
import { MEET_NAMES } from "@/lib/call-setup";
import { eventMeetings } from "@/lib/event-meetings";
import {
  eventClock,
  isOver,
  joinWindow,
  mayAttend,
  readEvent,
  rsvpNumbers,
  wayInFor,
} from "@/lib/community-events";
import { Carry, CommunityBar, PostText, communityNotices, ticketKind } from "@/components/community-parts";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { DateLeaf, eventTimeIn, eventWhenIn, lengthIn, placesWords } from "@/components/community-events";
import { DoorTimer, LocalTime, RoomEmbed } from "@/components/community-event-room";
import { VideoEmbed } from "@/components/video-embed";
import { productSegment } from "@/lib/product-slug";
import { NewTab } from "@/components/new-tab";

type Params = {
  params: Promise<{ handle: string; event: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).liveEventTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

function clockAt(ms: number, tz: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

/**
 * One live event: when, what, who is coming, a place to take, the calendar
 * file, and — from fifteen minutes before until the end, to whoever may
 * come — the way in, with the video room inside the page. Afterwards, the
 * replay. Every part of it is asked again on every visit
 * (lib/community-events.ts). This is the one page whose policy lets it frame
 * the room (lib/csp.ts). An event on Google Meet or Zoom opens in their own
 * tab (lib/event-meetings.ts): nothing of theirs is framed or loaded here.
 */
export default async function CommunityEventPage({ params, searchParams }: Params) {
  const { handle: raw, event: eventId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@") || !ITEM_ID.test(eventId)) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const id = store.community.id;
  const event = await readEvent(id, eventId);
  if (!event) notFound();
  const query = await searchParams;
  const w = communityWords(store.language);
  const locale = LANGUAGES[store.language].locale;
  const notice = communityNotices(store.language)[typeof query.n === "string" ? query.n : ""] ?? null;
  const now = eventClock();

  const [allowed, numbers, meetings] = await Promise.all([
    mayAttend(store, viewer.config, event, { owner: viewer.owner, email: viewer.email }),
    rsvpNumbers(id, [event], viewer.owner ? null : viewer.key),
    // A Google Meet or Zoom event: the link its record says was given — the
    // meeting's own, or the private room when it could not be made.
    event.where === "meet" ? eventMeetings(store, [event]).catch(() => null) : null,
  ]);
  const meeting = meetings?.get(event.id) ?? null;
  // Each null when it could not be read (sweep app5, finding 2): said as not checked, never as "0 going" with places
  // left; a member's own place is read on its own, so the way in follows only a place known to be theirs.
  const going = numbers.get(event.id)?.going ?? null;
  const mine = numbers.get(event.id)?.mine ?? null;
  const over = isOver(event, now);
  const door = joinWindow(event, now);
  const way = wayInFor(event, { owner: viewer.owner, mayAttend: allowed, going: mine === true }, now, meeting?.link || null);
  const place = event.where === "meet" && event.meet && meeting?.made && !meeting.gone ? event.meet : null;
  const whereWords = place ? MEET_NAMES[place] : event.where === "link" ? w.onlineMeeting : w.privateRoom;
  const openWords = roomKind(way) === "meet" ? w.joinMeet : roomKind(way) === "zoom" ? w.joinZoom : w.openMeeting;
  // The host's own way into a Zoom meeting: a fresh start link asked of Zoom on the click, never kept (app/api/integrations/zoom/host).
  const hostLink =
    viewer.owner && place === "zoom" && meeting && roomKind(way) === "zoom"
      ? `/api/integrations/zoom/host?${new URLSearchParams({ scope: meeting.scope, ...(store.sid ? { store: store.sid } : {}) })}`
      : null;
  const full = event.cap > 0 && going !== null && going >= event.cap;
  const room = way && isVideoRoom(way) ? way : null;
  const doorsOpenAt = clockAt(door.opensAt, event.tz, locale);
  const forProducts = allowed ? [] : (await readListings(store, event.only.filter((p) => viewer.config.access.includes(p)))).map((p) => ({ id: p.id, title: p.title, kind: ticketKind(store, p) }));
  const labelId = "event-title";

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={viewer.config} tab="events" signedIn />
      {!over && !event.cancelled ? <DoorTimer at={[door.opensAt, door.closesAt]} /> : null}
      <main id="content" className="mx-auto max-w-3xl px-4 pb-16 pt-6">
        <p>
          <Link href={`${home}/events`} className="cm-quiet-link text-sm font-semibold underline underline-offset-4">{w.allEvents}</Link>
        </p>
        {notice ? <p className={`cm-flash mt-4 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}

        <article aria-labelledby={labelId} className={`st-card mt-4 p-5 sm:p-7 ${event.cancelled ? "cm-hidden" : ""}`}>
          <div className="flex items-start gap-4">
            <DateLeaf event={event} size="lg" locale={locale} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap gap-1.5">
                <span className={`cm-badge ${!event.cancelled && !over && event.start <= now ? "cm-badge-creator ev-live" : event.cancelled ? "cm-badge-warn" : "cm-badge-accent"}`}>
                  {eventWhenIn(store, event, now)}
                </span>
                {mine === true && !over && !event.cancelled ? <span className="cm-badge cm-badge-accent">{w.youAreGoing}</span> : null}
              </p>
              <h1 id={labelId} className="font-display mt-2 break-words text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">{event.title}</h1>
              <p className="mt-2 font-semibold">
                <time dateTime={new Date(event.start).toISOString()}>{eventTimeIn(store, event)}</time>
                <span className="st-muted font-normal">{` · ${lengthIn(store, event.minutes)}`}</span>
              </p>
              <LocalTime ms={event.start} tz={event.tz} locale={locale} template={w.yourTime("{time}")} />
              <p className="st-muted mt-1 text-sm">
                {`${whereWords} · ${w.hostedBy(store.name)}${event.cancelled ? "" : over ? ` · ${going === null ? w.countUnchecked : w.rsvpd(going)}` : ` · ${placesWords(store, event, going)}`}`}
              </p>
            </div>
          </div>

          {!allowed ? (
            <div className="st-note mt-6" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.forMembersWho}</p>
              {forProducts.length ? (
                <ul className="mt-2 space-y-2">
                  {forProducts.map((p) => (
                    <li key={p.id}>
                      <Link href={`/@${store.handle}/p/${productSegment(p)}`} className="cm-row">
                        <span className="min-w-0 break-words font-semibold">{p.title}</span>
                        <span className="st-muted shrink-0 text-sm">{p.kind}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm">{w.productGone(store.name)}</p>
              )}
              <p className="mt-3 text-sm">{w.otherAddress}</p>
            </div>
          ) : event.cancelled ? (
            <p className="cm-flash cm-flash-warn mt-6">{w.canceledByCreator(store.name)}</p>
          ) : !over ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {viewer.owner ? (
                <span className="cm-pill cm-pill-still">{going === null ? w.youHostUnchecked : w.youHost(going)}</span>
              ) : mine === true ? (
                <>
                  <span className="cm-pill cm-pill-on" role="status">{w.youAreGoing}</span>
                  <form action="/api/store/community/rsvp" method="post">
                    <Carry store={store} action="notgoing" from="feed" />
                    <input type="hidden" name="event" value={event.id} />
                    <button type="submit" className="cm-pill">{w.cancelRsvp}</button>
                  </form>
                </>
              ) : mine === null ? (
                <p className="st-muted text-sm" role="status">{w.placeUnchecked}</p>
              ) : full ? (
                <span className="cm-pill cm-pill-still">{w.everyPlaceTaken}</span>
              ) : event.cap > 0 && going === null ? (
                <p className="st-muted text-sm" role="status">{w.placesUnchecked}</p>
              ) : (
                <form action="/api/store/community/rsvp" method="post">
                  <Carry store={store} action="going" from="feed" />
                  <input type="hidden" name="event" value={event.id} />
                  <button type="submit" className="btn st-btn">{event.cap ? w.rsvpTakePlace : w.rsvp}</button>
                </form>
              )}
              <a href={`/api/store/community/calendar?h=${encodeURIComponent(store.handle)}&e=${event.id}`} className="cm-pill">{w.addToCalendar}</a>
            </div>
          ) : null}

          {allowed && !event.cancelled && !over ? (
            <section aria-labelledby="ev-join" className="ev-join mt-6">
              <h2 id="ev-join" className="text-base font-bold">{w.join}</h2>
              {way ? (
                <>
                  {viewer.owner && !door.open ? (
                    <p className="st-muted mt-1 text-sm">{w.onlyYouSee(doorsOpenAt)}</p>
                  ) : (
                    <p className="st-muted mt-1 text-sm">{event.start <= now ? w.onNowSentence : w.doorsOpenStarts(clockAt(event.start, event.tz, locale))}</p>
                  )}
                  {room ? (
                    <div className="mt-4">
                      <RoomEmbed
                        room={room}
                        title={event.title}
                        name={viewer.owner ? store.name : viewer.member?.n ?? ""}
                        note={videoRoomNote(store.language)}
                        words={{ leave: w.leaveRoom, join: w.joinHere, newTab: w.openNewTab, title: w.roomTitle(event.title) }}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        {hostLink ? (
                          <a href={hostLink} target="_blank" rel="noopener noreferrer" className="btn st-btn">{w.startZoomHost}<NewTab language={store.language} /></a>
                        ) : null}
                        <a href={way} target="_blank" rel="noopener noreferrer" className={hostLink ? "cm-pill" : "btn st-btn"}>{openWords}<NewTab language={store.language} /></a>
                        <span className="st-muted min-w-0 break-all text-sm">{way}</span>
                      </div>
                      {place && !viewer.owner ? (
                        <p className="st-muted mt-2 text-sm">
                          {place === "google" ? w.meetWait(store.name) : w.zoomWait(store.name)}
                        </p>
                      ) : null}
                    </>
                  )}
                </>
              ) : door.open && event.cap > 0 && !mine ? (
                <p className="st-muted mt-1 text-sm">{w.placesLimited}</p>
              ) : (
                <p className="st-muted mt-1 text-sm">{event.cap ? w.wayInShowsPlaces(doorsOpenAt) : w.wayInShowsAll(doorsOpenAt)}</p>
              )}
            </section>
          ) : null}

          {event.about ? <PostText text={event.about} className="mt-6" /> : null}

          {over && !event.cancelled ? (
            <section aria-labelledby="ev-replay" className="mt-6">
              <h2 id="ev-replay" className="text-base font-bold">{w.replay}</h2>
              {event.replay && allowed ? (
                <div className="mt-3">
                  <VideoEmbed video={event.replay} title={event.title} poster={null} lang={store.language} />
                </div>
              ) : (
                <p className="st-muted mt-1 text-sm">{allowed ? w.noReplay(store.name) : w.replayForMembers}</p>
              )}
            </section>
          ) : null}
        </article>
      </main>
    </div>
  );
}
