"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { UrlField } from "@/components/url-field";
import { type LinkCheck, roomOnLeave } from "@/lib/url-check";
import type { MeetAccount } from "@/components/call-editor";
import { MEET_NAMES, type MeetProvider } from "@/lib/call-setup";
import {
  EVENT_LENGTHS,
  JOIN_EARLY_MINUTES,
  MAX_EVENT_ABOUT,
  MAX_EVENT_CAP,
  MAX_EVENT_TITLE,
  MAX_KEPT_EVENTS,
  MAX_UPCOMING_EVENTS,
} from "@/lib/community-text";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

/** One event, as the studio shows it: everything but the member-facing page's checks. */
export type StudioEvent = {
  id: string;
  title: string;
  about: string;
  /** The form's fields, on the clock of the event's time zone. */
  date: string;
  time: string;
  tz: string;
  minutes: number;
  cap: number;
  where: "room" | "link" | "meet";
  link: string;
  /** Google Meet or Zoom, when `where` is "meet". */
  meet: MeetProvider | null;
  /**
   * What was made for it on Google or Zoom (lib/event-meetings.ts): the link
   * members will be given (the meeting's own, or the private room it fell
   * back to), the problem when there was one, and whether it is tried again.
   */
  meeting: { link: string; made: boolean; error: string; retrying: boolean; scope: string } | null;
  room: string;
  only: string[];
  replayUrl: string;
  cancelled: boolean;
  over: boolean;
  started: boolean;
  /** "Tuesday, October 6, 6:00 PM (EDT)". */
  when: string;
  length: string;
  /** How many are coming; null when who is coming could not be read just now (never 0 for that). */
  going: number | null;
  /** The first people coming, in the order they said so; empty when `going` is null. */
  people: { name: string; email: string; at: number }[];
  post: string;
};

type Product = { id: string; title: string };
type Space = { id: string; name: string };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  title: "Give the event a title.",
  about_links: "That description has more web addresses than it may carry (10). Take a few out.",
  when: "Pick a date, a start time and a time zone.",
  no_such_time: "That time does not exist in that time zone: the clocks skip it that day. Pick another.",
  past: "That time has passed. Pick one still to come.",
  too_far: "An event can be up to a year ahead.",
  length: "Pick how long it lasts.",
  cap: `A cap is a whole number from 1 to ${MAX_EVENT_CAP.toLocaleString("en-US")}, or empty for no cap.`,
  link: "Your meeting link has to be a full address that starts with https://.",
  meet: "Pick where the event happens.",
  meet_google: "Google Calendar is not connected to this store anymore. Connect it again under Video calls in your studio, or pick another place.",
  meet_zoom: "Zoom is not connected to this store anymore. Connect it again under Video calls in your studio, or pick another place.",
  meet_unknown: "Your video call connections could not be checked just now, so nothing was saved. They may still be connected, so you do not need to connect again. Try again in a moment.",
  only: "One of those products no longer opens the community. Reload the page.",
  too_many: `${MAX_UPCOMING_EVENTS} events are coming up already. Cancel one, or wait for one to be over.`,
  started: "It has started, so it can no longer be moved. Its words, link and cap can still change.",
  over: "It is over, so it can no longer be changed. You can still post its replay.",
  cancelled: "It was canceled, so it can no longer be changed.",
  early: "A replay can be added once the event has started.",
  replay: "That is not a YouTube, Vimeo or Loom address.",
  upcoming: "Cancel it first, so everyone coming is told.",
  telling: "Everyone coming is still being told it was canceled. Delete it once that is done.",
  busy: "This event is being saved from somewhere else right now. Try again in a moment.",
  store_full: "Your store's data room is full. Delete old posts, events or drafts you no longer need.",
  slow: "That is a lot of changes in an hour. Wait a little, then try again.",
  unknown: "That event is not there anymore. Reload the page.",
  not_set_up: "Set the community up first.",
  role: "Your role on this store cannot change events.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  invalid: "That could not be read. Nothing was changed.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

// The meeting link is checked when its field is left, by the reading the server keeps (487 [IT4], pattern 1).
// The link is required here, so an empty one is said too.
const ROOM_CHECK = roomOnLeave(MESSAGES.link);
const LINK_CHECK: LinkCheck = (raw) => (raw.trim() ? ROOM_CHECK(raw) : { problem: MESSAGES.link, fix: null });

/**
 * `notice`, after a move or a cancellation that was made: "waiting" when who is coming could not be read just then
 * (the email goes out once it can), "failed" when the email could not be started at all.
 */
type Answer = { ok?: boolean; error?: string; moved?: boolean; notice?: "waiting" | "failed" };

/** What the studio says when the email about a change could not be started. */
const UNSENT = "but the email to anyone coming could not be started. Tell them in the community.";

async function send(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/community/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function zones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length) return list;
  } catch {}
  return ["UTC"];
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function inAWeek(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const small = "inline-flex min-h-11 -my-2.5 items-center text-sm font-semibold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

/** The community's live events, in the studio: scheduling, changing, cancelling, replays, and who is coming. */
export function CommunityEventsStudio({
  events,
  past,
  products,
  spaces,
  canManage,
  handle,
  roomNote,
  meetings = [],
  meetUnread = false,
  hostStore = null,
}: {
  events: StudioEvent[];
  past: StudioEvent[];
  /** The community's access products, for "only for the buyers of". */
  products: Product[];
  spaces: Space[];
  /** Scheduling needs "events" (lib/team-roles.ts); without it this is a list to read. */
  canManage: boolean;
  handle: string;
  roomNote: string;
  /** Google Calendar and Zoom accounts connected and working (lib/meet-connect.ts); empty offers neither. */
  meetings?: MeetAccount[];
  /** The connections could not be read just now (CX-123 rule 24): said so, never "connect it again". */
  meetUnread?: boolean;
  /** The store's id, when this person may start a Zoom meeting as its host ("settings"); null otherwise. */
  hostStore?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const upcoming = events.filter((e) => !e.cancelled).length;

  async function run(where: string, payload: Record<string, unknown>, done: string | ((a: Answer) => string)): Promise<boolean> {
    setBusy(where);
    setError(null);
    const answer = await send(payload);
    setBusy(null);
    if (!answer.ok) {
      setError({ where, text: MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error });
      return false;
    }
    toast(typeof done === "string" ? done : done(answer));
    router.refresh();
    return true;
  }

  const problem = (where: string) =>
    error?.where === where ? (
      <p className="notice notice-error mt-4" role="alert">{error.text}</p>
    ) : null;

  return (
    <section id="events" className="card mt-8 scroll-mt-24 p-6 sm:p-8" aria-labelledby="cm-events-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cm-events-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Live events</h2>
        <span className={`tag ${upcoming ? "tag-brand" : ""}`}>{upcoming ? `${upcoming} coming up` : "None coming up"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        {`Workshops, Q&As, coworking hours for your members. They RSVP in the community and join from the event's page: in a private video room shown right in the page, at your own meeting link${meetings.length ? `, or in a ${meetings.map((m) => MEET_NAMES[m.provider]).join(" or ")} meeting made for it` : ""}. The way in shows ${JOIN_EARLY_MINUTES} minutes before the start, only to members who can come, and is checked on every visit. Members who asked for the community's emails get a reminder a day and an hour before; moving or canceling it emails everyone coming, once.`}
      </p>

      {canManage ? (
        editing === "new" ? (
          <EventForm
            key="new"
            mode="new"
            event={null}
            products={products}
            spaces={spaces}
            roomNote={roomNote}
            meetings={meetings}
            meetUnread={meetUnread}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={async (payload) => {
              const ok = await run("new", { action: "create", ...payload }, payload.announce ? "Scheduled, and announced in the feed." : "Scheduled.");
              if (ok) setEditing(null);
            }}
            problem={problem("new")}
          />
        ) : (
          <button type="button" className="btn btn-primary mt-5" disabled={busy !== null || upcoming >= MAX_UPCOMING_EVENTS} onClick={() => setEditing("new")}>
            Schedule an event
          </button>
        )
      ) : (
        <p className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">Your role can see who is coming. Scheduling and changing events is for the owner, Admins and Editors.</p>
      )}

      <h3 className="mt-8 text-sm font-bold uppercase tracking-[0.06em] text-ink-soft">Coming up</h3>
      {events.length === 0 ? (
        <p className="mt-3 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">
          {/* The button is named only where it is on the screen: for a role that schedules, while the new event's form is closed. */}
          {canManage && editing !== "new" ? (
            <>Nothing scheduled yet. A live call, a workshop or a Q&amp;A: press &ldquo;Schedule an event&rdquo; to put one on your community&rsquo;s calendar.</>
          ) : (
            "Nothing scheduled yet."
          )}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {events.map((event) => (
            <li key={event.id} className={`rounded-[var(--r-md)] border border-line p-4 ${event.cancelled ? "opacity-70" : ""}`}>
              {editing === event.id ? (
                <EventForm
                  key={event.id}
                  mode="edit"
                  event={event}
                  products={products}
                  spaces={spaces}
                  roomNote={roomNote}
                  meetings={meetings}
                  meetUnread={meetUnread}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (payload) => {
                    const ok = await run(`e-${event.id}`, { action: "edit", event: event.id, ...payload }, (a) =>
                      a.moved
                        ? a.notice === "failed"
                          ? `Moved, ${UNSENT}`
                          : a.notice === "waiting" || event.going === null
                            ? "Moved. Anyone coming is being emailed."
                            : event.going ? `Moved. ${event.going === 1 ? "The person" : `The ${event.going} people`} coming ${event.going === 1 ? "is" : "are"} being emailed.` : "Moved."
                        : "Saved.",
                    );
                    if (ok) setEditing(null);
                  }}
                  problem={problem(`e-${event.id}`)}
                />
              ) : (
                <EventRow
                  handle={handle}
                  hostStore={hostStore}
                  event={event}
                  products={products}
                  canManage={canManage}
                  busy={busy}
                  onEdit={() => {
                    setError(null);
                    setEditing(event.id);
                  }}
                  onCancelEvent={() => {
                    const who = event.going === null ? " Anyone coming will be emailed once." : event.going ? ` The ${event.going === 1 ? "person" : `${event.going} people`} coming will be emailed once.` : "";
                    if (window.confirm(`Cancel "${event.title}"?${who} This cannot be undone.`)) {
                      run(`e-${event.id}`, { action: "cancel", event: event.id }, (a) =>
                        a.notice === "failed"
                          ? `Canceled, ${UNSENT}`
                          : a.notice === "waiting" || event.going === null
                            ? "Canceled. Anyone coming is being emailed."
                            : event.going ? "Canceled. Everyone coming is being emailed." : "Canceled.",
                      );
                    }
                  }}
                  onDelete={() => {
                    if (window.confirm(`Delete "${event.title}" for good?`)) run(`e-${event.id}`, { action: "delete", event: event.id }, "Deleted.");
                  }}
                  run={run}
                />
              )}
              {editing !== event.id ? problem(`e-${event.id}`) : null}
            </li>
          ))}
        </ul>
      )}

      {past.length ? (
        <>
          <h3 className="mt-8 text-sm font-bold uppercase tracking-[0.06em] text-ink-soft">Over</h3>
          <ul className="mt-3 space-y-3">
            {past.map((event) => (
              <li key={event.id} className="rounded-[var(--r-md)] border border-line p-4">
                <EventRow
                  handle={handle}
                  hostStore={hostStore}
                  event={event}
                  products={products}
                  canManage={canManage}
                  busy={busy}
                  onEdit={() => {}}
                  onCancelEvent={() => {}}
                  onDelete={() => {
                    if (window.confirm(`Delete "${event.title}" and its replay link for good?`)) run(`e-${event.id}`, { action: "delete", event: event.id }, "Deleted.");
                  }}
                  run={run}
                />
                {problem(`e-${event.id}`)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-5 text-sm text-ink-soft">
        {`Up to ${MAX_UPCOMING_EVENTS} coming up at a time. Past events stay, with their replays, up to ${MAX_KEPT_EVENTS} in all; after that the oldest past event makes room.`}
      </p>
    </section>
  );
}

function EventRow({
  handle,
  hostStore,
  event,
  products,
  canManage,
  busy,
  onEdit,
  onCancelEvent,
  onDelete,
  run,
}: {
  handle: string;
  hostStore: string | null;
  event: StudioEvent;
  products: Product[];
  canManage: boolean;
  busy: string | null;
  onEdit: () => void;
  onCancelEvent: () => void;
  onDelete: () => void;
  run: (where: string, payload: Record<string, unknown>, done: string) => Promise<boolean>;
}) {
  const [replay, setReplay] = useState(event.replayUrl);
  const [copied, setCopied] = useState(false);
  const way = event.where === "room" ? event.room : event.where === "meet" ? event.meeting?.link || event.room : event.link;
  const meetName = event.where === "meet" && event.meet ? MEET_NAMES[event.meet] : null;
  const made = Boolean(meetName && event.meeting?.made);
  const only = event.only.map((id) => products.find((p) => p.id === id)?.title).filter(Boolean);
  // Who is coming did not read: no count at all, and the notice below says why.
  const places = event.going === null
    ? event.over ? "Not known how many RSVP'd" : event.cap ? `Not known how many of ${event.cap} ${event.cap === 1 ? "place is" : "places are"} taken` : "Not known how many are going"
    : event.over ? `${event.going} RSVP'd` : event.cap ? `${event.going} of ${event.cap} ${event.cap === 1 ? "place" : "places"} taken` : `${event.going} going`;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 break-words font-semibold text-ink">
          {event.title}
          {event.cancelled ? <span className="tag ml-2 align-middle">Canceled</span> : event.started && !event.over ? <span className="tag tag-live ml-2 align-middle">On now</span> : null}
        </p>
        <span className="text-sm font-semibold tabular-nums text-ink-soft">{places}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{`${event.when} · ${event.length}`}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {event.where === "room" ? "Private video room" : meetName ? `${meetName} (automatic)${made || event.cancelled ? "" : ", using its private video room for now"}` : "Your meeting link"}
        {only.length ? ` · only for buyers of ${only.join(", ")}` : " · every member"}
        {event.post ? " · announced in the feed" : ""}
      </p>
      {meetName && event.meeting?.error && !event.over && !event.cancelled ? (
        <p className="mt-2 rounded-[10px] bg-amber-brand/10 px-3 py-2 text-sm text-ink" role="status">
          {`${made ? `The ${meetName} meeting could not be kept in step yet` : `The ${meetName} link could not be made`}: ${event.meeting.error}.${made ? "" : " Members get the event's private video room instead."}${event.meeting.retrying ? " We keep trying on our own until two hours before it starts." : ""}`}
        </p>
      ) : null}
      {way && !event.over && !event.cancelled ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 break-all rounded-[8px] bg-paper px-3 py-1.5 font-mono text-[0.8125rem] text-violet-deep ring-1 ring-line">{way}</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(way);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2200);
              } catch {
                setCopied(false);
              }
            }}
          >
            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <a href={`/@${handle}/community/events/${event.id}`} className={small}>Open its page</a>
        {hostStore !== null && event.meet === "zoom" && made && event.meeting && !event.over && !event.cancelled ? (
          <a
            href={`/api/integrations/zoom/host?${new URLSearchParams({ scope: event.meeting.scope, ...(hostStore ? { store: hostStore } : {}) })}`}
            target="_blank"
            rel="noopener noreferrer"
            className={small}
          >
            Start in Zoom
          <NewTab /></a>
        ) : null}
        {canManage && !event.over && !event.cancelled ? (
          <>
            <button type="button" className={small} disabled={busy !== null} onClick={onEdit}>Edit or move</button>
            <button type="button" className={small} disabled={busy !== null} onClick={onCancelEvent}>Cancel the event</button>
          </>
        ) : null}
        {canManage && (event.over || event.cancelled) ? (
          <button type="button" className={small} disabled={busy !== null} onClick={onDelete}>Delete</button>
        ) : null}
      </div>

      {event.going === null ? (
        <p className="mt-2 rounded-[10px] bg-amber-brand/10 px-3 py-2 text-sm text-ink" role="status">
          Who is coming could not be read just now, so the number and the names are not shown. Reload the page to try again.
        </p>
      ) : event.people.length ? (
        <details className="mt-3">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink">
            {`Who is coming (${event.going})`}
          </summary>
          <ul className="mt-2 divide-y divide-line text-sm">
            {event.people.map((p) => (
              <li key={`${p.email}-${p.at}`} className="flex flex-wrap justify-between gap-x-3 py-1.5">
                <span className="min-w-0 break-words font-semibold text-ink">{p.name || <span className="font-normal italic text-ink-mute">No name chosen</span>}</span>
                <span className="break-all text-ink-soft">{p.email}</span>
              </li>
            ))}
          </ul>
          {event.going !== null && event.going > event.people.length ? <p className="mt-2 text-xs text-ink-mute">{`The first ${event.people.length} of ${event.going}.`}</p> : null}
        </details>
      ) : null}

      {canManage && !event.cancelled && event.started ? (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(`e-${event.id}`, { action: "replay", event: event.id, url: replay }, replay.trim() ? "Replay saved. Members who could come see it on the event's page." : "Replay removed.");
          }}
        >
          <label htmlFor={`replay-${event.id}`} className="field-label">Replay</label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id={`replay-${event.id}`}
              className="field min-w-0 flex-1"
              inputMode="url"
              placeholder="A YouTube, Vimeo or Loom address"
              value={replay}
              onChange={(e) => setReplay(e.target.value)}
            />
            <button type="submit" className="btn btn-secondary" disabled={busy !== null || replay.trim() === event.replayUrl}>Save replay</button>
          </div>
          <p className="mt-1 text-xs text-ink-mute">Played from YouTube&apos;s privacy-enhanced player, Vimeo or Loom, only after a member presses play. Use an unlisted video: anyone with its address can watch it.</p>
        </form>
      ) : null}
    </div>
  );
}

type Payload = {
  title: string;
  about: string;
  date: string;
  time: string;
  tz: string;
  minutes: number;
  cap: string;
  where: "room" | "link" | "meet";
  link: string;
  meet: MeetProvider | null;
  only: string[];
  announce: boolean;
  space: string;
};

function EventForm({
  mode,
  event,
  products,
  spaces,
  roomNote,
  meetings,
  meetUnread,
  busy,
  onCancel,
  onSave,
  problem,
}: {
  mode: "new" | "edit";
  event: StudioEvent | null;
  products: Product[];
  spaces: Space[];
  roomNote: string;
  meetings: MeetAccount[];
  meetUnread: boolean;
  busy: string | null;
  onCancel: () => void;
  onSave: (payload: Payload) => void;
  problem: React.ReactNode;
}) {
  const [zoneList] = useState(zones);
  const [draft, setDraft] = useState<Payload>(() => ({
    title: event?.title ?? "",
    about: event?.about ?? "",
    date: event?.date ?? inAWeek(),
    time: event?.time ?? "18:00",
    tz: event?.tz ?? localZone(),
    minutes: event?.minutes ?? 60,
    cap: event?.cap ? String(event.cap) : "",
    where: event?.where ?? "room",
    link: event?.link ?? "",
    meet: event?.meet ?? null,
    only: event?.only ?? [],
    announce: false,
    space: spaces[0]?.id ?? "",
  }));
  const set = (change: Partial<Payload>) => setDraft((d) => ({ ...d, ...change }));
  // Google Meet or Zoom choices drawn under "Where": a connected one, or the saved choice of this event.
  const meetChoices = (["google", "zoom"] as const).filter((p) => meetings.some((m) => m.provider === p) || (draft.where === "meet" && draft.meet === p));
  const id = (name: string) => `ev-${event?.id ?? "new"}-${name}`;
  const locked = Boolean(event?.started);
  const zoneOptions = zoneList.includes(draft.tz) ? zoneList : [draft.tz, ...zoneList];
  const where = mode === "new" ? "new" : `e-${event?.id}`;

  return (
    <form
      className="mt-5 space-y-4 rounded-[var(--r-md)] bg-paper p-4 ring-1 ring-line sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <p className="font-semibold text-ink">{mode === "new" ? "A new live event" : "Edit or move"}</p>
      <div>
        <label htmlFor={id("title")} className="field-label">Title</label>
        <input id={id("title")} className="field mt-1" required maxLength={MAX_EVENT_TITLE} value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Monthly Q&A" />
      </div>
      <div>
        <label htmlFor={id("about")} className="field-label">What it is (optional)</label>
        <textarea id={id("about")} className="field mt-1 min-h-[5rem]" maxLength={MAX_EVENT_ABOUT} value={draft.about} onChange={(e) => set({ about: e.target.value })} placeholder="Bring your questions. We will go through the three most asked, then open the floor." />
      </div>
      <fieldset disabled={locked}>
        <legend className="field-label">When</legend>
        {locked ? <p className="mt-1 text-sm text-ink-soft">It has started, so its time stays as it is.</p> : null}
        <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="col-span-2 block">
            <span className="text-xs font-semibold text-ink-soft">Date</span>
            <input type="date" required value={draft.date} onChange={(e) => set({ date: e.target.value })} className="field mt-1 !min-h-0 !py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-soft">Starts</span>
            <input type="time" step={300} required value={draft.time} onChange={(e) => set({ time: e.target.value })} className="field mt-1 !min-h-0 !py-1.5" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-soft">Length</span>
            <select value={draft.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} className="field mt-1 !min-h-0 !py-1.5 !pl-3">
              {EVENT_LENGTHS.map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 block sm:col-span-4">
            <span className="text-xs font-semibold text-ink-soft">Time zone</span>
            <select value={draft.tz} onChange={(e) => set({ tz: e.target.value })} className="field mt-1 !min-h-0 !py-1.5 !pl-3">
              {zoneOptions.map((z) => (
                <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
        </div>
        {mode === "edit" && !locked ? <p className="mt-2 text-sm text-ink-soft">A new time is emailed once to everyone coming.</p> : null}
      </fieldset>

      <div>
        <label htmlFor={id("cap")} className="field-label">Places (optional)</label>
        <input
          id={id("cap")}
          className="field mt-1 max-w-[12rem]"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_EVENT_CAP}
          step={1}
          value={draft.cap}
          onChange={(e) => set({ cap: e.target.value })}
          placeholder="No cap"
          aria-describedby={id("cap-help")}
        />
        <p id={id("cap-help")} className="mt-1 text-sm text-ink-soft">With a cap, members take a place with their RSVP and only those with a place see the way in. Empty: every member who can come sees it.</p>
      </div>

      <fieldset>
        <legend className="field-label">Where</legend>
        {/*
          Google Meet or Zoom, made on the store's connected account
          (lib/event-meetings.ts): offered while connected. A choice saved
          while connected stays on screen after a disconnect, so the creator
          sees why it no longer works rather than a silent switch.
        */}
        {meetChoices.map((p) => {
            const account = meetings.find((m) => m.provider === p) ?? null;
            return (
              <label key={p} className="mt-1 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
                <input type="radio" name={id("where")} className="mt-1 h-5 w-5 shrink-0" checked={draft.where === "meet" && draft.meet === p} onChange={() => set({ where: "meet", meet: p })} />
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{`${MEET_NAMES[p]} (automatic)`}</span>
                  <span className="block break-words text-sm text-ink-soft">
                    {account
                      ? p === "google"
                        ? `A Google Calendar event with a Meet link is made on ${account.account}, with nobody on its guest list: members get the link on the event's page and ask to join, and you let them in.`
                        : `A Zoom meeting is made on ${account.account}. Members get its link on the event's page and come in once you start it, from Zoom or with Start in Zoom here.`
                      : meetUnread
                        ? `We could not check your ${p === "google" ? "Google Calendar" : "Zoom"} connection just now. It may still be connected, so you do not need to connect it again. Reload this page in a moment.`
                        : `${p === "google" ? "Google Calendar" : "Zoom"} is not connected anymore: connect it again under Video calls in your studio, or pick another place.`}
                  </span>
                </span>
              </label>
            );
          })}
        {/* Only when no Google or Zoom choice is drawn above: a saved one already says it could not be checked. */}
        {meetUnread && meetChoices.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft" role="status">
            Your Google Calendar and Zoom connections could not be checked just now, so they are not offered here. Reload this page in a moment.
          </p>
        ) : null}
        <label className="mt-1 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
          <input type="radio" name={id("where")} className="mt-1 h-5 w-5 shrink-0" checked={draft.where === "room"} onChange={() => set({ where: "room", meet: null })} />
          <span className="min-w-0">
            <span className="block font-semibold text-ink">A private video room, made for this event</span>
            <span className="block text-sm text-ink-soft">{`Shown inside the event's page, or in a tab of its own. ${roomNote}`}</span>
          </span>
        </label>
        <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
          <input type="radio" name={id("where")} className="mt-1 h-5 w-5 shrink-0" checked={draft.where === "link"} onChange={() => set({ where: "link", meet: null })} />
          <span className="min-w-0">
            <span className="block font-semibold text-ink">Your own meeting link</span>
            <span className="block text-sm text-ink-soft">Zoom, Google Meet, a livestream. It opens in a new tab.</span>
          </span>
        </label>
        {draft.where === "meet" && draft.meet ? (
          <p className="mt-2 rounded-[10px] bg-white px-3 py-2 text-sm text-ink-soft ring-1 ring-line">
            {`Members see its link on the event's page, ${JOIN_EARLY_MINUTES} minutes before the start, as with the other places. Moving the event moves the meeting; canceling it removes the meeting. If it cannot be made, the event uses its private video room, and we keep trying until two hours before it starts. ${
              draft.meet === "google"
                ? "Your Google plan sets how many can join and for how long (free accounts: 100 people, 60 minutes for three or more)."
                : "Your Zoom plan sets how many can join and for how long (free accounts: 100 people, 40 minutes)."
            }`}
          </p>
        ) : null}
        {draft.where === "link" ? (
          <div className="mt-2 px-2">
            <label htmlFor={id("link")} className="sr-only">Your meeting link</label>
            <UrlField id={id("link")} className="field" value={draft.link} onChange={(link) => set({ link })} check={LINK_CHECK} placeholder="https://zoom.us/j/… or https://meet.google.com/…" />
          </div>
        ) : null}
      </fieldset>

      {products.length > 1 || (products.length === 1 && draft.only.length) ? (
        <fieldset>
          <legend className="field-label">Who can come</legend>
          <p className="mt-1 text-sm text-ink-soft">Every member, or only the buyers of some of the products that open the community. Checked on every visit.</p>
          <ul className="mt-1 space-y-0.5">
            {products.map((p) => (
              <li key={p.id}>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={draft.only.includes(p.id)}
                    onChange={() => set({ only: draft.only.includes(p.id) ? draft.only.filter((x) => x !== p.id) : [...draft.only, p.id] })}
                  />
                  <span className="min-w-0 break-words font-semibold text-ink">{`Only buyers of ${p.title}`}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-sm text-ink-soft">{draft.only.length ? "Other members see the event, and what opens it, but cannot RSVP or join." : "Nothing checked: every member can come."}</p>
        </fieldset>
      ) : null}

      {mode === "new" && spaces.length ? (
        <div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={draft.announce} onChange={(e) => set({ announce: e.target.checked })} />
            <span>
              <span className="block font-semibold text-ink">Announce it in the feed</span>
              <span className="block text-sm text-ink-soft">An announcement post with the time and a link to RSVP. Not emailed.</span>
            </span>
          </label>
          {draft.announce && spaces.length > 1 ? (
            <div className="mt-2 pl-8">
              <label htmlFor={id("space")} className="text-xs font-semibold text-ink-soft">In the space</label>
              <select id={id("space")} className="field mt-1 !min-h-0 !py-1.5 !pl-3" value={draft.space} onChange={(e) => set({ space: e.target.value })}>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" aria-busy={busy === where} disabled={busy !== null}>
          {busy === where ? "Saving…" : mode === "new" ? "Schedule it" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy !== null}>Close</button>
      </div>
      {problem}
    </form>
  );
}
