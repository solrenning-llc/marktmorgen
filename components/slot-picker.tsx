"use client";

import { useId, useMemo, useState, useSyncExternalStore } from "react";

const noop = () => () => {};

function dayKey(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return p;
}

function dayLabel(ms: number, tz: string, locale: string) {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...o }).format(new Date(ms));
  return { weekday: f({ weekday: "short" }), day: f({ day: "numeric" }), month: f({ month: "short" }) };
}

function timeLabel(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function longLabel(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function zoneLabel(ms: number, tz: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

/**
 * What the picker says, in the store's language (lib/buyer-words/booking.ts),
 * already said for this page by the server: whether it moves a booking, books
 * from a package or goes to payment is known there.
 */
export type SlotWords = {
  /** How times and dates are written (Intl). */
  locale: string;
  pickDay: string;
  pickTime: string;
  noneTitle: string;
  noneBody: string;
  /** "Times are in your time zone, {zone}.", with {zone} where the zone goes. */
  yours: string;
  creators: string;
  /** After the time picked: " · 30 minutes". */
  chosen: string;
  submit: string;
  note: string;
  /** A booking with a deposit: the field for a discount code, off the whole price (lib/deposit-code.ts). */
  code?: CodeWords;
};

/** The discount code field's label and help, in the store's language. */
export type CodeWords = { label: string; help: string };

/**
 * A discount code typed on the booking page, for a booking with a deposit
 * only (lib/deposit-code.ts): optional, labeled, with its help read with it.
 * Sent with the form; the server reads it from the creator's own account.
 */
export function CodeField({ words }: { words: CodeWords }) {
  const id = useId();
  return (
    <div className="mt-6">
      <label htmlFor={id} className="field-label">{words.label}</label>
      <input
        id={id}
        name="code"
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={40}
        className="st-field mt-1"
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="st-muted mt-1 text-sm">{words.help}</p>
    </div>
  );
}

/**
 * The times a buyer may book, shown in the buyer's own time zone.
 *
 * The page is first drawn in the creator's zone — which is all the server can
 * know — and redrawn in the buyer's as soon as the browser says which that is.
 * The times are radio buttons inside a plain form, so the first day's times
 * can still be booked with JavaScript turned off, in the creator's zone and
 * said so.
 *
 * The same picker moves a booking: given `move`, the form goes to the move
 * route with the checkout session, and says nothing about paying.
 */
export function SlotPicker({
  starts,
  creatorTz,
  handle,
  productId,
  seatsLeft,
  move,
  pkg,
  host,
  minutes,
  words,
}: {
  starts: number[];
  creatorTz: string;
  handle: string;
  productId: string;
  /** For a group call: the seats left at each time, by start, already said ("3 seats left"). */
  seatsLeft?: Record<string, string>;
  /** The checkout session of a booking being moved. */
  move?: string;
  /** A package's booking token: the session comes from it, and nothing is charged (lib/call-packages.ts). */
  pkg?: string;
  /** The host the buyer chose, on a team that lets them (lib/team-scheduling-rules.ts): sent so only they are booked. */
  host?: { key: string; label: string } | null;
  /** On a call with several lengths: the one chosen, in minutes, sent so it is booked and charged (lib/call-lengths.ts). */
  minutes?: number;
  words: SlotWords;
}) {
  const { locale } = words;
  const tz = useSyncExternalStore(
    noop,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || creatorTz,
    () => creatorTz,
  );
  // True once the browser has said which zone it is in.
  const local = useSyncExternalStore(noop, () => true, () => false);

  const days = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const start of starts) {
      const key = dayKey(start, tz);
      const list = map.get(key) ?? [];
      list.push(start);
      map.set(key, list);
    }
    return [...map.entries()].map(([key, list]) => ({ key, starts: list.sort((a, b) => a - b) }));
  }, [starts, tz]);

  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const day = days.find((d) => d.key === chosenDay) ?? days[0];

  if (days.length === 0) {
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
      {move ? <input type="hidden" name="session" value={move} /> : null}
      <input type="hidden" name="product" value={productId} />
      <input type="hidden" name="tz" value={tz} />
      {pkg ? <input type="hidden" name="pkg" value={pkg} /> : null}
      {minutes && !move ? <input type="hidden" name="minutes" value={minutes} /> : null}
      {host && !move ? (
        <>
          <input type="hidden" name="host" value={host.key} />
          <input type="hidden" name="host_label" value={host.label} />
        </>
      ) : null}

      {/* A fieldset is as wide as its widest child unless told otherwise,
          which would push the row of days out of the card. */}
      <fieldset className="min-w-0">
        <legend className="st-label">{words.pickDay}</legend>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: "thin" }}>
          {days.map((d) => {
            const label = dayLabel(d.starts[0], tz, locale);
            const active = d.key === day.key;
            return (
              <button
                key={d.key}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setChosenDay(d.key);
                  setChosen(null);
                }}
                className="st-option shrink-0 flex-col !gap-0 px-3 py-2 text-center"
                style={active ? { borderColor: "var(--st-accent-text)", background: "var(--st-accent-soft)" } : undefined}
              >
                <span className="st-muted text-xs font-semibold uppercase tracking-wide">{label.weekday}</span>
                <span className="text-xl font-semibold leading-tight">{label.day}</span>
                <span className="st-muted text-xs">{label.month}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mt-5 min-w-0">
        <legend className="st-label">{words.pickTime}</legend>
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {day.starts.map((start) => {
            const seats = seatsLeft?.[String(start)];
            return (
              <label
                key={start}
                className="st-option cursor-pointer flex-col justify-center !gap-0 !px-2 !py-2.5 text-center font-semibold tabular-nums"
              >
                <input
                  type="radio"
                  name="start"
                  value={start}
                  required
                  className="sr-only"
                  checked={chosen === start}
                  onChange={() => setChosen(start)}
                />
                {timeLabel(start, tz, locale)}
                {seats !== undefined ? <span className="st-muted text-xs font-normal">{seats}</span> : null}
              </label>
            );
          })}
        </div>
        <p className="st-muted mt-3 text-sm">
          {(local ? words.yours : words.creators).replace("{zone}", zoneLabel(day.starts[0], tz, locale))}
        </p>
      </fieldset>

      {words.code && !move && !pkg ? <CodeField words={words.code} /> : null}

      <div className="mt-6">
        {chosen ? (
          <p className="mb-3 rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }} role="status">
            <strong>{longLabel(chosen, tz, locale)}</strong>
            {words.chosen}
          </p>
        ) : null}
        <button type="submit" className="btn st-btn btn-lg btn-block">
          {words.submit}
        </button>
        <p className="st-muted mt-3 text-center text-xs">{words.note}</p>
      </div>
    </form>
  );
}
