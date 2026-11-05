"use client";

import { useState, useSyncExternalStore } from "react";
import { CodeField, type CodeWords } from "@/components/slot-picker";

const noop = () => () => {};

function dateParts(ms: number, tz: string, locale: string) {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...o }).format(new Date(ms));
  return { weekday: f({ weekday: "short" }), day: f({ day: "numeric" }), month: f({ month: "short" }) };
}

function timeRange(start: number, end: number, tz: string, locale: string): string {
  const f = (ms: number) => new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return `${f(start)} – ${f(end)}`;
}

function zoneLabel(ms: number, tz: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

export type SessionChoice = { start: number; end: number; minutes: number; seats: number; left: number };

/**
 * What the picker says, in the store's language (lib/buyer-words/booking.ts),
 * already said for this page by the server.
 */
export type SessionWords = {
  /** How times and dates are written (Intl). */
  locale: string;
  pickSession: string;
  noneTitle: string;
  noneBody: string;
  /** "Times are in your time zone, {zone}.", with {zone} where the zone goes. */
  yours: string;
  creators: string;
  /** Under each session, by its start: "90 min · 3 of 10 seats left". */
  details: Record<string, string>;
  submit: string;
  note: string;
  /** A session with a deposit: the field for a discount code, off the whole price (lib/deposit-code.ts). */
  code?: CodeWords;
};

/**
 * The dated live sessions a buyer may take a seat in, shown in the buyer's
 * own time zone, soonest first.
 *
 * Like the slot picker, it is a plain form of radio buttons: drawn first in
 * the creator's zone, which is all the server knows, and redrawn in the
 * buyer's once the browser says which that is. Only sessions still on sale
 * with a seat left reach it. Given `move`, it moves a booking instead.
 */
export function SessionPicker({
  sessions,
  creatorTz,
  handle,
  productId,
  move,
  words,
}: {
  sessions: SessionChoice[];
  creatorTz: string;
  handle: string;
  productId: string;
  move?: string;
  words: SessionWords;
}) {
  const { locale } = words;
  const tz = useSyncExternalStore(
    noop,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || creatorTz,
    () => creatorTz,
  );
  const local = useSyncExternalStore(noop, () => true, () => false);
  const [chosen, setChosen] = useState<number | null>(sessions.length === 1 ? sessions[0].start : null);

  if (sessions.length === 0) {
    return (
      <div className="st-note mt-6 text-center">
        <p className="font-bold" style={{ color: "var(--st-text)" }}>{words.noneTitle}</p>
        <p className="mt-1 text-sm">{words.noneBody}</p>
      </div>
    );
  }

  return (
    <form action={move ? "/api/store/book/move" : "/api/store/book"} method="post" target="_top" className="mt-6" {...(move ? {} : { "data-checkout": "" })}>
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="product" value={productId} />
      <input type="hidden" name="tz" value={tz} />
      {move ? <input type="hidden" name="session" value={move} /> : null}

      <fieldset className="min-w-0">
        <legend className="st-label">{words.pickSession}</legend>
        <div className="mt-3 space-y-2">
          {sessions.map((session) => {
            const d = dateParts(session.start, tz, locale);
            return (
              <label key={session.start} className="st-option !justify-start !gap-4 !py-3">
                <input
                  type="radio"
                  name="start"
                  value={session.start}
                  required
                  className="sr-only"
                  checked={chosen === session.start}
                  onChange={() => setChosen(session.start)}
                />
                <span
                  aria-hidden="true"
                  className="flex w-14 shrink-0 flex-col items-center rounded-xl py-1.5"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wide">{d.month}</span>
                  <span className="text-xl font-semibold leading-tight tabular-nums">{d.day}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold tabular-nums">{`${d.weekday}, ${timeRange(session.start, session.end, tz, locale)}`}</span>
                  <span className="st-muted block text-sm">{words.details[String(session.start)] ?? ""}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="st-muted mt-3 text-sm">
          {(local ? words.yours : words.creators).replace("{zone}", zoneLabel(sessions[0].start, tz, locale))}
        </p>
      </fieldset>

      {words.code && !move ? <CodeField words={words.code} /> : null}

      <div className="mt-6">
        <button type="submit" className="btn st-btn btn-lg btn-block">
          {words.submit}
        </button>
        <p className="st-muted mt-3 text-center text-xs">{words.note}</p>
      </div>
    </form>
  );
}
