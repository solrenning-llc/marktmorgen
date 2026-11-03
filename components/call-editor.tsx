"use client";

import { MAX_PLACE_LINE, MAX_PLACE_LINES, placeLine } from "@/lib/call-place";
import { useState, useId } from "react";
import { useStoreCurrency } from "@/components/store-currency";
import { type LengthsProblem, MAX_CALL_LENGTHS, lengthsProblemWords } from "@/lib/call-lengths";
import { type Currency, priceExample, rangeWords, toMajor } from "@/lib/money";
import { UrlField } from "@/components/url-field";
import { roomOnLeave } from "@/lib/url-check";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import {
  BUFFERS,
  CALL_LENGTHS,
  type CallSetup,
  DAY_NAMES,
  MEET_NAMES,
  type MeetProvider,
  HORIZON_CHOICES,
  MAX_RANGES_PER_DAY,
  MAX_SEATS,
  MAX_SESSIONS,
  MAX_SESSION_SEATS,
  NOTICE_CHOICES,
  CANCEL_HOURS,
  type Range,
  SESSION_LENGTHS,
  SESSION_NOTICE_CHOICES,
  clock,
  defaultWeekly,
  fromClock,
  newSessionId,
  partsIn,
} from "@/lib/call-setup";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  minutes: "Pick how long a call lasts.",
  tz: "Pick your time zone.",
  weekly: "Check your hours: switch on at least one day, and make every stretch long enough for one call, with the second stretch starting after the first ends.",
  notice: "Pick how much notice you need.",
  cancel: "Pick a cancellation deadline from the list, or none.",
  horizon: "Pick how far ahead people may book.",
  buffer: "Pick the gap between calls.",
  room: "The meeting link has to be a full web address starting with https://.",
  place: `Write your address on up to ${MAX_PLACE_LINES} lines of ${MAX_PLACE_LINE} characters or fewer, as a buyer reads it, with no web link.`,
  seats: `People per time has to be a whole number from 1 to ${MAX_SEATS}.`,
  sessions: `Add at least one session, at most ${MAX_SESSIONS}, and no two starting at the same moment.`,
  session_time: "Check each session's date and start time: one of them is missing, or is a time your clocks skip when they go forward.",
  session_seats: `Seats in a session have to be a whole number from 1 to ${MAX_SESSION_SEATS}.`,
  session_room: "Each session's meeting link has to be a full web address starting with https://, or left empty.",
  meet_google: "Google Calendar is not connected to this store anymore. Connect it again under Video calls in your studio, or pick another place for the call.",
  meet_zoom: "Zoom is not connected to this store anymore. Connect it again under Video calls in your studio, or pick another place for the call.",
  past: "A new or changed session has to start in the future.",
  upcoming: "Add at least one session that is still to come.",
  booked: "Somebody has booked a session you moved or took off. A booked session keeps its date, time and length; you can still change its link, or add more seats.",
  booked_seats: "A session cannot have fewer seats than are already booked.",
  kind: "People have booked times that are still to come, so this cannot switch between weekly hours and dated sessions, or between online and in person, until they have passed.",
  error: "Your bookings could not be checked with Stripe just now, so nothing was saved. Try again in a moment.",
  free: "Something free cannot be a paid call. Give it a price first.",
  recurring: "A membership cannot be a call. Make it a one-off price first.",
  options: "Take the price options off first: a call has one price.",
  delivery: "Take the file or link off first: a call delivers a time in your calendar, not a file.",
  course: "This is a course. Stop selling it as a course first.",
  bundle: "A bundle cannot be a call. Stop it being a bundle first.",
  pwyw: "A call has a set price. Stop letting buyers choose the price first.",
  unknown: "That product is not there anymore. Reload the page.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

// A meeting link is checked when its field is left, by the reading the server keeps (487 [IT4], pattern 1).
const ROOM_CHECK = roomOnLeave(MESSAGES.room);
const SESSION_ROOM_CHECK = roomOnLeave(MESSAGES.session_room);

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

/** "Mon–Fri 9:00–17:00" style, for the one-line summary in the studio. */
function summarise(setup: CallSetup): string {
  const days = setup.weekly
    .map((ranges, day) => (ranges.length ? `${DAY_NAMES[day].slice(0, 3)} ${ranges.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(", ")}` : null))
    .filter(Boolean);
  return days.join(" · ");
}

function hoursLabel(h: number): string {
  return h === 1 ? "1 hour" : `${h} hours`;
}

function sessionLength(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : h === 1 ? "1 hour" : `${h} hours`;
}

type SessionDraft = { id: string; date: string; time: string; minutes: number; seats: string; room: string };

export type Draft = {
  kind: "weekly" | "live";
  minutes: number;
  tz: string;
  weekly: Range[][];
  noticeHours: number;
  horizonDays: number;
  bufferMinutes: number;
  room: string;
  /** A private video room made for each booking, instead of the link above. */
  video: boolean;
  /** A Google Meet or Zoom meeting made for each booking, on the creator's connected account. */
  meet: MeetProvider | null;
  /** In person, at this address (lib/call-place.ts), one line per row as typed; then there is no link at all. */
  inPerson: boolean;
  place: string;
  /** Typed, so a field being cleared to retype it is not snapped back to a number. */
  seats: string;
  sessions: SessionDraft[];
  /** The cancellation deadline in hours before the start (lib/call-setup.ts, CANCEL_HOURS); 0 is none. */
  cancelHours: number;
  /** Other lengths than the call's own, each with its price as typed (lib/call-lengths.ts); the call's own is at the product's price. */
  extra: { id: string; minutes: number; price: string }[];
};

/** A row's own key, so removing one never moves focus or a typed price onto another. */
const rowId = () => Math.random().toString(36).slice(2, 10);

/** A Google Calendar or Zoom account this store can make meetings on, as the studio shows it. */
export type MeetAccount = { provider: MeetProvider; account: string };

export type Where = "own" | "video" | "place" | MeetProvider;

function whereOf(draft: Pick<Draft, "video" | "meet" | "inPerson">): Where {
  return draft.inPerson ? "place" : draft.meet ?? (draft.video ? "video" : "own");
}

/** What choosing where does to a draft: in person turns every link off, and any other choice turns in person off. */
export function choose(draft: Draft, where: Where): Draft {
  return { ...draft, inPerson: where === "place", video: where === "video", meet: where === "google" || where === "zoom" ? where : null };
}

/**
 * Where the call happens: the creator's own link, as it always was, a
 * private video room made for each booking (lib/call-rooms.ts), or — when
 * the store has connected Google Calendar or Zoom (lib/meet-connect.ts) — a
 * Google Meet or Zoom meeting made on that account for each booking
 * (lib/meet-links.ts). Radio cards; what the chosen one means, and what it
 * asks of the creator, is said right under it. The automatic ones are only
 * offered while connected: a store that has not connected either sees the
 * two cards it always saw.
 */
function RoomChoice({
  where,
  live,
  meetings,
  onChange,
  place,
  onPlace,
  placeId,
  placeInvalid = false,
  children,
}: {
  where: Where;
  live: boolean;
  /** The address as typed, shown while in person is chosen (520 [LB1]). */
  place: string;
  onPlace: (place: string) => void;
  placeId: string;
  /** The last save was refused for the address. */
  placeInvalid?: boolean;
  /** The accounts connected and working; empty offers neither automatic choice. */
  meetings: MeetAccount[];
  onChange: (where: Where) => void;
  /** The field for the creator's own link, shown while that (or a meeting, as its fallback) is chosen. */
  children?: React.ReactNode;
}) {
  const card =
    "flex cursor-pointer items-start gap-3 rounded-[12px] border px-3 py-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-violet-brand";
  const chosen = (value: Where) => (where === value ? "border-violet-brand bg-lilac/40" : "border-line bg-white");
  const connected = (p: MeetProvider) => meetings.find((m) => m.provider === p) ?? null;
  // A choice saved while connected stays on screen after a disconnect, so
  // the creator sees why it no longer works rather than a silent switch.
  const offered = (["google", "zoom"] as const).filter((p) => connected(p) || where === p);
  const meeting = where === "google" || where === "zoom" ? where : null;
  return (
    <fieldset>
      <legend className="field-label">Where it happens</legend>
      <div className="mt-2 grid gap-2">
        {offered.map((p) => {
          const account = connected(p);
          return (
            <label key={p} className={`${card} ${chosen(p)}`}>
              <input type="radio" name="where" checked={where === p} onChange={() => onChange(p)} className="mt-1 h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{`${MEET_NAMES[p]} (automatic)`}</span>
                <span className="mt-0.5 block break-words text-sm text-ink-soft">
                  {account
                    ? p === "google"
                      ? `A Google Calendar event with a Meet link is made on ${account.account} for ${live ? "each session" : "each booking"}.`
                      : `A Zoom meeting is made on ${account.account} for ${live ? "each session" : "each booking"}.`
                    : `${p === "google" ? "Google Calendar" : "Zoom"} is not connected anymore: connect it again under Video calls in your studio, or pick another place.`}
                </span>
              </span>
            </label>
          );
        })}
        <label className={`${card} ${chosen("own")}`}>
          <input type="radio" name="where" checked={where === "own"} onChange={() => onChange("own")} className="mt-1 h-4 w-4 shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-ink">{meetings.length || offered.length ? "Your own link" : "Your own link (Zoom, Google Meet…)"}</span>
            <span className="mt-0.5 block text-sm text-ink-soft">
              {live ? "The link you give each session below." : "The link you type below, the same for every booking."}
            </span>
          </span>
        </label>
        <label className={`${card} ${chosen("video")}`}>
          <input type="radio" name="where" checked={where === "video"} onChange={() => onChange("video")} className="mt-1 h-4 w-4 shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-ink">Create a private video room for each booking</span>
            <span className="mt-0.5 block text-sm text-ink-soft">
              Nothing to set up and no account: a Jitsi Meet link nobody can guess.
            </span>
          </span>
        </label>
        <label className={`${card} ${chosen("place")}`}>
          <input type="radio" name="where" checked={where === "place"} onChange={() => onChange("place")} className="mt-1 h-4 w-4 shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-ink">In person, at your address</span>
            <span className="mt-0.5 block text-sm text-ink-soft">
              For a salon, a studio or an office: no call and no link.
            </span>
          </span>
        </label>
      </div>
      {where === "place" ? (
        <div className="mt-3">
          <label htmlFor={placeId} className="field-label">Your address</label>
          <textarea
            id={placeId}
            rows={MAX_PLACE_LINES}
            value={place}
            onChange={(e) => onPlace(e.target.value)}
            aria-describedby={`${placeId}-help`}
            aria-invalid={placeInvalid || undefined}
            autoComplete="street-address"
            className="field mt-2"
          />
          <p id={`${placeId}-help`} className="mt-1 text-sm text-ink-soft">
            {`One line per row, up to ${MAX_PLACE_LINES} lines of ${MAX_PLACE_LINE} characters, with no web link, as a buyer should read it. For example: Bela Studio, 12 Harbor Street, Portland, ME 04101, United States, each on its own line. They see it before paying, and in the confirmation, the reminders and the calendar file.`}
          </p>
        </div>
      ) : where === "video" ? (
        <div className="mt-3 rounded-[10px] bg-paper px-3 py-3 text-sm text-ink-soft">
          <p>
            {live
              ? "Each session gets one room, shared by everyone booked into it. "
              : "Each booking gets its own room, and keeps it if it is moved; a group call has one room per time, shared by everyone booked into it. "}
            The link is in the booking and reminder emails, the calendar file, your bookings calendar and the buyer&apos;s purchases page.
          </p>
          <p className="mt-2">
            <strong className="text-ink">Good to know:</strong> Jitsi Meet (meet.jit.si) is a free video service run by a third
            party, not by us. Nobody needs an account to join, but the first person to open a room may be asked to sign in to
            Jitsi with an existing account, such as Google or GitHub, to start the meeting as its moderator, and the others wait until
            then. Open it a few minutes early and sign in yourself.
          </p>
        </div>
      ) : meeting ? (
        <>
          <div className="mt-3 rounded-[10px] bg-paper px-3 py-3 text-sm text-ink-soft">
            <p>
              {live
                ? "Each session gets one meeting, made when its first seat is booked and shared by everyone booked into it. "
                : "Each booking gets its own meeting, moved with it if the buyer moves it; a group call has one meeting per time. "}
              {meeting === "google"
                ? "Buyers are on the event's guest list but never see each other's addresses, and get the link in our emails and calendar file; Google emails nobody."
                : "Buyers get its join link in our emails and calendar file; you start it from Zoom or from Upcoming calls in your studio."}
            </p>
            <p className="mt-2">
              <strong className="text-ink">Good to know:</strong>{" "}
              {meeting === "google"
                ? "Your Google plan sets how many can join and for how long (free accounts: 100 people, 60 minutes for three or more)."
                : "Your Zoom plan sets how many can join and for how long (free accounts: 100 people, 40 minutes)."}{" "}
              If a meeting cannot be made, the buyer gets the link below, or a private video room when it is empty, and we keep trying on our own for several hours.
            </p>
          </div>
          {children ?? null}
        </>
      ) : (
        children ?? null
      )}
    </fieldset>
  );
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A new session: a week from today at six in the evening, like the one before it if there is one. */
function newSession(tz: string, before: SessionDraft | undefined): SessionDraft {
  const p = partsIn(Date.now() + 7 * 86_400_000, tz);
  return {
    id: newSessionId(),
    date: isoDate(p.year, p.month, p.day),
    time: before?.time ?? "18:00",
    minutes: before?.minutes ?? 60,
    seats: before?.seats ?? "100",
    room: before?.room ?? "",
  };
}

function toDraft(setup: CallSetup | null, kind: "weekly" | "live", currency: Currency): Draft {
  if (setup) {
    const now = Date.now();
    return {
      ...setup,
      weekly: setup.weekly.map((day) => day.map((r) => [r[0], r[1]] as Range)),
      room: setup.room ?? "",
      inPerson: Boolean(setup.place),
      place: setup.place?.lines.join("\n") ?? "",
      seats: String(setup.seats),
      cancelHours: setup.cancelHours ?? 0,
      extra: (setup.lengths ?? []).slice(1).map((l) => ({ id: rowId(), minutes: l.minutes, price: String(toMajor(l.cents, currency)) })),
      // Sessions that are over are not shown, and are let go when this is saved.
      sessions: setup.sessions
        .filter((s) => s.start + s.minutes * 60_000 > now)
        .map((s) => {
          const p = partsIn(s.start, setup.tz);
          return {
            id: s.id,
            date: isoDate(p.year, p.month, p.day),
            time: clock(p.hour * 60 + p.minute),
            minutes: s.minutes,
            seats: String(s.seats),
            room: s.room ?? "",
          };
        }),
    };
  }
  const tz = localZone();
  return {
    kind,
    minutes: 30,
    tz,
    weekly: defaultWeekly(),
    noticeHours: kind === "live" ? 0 : 12,
    horizonDays: 30,
    bufferMinutes: 10,
    room: "",
    video: false,
    meet: null,
    inPerson: false,
    place: "",
    seats: "1",
    sessions: kind === "live" ? [newSession(tz, undefined)] : [],
    cancelHours: 0,
    extra: [],
  };
}

/** The next few dated sessions, as the summary in the studio lists them. */
function upcomingSessions(setup: CallSetup) {
  const now = Date.now();
  return setup.sessions.filter((s) => s.start + s.minutes * 60_000 > now);
}

function sessionWhen(start: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(start));
}

const SHORTER_LENGTH = "Each other length has to be longer than the call's own length. Pick a longer one, or make the call's own length shorter.";
const OWN_PRICE = "This product's price is outside what your store's currency allows for a call. Change the product's price first, then add the other lengths.";

/**
 * Other lengths a one-to-one call may offer, each with its price (637 [GL5],
 * lib/call-lengths.ts). The call's own length, at this product's price, is
 * always the first; each other one is longer, so the price on the store is
 * the call's own. Optional: none keeps the call exactly as it is.
 */
function OtherLengths({ draft, setDraft, currency, id, wrong }: { draft: Draft; setDraft: (d: Draft) => void; currency: Currency; id: string; wrong: number | null }) {
  const longer = CALL_LENGTHS.filter((m) => m > draft.minutes);
  const unused = longer.filter((m) => !draft.extra.some((row) => row.minutes === m));
  const setRow = (index: number, change: Partial<Draft["extra"][number]>) =>
    setDraft({ ...draft, extra: draft.extra.map((row, i) => (i === index ? { ...row, ...change } : row)) });
  // Focus follows the change (2.4.3): to a new row's length, or back to the group's explanation once a row is gone.
  const focusSoon = (target: string) => requestAnimationFrame(() => document.getElementById(target)?.focus());
  return (
    <fieldset aria-describedby={`lengths-hint-${id}`}>
      <legend className="field-label">Other lengths (optional)</legend>
      <p id={`lengths-hint-${id}`} className="field-hint" tabIndex={-1}>
        {`Let people choose a longer call at its own price. ${draft.minutes} minutes at this product's price is always the first choice. You can add up to ${MAX_CALL_LENGTHS - 1} more.`}
      </p>
      {draft.extra.map((row, index) => {
        // Not longer than the call's own length any more (its length was changed above): said on the row, kept until the creator decides.
        const notLonger = row.minutes <= draft.minutes;
        const marked = notLonger || wrong === index + 1;
        const said = [notLonger ? `length-short-${id}-${row.id}` : "", `lengths-price-${id}`].filter(Boolean).join(" ");
        return (
        <div key={row.id} className="mt-3 grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className="field-label">{`Length ${index + 2}`}</span>
            <select id={`length-${id}-${row.id}`} className="field mt-2" value={row.minutes} aria-invalid={marked || undefined} aria-describedby={notLonger ? `length-short-${id}-${row.id}` : undefined} onChange={(e) => setRow(index, { minutes: Number(e.target.value) })}>
              {[row.minutes, ...unused].filter((m, i, all) => all.indexOf(m) === i).sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>{`${m} minutes`}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{`Price for ${row.minutes} minutes`}</span>
            <input
              className="field mt-2"
              inputMode="decimal"
              autoComplete="off"
              required
              value={row.price}
              onChange={(e) => setRow(index, { price: e.target.value })}
              aria-invalid={wrong === index + 1 || undefined}
              aria-describedby={said}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setDraft({ ...draft, extra: draft.extra.filter((_, i) => i !== index) });
              focusSoon(`lengths-hint-${id}`);
            }}
          >
            {`Remove ${row.minutes} minutes`}
          </button>
          {notLonger ? (
            <p id={`length-short-${id}-${row.id}`} className="field-hint font-semibold text-ink sm:col-span-3">
              {`${row.minutes} minutes is not longer than the call's own length of ${draft.minutes} minutes. Pick a longer one, or remove it.`}
            </p>
          ) : null}
        </div>
        );
      })}
      {draft.extra.length ? (
        <p id={`lengths-price-${id}`} className="field-hint mt-2">{`Type each price ${rangeWords(currency)}, like ${priceExample(currency, 80)}.`}</p>
      ) : null}
      {draft.extra.length < MAX_CALL_LENGTHS - 1 && unused.length ? (
        <button
          type="button"
          className="btn btn-secondary mt-3"
          onClick={() => {
            const added = { id: rowId(), minutes: unused[0], price: "" };
            setDraft({ ...draft, extra: [...draft.extra, added] });
            focusSoon(`length-${id}-${added.id}`);
          }}
        >
          Add a length
        </button>
      ) : null}
    </fieldset>
  );
}

/** Selling a product as a paid call: hours or dated sessions, length, seats, and where it happens. */
export function CallEditor({ product, email, meetings = [] }: { product: Product; email: string; meetings?: MeetAccount[] }) {
  const router = useRouter();
  const currency = useStoreCurrency();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(product.call, product.call?.kind ?? "weekly", currency));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The other length the server said is wrong, by its line (1 is the first other one), so the editor marks it.
  const [wrongLength, setWrongLength] = useState<number | null>(null);

  const eligible =
    product.priceCents > 0 &&
    !product.recurring &&
    product.options.length === 0 &&
    !product.file &&
    !product.link &&
    !product.course &&
    // A podcast is refused by the server like a course (lib/store.ts, setProductCall), so it is never offered.
    !product.podcast &&
    // A call is booked at a set price, never a chosen one.
    !product.pwyw;

  async function send(payload: Record<string, unknown>, confirmation: string) {
    setBusy(true);
    setError(null);
    setWrongLength(null);
    try {
      const response = await fetch("/api/store/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; problem?: string; minutes?: number; index?: number };
      if (data.ok) {
        setOpen(false);
        toast(confirmation);
        router.refresh();
        return;
      }
      // The other lengths (lib/call-lengths.ts): what is wrong with them, in the rules' own words.
      if (data.error === "lengths" && data.problem) {
        // Line 0 is the call's own length at this product's price, which is not typed here.
        if (data.index === 0 && data.problem === "price") setError(OWN_PRICE);
        else setError(data.problem === "shorter" ? SHORTER_LENGTH : lengthsProblemWords(data.problem as LengthsProblem, currency, data.minutes));
        if (typeof data.index === "number" && data.index > 0) setWrongLength(data.index);
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  function setRange(day: number, index: number, part: 0 | 1, text: string) {
    const typed = fromClock(text);
    if (typed === null) return;
    // Hours move in steps of five minutes, and a day's last minute means its end.
    const minutes = part === 1 && typed === 1439 ? 1440 : Math.round(typed / 5) * 5;
    const weekly = draft.weekly.map((ranges) => ranges.map((r) => [r[0], r[1]] as Range));
    weekly[day][index][part] = minutes;
    setDraft({ ...draft, weekly });
  }

  function setSession(index: number, change: Partial<SessionDraft>) {
    const sessions = draft.sessions.map((s, i) => (i === index ? { ...s, ...change } : s));
    setDraft({ ...draft, sessions });
  }

  if (!product.call && !open) {
    if (!eligible) return null;
    return (
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        <button
          type="button"
          onClick={() => {
            setDraft(toDraft(null, "weekly", currency));
            setOpen(true);
          }}
          className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
        >
          Sell this as a paid booking with a calendar: a call, or a time at your address
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(toDraft(null, "live", currency));
            setOpen(true);
          }}
          className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
        >
          Sell seats in live sessions on set dates
        </button>
      </div>
    );
  }

  if (product.call && !open) {
    const setup = product.call;
    const live = setup.kind === "live";
    const coming = live ? upcomingSessions(setup) : [];
    return (
      <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
        {live ? (
          <>
            <p className="text-sm font-semibold text-ink">
              {`Live sessions · ${coming.length} coming up · ${setup.tz}`}
            </p>
            {coming.length ? (
              <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                {coming.slice(0, 5).map((s) => (
                  <li key={s.id} className="break-words">
                    <span className="font-semibold text-ink">{sessionWhen(s.start, setup.tz)}</span>
                    {` · ${sessionLength(s.minutes)} · ${s.seats} ${s.seats === 1 ? "seat" : "seats"}${s.room || setup.video || setup.meet || setup.place ? "" : " · no meeting link yet"}`}
                  </li>
                ))}
                {coming.length > 5 ? <li>{`and ${coming.length - 5} more`}</li> : null}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-ink-soft">No sessions to come. Add one so buyers have something to book.</p>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              {setup.noticeHours === 0
                ? "On sale until each session starts."
                : `Sales close ${hoursLabel(setup.noticeHours)} before each session.`}
            </p>
            {setup.place ? (
              <p className="mt-1 break-words text-sm text-ink-soft">{`In person, at: ${placeLine(setup.place)}`}</p>
            ) : setup.meet ? (
              <p className="mt-1 text-sm text-ink-soft">{`A ${MEET_NAMES[setup.meet]} meeting is made for each session, shared by everyone booked into it.`}</p>
            ) : setup.video ? (
              <p className="mt-1 text-sm text-ink-soft">A private video room is made for each session, shared by everyone booked into it.</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-ink">
              {setup.place
                ? `In person · ${setup.minutes} minutes${setup.seats > 1 ? ` · up to ${setup.seats} people` : ""} · ${setup.tz}`
                : setup.seats > 1
                  ? `Group call · ${setup.minutes} minutes · up to ${setup.seats} people · ${setup.tz}`
                  : `Paid call · ${setup.lengths?.length ? setup.lengths.map((l) => l.minutes).join(", ") : setup.minutes} minutes · ${setup.tz}`}
            </p>
            {setup.lengths?.length && setup.lengths[0].cents !== product.priceCents ? (
              // The price changed since the lengths were saved: only the call's own length sells (lib/call-lengths.ts, bookingLength).
              <p className="mt-1 text-sm font-semibold text-ink" role="status">{"You changed this product's price after setting the other lengths, so only the first length is on sale. Open the hours and save them again to offer the others."}</p>
            ) : null}
            <p className="mt-1 text-sm text-ink-soft">{summarise(setup)}</p>
            <p className="mt-1 text-sm text-ink-soft">
              {`At least ${setup.noticeHours === 1 ? "1 hour's" : `${setup.noticeHours} hours'`} notice, up to ${setup.horizonDays} days ahead${setup.bufferMinutes ? `, ${setup.bufferMinutes} minutes between calls` : ""}.`}
            </p>
            <p className={`mt-1 text-sm text-ink-soft ${setup.place ? "break-words" : "break-all"}`}>
              {setup.place
                ? `In person, at: ${placeLine(setup.place)}`
                : setup.meet
                ? setup.seats > 1
                  ? `A ${MEET_NAMES[setup.meet]} meeting is made for each time, shared by everyone booked into it.`
                  : `A ${MEET_NAMES[setup.meet]} meeting is made for each booking.`
                : setup.video
                ? setup.seats > 1
                  ? "A private video room is made for each time, shared by everyone booked into it."
                  : "A private video room is made for each booking."
                : setup.room
                  ? `Meeting link: ${setup.room}`
                  : "No meeting link: you send one to each buyer yourself."}
            </p>
          </>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold">
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(setup, setup.kind, currency));
              setOpen(true);
            }}
            className="inline-flex min-h-11 -my-2.5 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
          >
            {live ? "Change the sessions" : "Change the hours"}
          </button>
          <button
            type="button"
            aria-busy={busy} disabled={busy}
            onClick={() => send({ id: product.id, remove: true }, live ? "It's no longer sold as live sessions." : "It's no longer sold as a call.")}
            className="inline-flex min-h-11 -my-2.5 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger"
          >
            {live ? "Stop selling it as live sessions" : "Stop selling it as a call"}
          </button>
        </div>
        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      </div>
    );
  }

  const zoneList = zones();
  const zoneOptions = (zoneList.includes(draft.tz) ? zoneList : [draft.tz, ...zoneList]).map((z) => (
    <option key={z} value={z}>{z}</option>
  ));
  const saved = product.call !== null;

  if (draft.kind === "live") {
    return (
      <form
        className="mt-3 space-y-5 rounded-[var(--r-sm)] border border-line bg-white p-4"
        onSubmit={(event) => {
          event.preventDefault();
          // In person with no address: said here, never saved as a call with no link (lib/call-place.ts).
          if (draft.inPerson && !draft.place.trim()) {
            setError(MESSAGES.place);
            return;
          }
          send(
            {
              id: product.id,
              call: {
                kind: "live",
                tz: draft.tz,
                noticeHours: draft.noticeHours,
                video: draft.video,
                meet: draft.meet,
                ...(draft.inPerson ? { place: draft.place } : {}),
                ...(draft.cancelHours ? { cancelHours: draft.cancelHours } : {}),
                sessions: draft.sessions.map((s) => ({
                  id: s.id,
                  date: s.date,
                  time: s.time,
                  minutes: s.minutes,
                  seats: Number(s.seats),
                  room: s.room.trim(),
                })),
              },
            },
            saved ? "Sessions saved." : "It's now sold as live sessions.",
          );
        }}
      >
        <div>
          <p className="font-semibold text-ink">Live sessions</p>
          <p className="mt-1 text-sm text-ink-soft">
            A webinar, workshop or class on dates you choose. Each buyer pays for one seat in one session.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Your time zone</span>
            <select className="field mt-2" value={draft.tz} onChange={(e) => setDraft({ ...draft, tz: e.target.value })}>
              {zoneOptions}
            </select>
          </label>
          <label className="block">
            <span className="field-label">Sales close</span>
            <select className="field mt-2" value={draft.noticeHours} onChange={(e) => setDraft({ ...draft, noticeHours: Number(e.target.value) })}>
              {SESSION_NOTICE_CHOICES.map((h) => (
                <option key={h} value={h}>{h === 0 ? "When the session starts" : `${hoursLabel(h)} before`}</option>
              ))}
            </select>
          </label>
        </div>

        <CancelChoice value={draft.cancelHours} onChange={(cancelHours) => setDraft({ ...draft, cancelHours })} />

        <RoomChoice
          where={whereOf(draft)}
          live
          meetings={meetings}
          onChange={(where) => setDraft(choose(draft, where))}
          place={draft.place}
          onPlace={(place) => setDraft({ ...draft, place })}
          placeId={`call-${product.id}-place`}
          placeInvalid={error === MESSAGES.place}
        />

        <fieldset className="min-w-0">
          <legend className="field-label">Sessions, in your time zone</legend>
          <ol className="mt-2 space-y-3">
            {draft.sessions.map((s, index) => (
              <li key={s.id} className="rounded-[10px] bg-paper p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">{`Session ${index + 1}`}</span>
                  {draft.sessions.length > 1 ? (
                    <button
                      type="button"
                      aria-label={`Remove session ${index + 1}`}
                      onClick={() => setDraft({ ...draft, sessions: draft.sessions.filter((_, i) => i !== index) })}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none text-ink-mute transition hover:bg-white hover:text-danger"
                    >
                      &times;
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <label className="col-span-2 block sm:col-span-1">
                    <span className="text-xs font-semibold text-ink-soft">Date</span>
                    <input
                      type="date"
                      required
                      value={s.date}
                      onChange={(e) => setSession(index, { date: e.target.value })}
                      className="field mt-1 !min-h-0 !py-1.5"
                    />
                  </label>
                  <label className="col-span-2 block sm:col-span-1">
                    <span className="text-xs font-semibold text-ink-soft">Starts</span>
                    <input
                      type="time"
                      step={300}
                      required
                      value={s.time}
                      onChange={(e) => setSession(index, { time: e.target.value })}
                      className="field mt-1 !min-h-0 !py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-soft">Length</span>
                    <select
                      value={s.minutes}
                      onChange={(e) => setSession(index, { minutes: Number(e.target.value) })}
                      className="field mt-1 !min-h-0 !py-1.5 !pl-3"
                    >
                      {SESSION_LENGTHS.map((m) => (
                        <option key={m} value={m}>{`${m} min`}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-soft">Seats</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_SESSION_SEATS}
                      step={1}
                      required
                      value={s.seats}
                      onChange={(e) => setSession(index, { seats: e.target.value })}
                      className="field mt-1 !min-h-0 !py-1.5"
                    />
                  </label>
                  {draft.video || draft.inPerson ? null : (
                    <div className="col-span-2 block sm:col-span-4">
                      <label htmlFor={`call-${product.id}-session-${index}-room`} className="text-xs font-semibold text-ink-soft">{draft.meet ? "Your own link, if the meeting cannot be made (optional)" : "Meeting link"}</label>
                      <UrlField
                        id={`call-${product.id}-session-${index}-room`}
                        placeholder="https://zoom.us/j/… or https://meet.google.com/…"
                        value={s.room}
                        onChange={(room) => setSession(index, { room })}
                        check={SESSION_ROOM_CHECK}
                        className="field mt-1 !min-h-0 !py-1.5"
                      />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {draft.sessions.length < MAX_SESSIONS ? (
            <button
              type="button"
              onClick={() => setDraft({ ...draft, sessions: [...draft.sessions, newSession(draft.tz, draft.sessions[draft.sessions.length - 1])] })}
              className="mt-3 inline-flex min-h-11 -my-2.5 items-center text-sm font-semibold text-violet-deep underline underline-offset-4"
            >
              Add a session
            </button>
          ) : null}
        </fieldset>

        <p className="rounded-[10px] bg-paper px-3 py-2 text-sm text-ink-soft">
          {`A session is on sale until it is full or sales close. Each buyer gets the session's link, or a note that you will send it, and a calendar file the moment they have paid. You get one email per booking, without the file when the session is already in your Google Calendar. You and the buyers get reminders a day and an hour before, listing everyone in yours. A reminder that would come less than an hour after the booking is skipped. Buyers can move their seat to another session themselves, twice at most, until ${hoursLabel(Math.max(draft.noticeHours, 1))} before it starts. Replies to their emails go to ${email}.`}
        </p>

        {error ? <p className="notice notice-error" role="alert">{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">
            {busy ? "Saving…" : saved ? "Save the sessions" : "Sell seats in these sessions"}
          </button>
          <button type="button" onClick={() => { setOpen(false); setError(null); }} className="btn btn-ghost">
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="mt-3 space-y-5 rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // In person with no address: said here, never saved as a call with no link (lib/call-place.ts).
        if (draft.inPerson && !draft.place.trim()) {
          setError(MESSAGES.place);
          return;
        }
        send(
          {
            id: product.id,
            call: {
              kind: "weekly",
              minutes: draft.minutes,
              tz: draft.tz,
              weekly: draft.weekly,
              noticeHours: draft.noticeHours,
              horizonDays: draft.horizonDays,
              bufferMinutes: draft.bufferMinutes,
              room: draft.room.trim(),
              video: draft.video,
              meet: draft.meet,
              ...(draft.inPerson ? { place: draft.place } : {}),
              ...(draft.cancelHours ? { cancelHours: draft.cancelHours } : {}),
              seats: Number(draft.seats),
            },
            // The other lengths, one person a time only; the server checks each against the store's currency and rules.
            lengths: Number(draft.seats) === 1 ? draft.extra.map((row) => ({ minutes: row.minutes, price: row.price })) : [],
          },
          saved ? "Hours saved." : "It's now sold as a paid booking.",
        );
      }}
    >
      <p className="font-semibold text-ink">Paid call</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="field-label">How long</span>
          <select
            className="field mt-2"
            value={draft.minutes}
            onChange={(e) => setDraft({ ...draft, minutes: Number(e.target.value) })}
          >
            {CALL_LENGTHS.map((m) => (
              <option key={m} value={m}>{`${m} minutes`}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">People per time</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SEATS}
            step={1}
            required
            value={draft.seats}
            onChange={(e) => setDraft({ ...draft, seats: e.target.value })}
            aria-describedby={`seats-hint-${product.id}`}
            className="field mt-2"
          />
        </label>
        <label className="block">
          <span className="field-label">Your time zone</span>
          <select className="field mt-2" value={draft.tz} onChange={(e) => setDraft({ ...draft, tz: e.target.value })}>
            {zoneOptions}
          </select>
        </label>
        <p id={`seats-hint-${product.id}`} className="field-hint sm:col-span-3">
          {`1 is a one-to-one call. Up to ${MAX_SEATS} makes it a group call: each time stays open until every seat is taken, and each person pays for their own seat.`}
        </p>
      </div>

      {Number(draft.seats) === 1 ? (
        <OtherLengths draft={draft} setDraft={setDraft} currency={currency} id={product.id} wrong={wrongLength} />
      ) : draft.extra.length ? (
        // A group shares one time, so it has one length: said before saving, never dropped in silence.
        <p className="field-hint font-semibold text-ink" role="status">
          {`A group call has one length. Saving it as a group removes the other lengths: ${draft.extra.map((row) => `${row.minutes} minutes`).join(", ")}.`}
        </p>
      ) : null}

      <fieldset>
        <legend className="field-label">When people can book, in your time zone</legend>
        <div className="mt-2 space-y-2">
          {DAY_NAMES.map((name, day) => {
            const ranges = draft.weekly[day];
            const on = ranges.length > 0;
            return (
              <div key={name} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] bg-paper px-3 py-2">
                <label className="flex w-32 items-center gap-2 text-sm font-semibold text-ink">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const weekly = draft.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                      weekly[day] = on ? [] : [[540, 1020]];
                      setDraft({ ...draft, weekly });
                    }}
                    className="h-4 w-4 accent-violet-brand"
                  />
                  {name}
                </label>
                {on ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      Each pair of clocks wraps on a narrow phone: two time
                      fields, the word between them and the row's own padding
                      do not fit across 320px, and a clock the creator cannot
                      reach is worse than one that takes a second line.
                    */}
                    {ranges.map((range, index) => (
                      <span key={index} className="flex flex-wrap items-center gap-1.5 text-sm text-ink-soft">
                        <input
                          type="time"
                          step={300}
                          aria-label={`${name}, stretch ${index + 1}, from`}
                          value={clock(range[0])}
                          onChange={(e) => setRange(day, index, 0, e.target.value)}
                          className="field !min-h-0 w-[7.5rem] !py-1.5"
                        />
                        to
                        <input
                          type="time"
                          step={300}
                          aria-label={`${name}, stretch ${index + 1}, to`}
                          value={clock(range[1] === 1440 ? 1439 : range[1])}
                          onChange={(e) => setRange(day, index, 1, e.target.value)}
                          className="field !min-h-0 w-[7.5rem] !py-1.5"
                        />
                        {index > 0 ? (
                          <button
                            type="button"
                            aria-label={`Remove ${name}'s second stretch`}
                            onClick={() => {
                              const weekly = draft.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                              weekly[day] = weekly[day].slice(0, 1);
                              setDraft({ ...draft, weekly });
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none text-ink-mute transition hover:bg-white hover:text-danger"
                          >
                            &times;
                          </button>
                        ) : null}
                      </span>
                    ))}
                    {ranges.length < MAX_RANGES_PER_DAY ? (
                      <button
                        type="button"
                        onClick={() => {
                          const weekly = draft.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                          const end = weekly[day][0][1];
                          weekly[day].push([Math.min(end + 60, 1380), Math.min(end + 180, 1440)]);
                          setDraft({ ...draft, weekly });
                        }}
                        className="text-sm font-semibold text-violet-deep underline underline-offset-4"
                      >
                        Add a second stretch
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-sm text-ink-mute">Not available</span>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="field-label">Notice you need</span>
          <select className="field mt-2" value={draft.noticeHours} onChange={(e) => setDraft({ ...draft, noticeHours: Number(e.target.value) })}>
            {NOTICE_CHOICES.map((h) => (
              <option key={h} value={h}>{hoursLabel(h)}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Book up to</span>
          <select className="field mt-2" value={draft.horizonDays} onChange={(e) => setDraft({ ...draft, horizonDays: Number(e.target.value) })}>
            {HORIZON_CHOICES.map((d) => (
              <option key={d} value={d}>{`${d} days ahead`}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Gap between calls</span>
          <select className="field mt-2" value={draft.bufferMinutes} onChange={(e) => setDraft({ ...draft, bufferMinutes: Number(e.target.value) })}>
            {BUFFERS.map((b) => (
              <option key={b} value={b}>{b === 0 ? "None" : `${b} minutes`}</option>
            ))}
          </select>
        </label>
      </div>

      <CancelChoice value={draft.cancelHours} onChange={(cancelHours) => setDraft({ ...draft, cancelHours })} />

      <RoomChoice
        where={whereOf(draft)}
        live={false}
        meetings={meetings}
        onChange={(where) => setDraft(choose(draft, where))}
        place={draft.place}
        onPlace={(place) => setDraft({ ...draft, place })}
        placeId={`call-${product.id}-place`}
        placeInvalid={error === MESSAGES.place}
      >
        <div className="mt-3 block">
          <label htmlFor={`call-${product.id}-room`} className="field-label">{draft.meet ? "Your own link, if the meeting cannot be made (optional)" : "Meeting link"}</label>
          <UrlField
            id={`call-${product.id}-room`}
            placeholder="https://zoom.us/j/… or https://meet.google.com/…"
            value={draft.room}
            onChange={(room) => setDraft({ ...draft, room })}
            check={ROOM_CHECK}
            describedBy={`call-${product.id}-room-help`}
            className="field mt-2"
          />
          <span id={`call-${product.id}-room-help`} className="field-hint mt-1 block">
            {draft.meet
              ? "Given to a buyer only when the meeting cannot be made. Leave it empty to give them a private video room instead."
              : "Your Zoom, Google Meet or Whereby room. Each buyer gets it the moment they have paid. Leave it empty to send one yourself."}
          </span>
        </div>
      </RoomChoice>

      <p className="rounded-[10px] bg-paper px-3 py-2 text-sm text-ink-soft">
        {`When someone books, it shows under Upcoming calls in your studio. The buyer gets an email with a calendar file. You get one too, or the host does on a team call. If the call is already in that person's Google Calendar, their email has no file. You and the buyer get reminders a day and an hour before. A reminder that would come less than an hour after the booking is skipped. On a team call, your reminders still come to you. Buyers can move their booking to another open time themselves, twice at most, up to your notice before it starts. A buyer can reply to their email to reach you, and the reply goes to ${email}.`}
      </p>

      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">
          {busy ? "Saving…" : saved ? "Save the hours" : "Sell these hours"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The creator's cancellation deadline (lib/call-setup.ts, cancelHours): what
 * buyers are told before paying, on Stripe's page and in their confirmation.
 * The refund it promises is the creator's to make.
 */
function CancelChoice({ value, onChange }: { value: number; onChange: (hours: number) => void }) {
  const help = useId();
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="field-label">Cancellation deadline</label>
      <select id={id} className="field mt-2" value={value} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={help}>
        <option value={0}>None: buyers cancel by replying, and you decide</option>
        {CANCEL_HOURS.map((h) => (
          <option key={h} value={h}>{`At least ${h} hours before`}</option>
        ))}
      </select>
      <p id={help} className="mt-1 text-sm text-ink-soft">
        {value
          ? `Buyers are told before paying: cancel at least ${value} hours before, by replying, and you refund what they paid online; if they cancel later or miss it, you do not have to; if you cancel, they get it all back. You make the refund in your Stripe dashboard. A change applies to new bookings only.`
          : "Buyers are told to cancel by replying to their confirmation, and you decide."}
      </p>
    </div>
  );
}
