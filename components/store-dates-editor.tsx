"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import {
  MAX_DATE_MESSAGE,
  MAX_DATE_NAME,
  MAX_DATE_SUBJECT,
  MAX_STORE_DATES,
  MONTH_DAYS,
  MONTH_NAMES,
  STORE_DATE_WINDOW_DAYS,
  type StoreDates,
  dateKey,
  dayIn,
  dayWords,
  nextDay,
} from "@/lib/store-dates-rules";
import { hasPlaceholder } from "@/lib/mail-body";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** What happened to a date's email the last time it was due (lib/store-dates-send.ts, DateResult). */
export type DateResultView = { year: number; outcome: string; total: number };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  many: `A store can keep at most ${MAX_STORE_DATES} dates.`,
  date: "Choose a day that exists in that month.",
  twice: "Two dates are on the same day. Keep one email for each day.",
  leap: "February 29 comes on March 1 in most years, so it cannot be kept together with March 1. Keep one of them.",
  name: "Give this date a name, like \"Store birthday\". Only you see it.",
  subject: "Write the subject line of this date's email.",
  message: "Write the email for this date.",
  placeholder: "This email still has a part to write, marked like ⟦this⟧. Replace it with your own words.",
  empty: "Add a date before you turn this on.",
  setup: "Set up your list email first: your sender name and your postal address go at the bottom of every email.",
  plan: "Your plan does not include email right now, so these emails cannot go out.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm whether your dates were saved. Reload this page to check before trying again.",
};

/** Why a date's email was not made, in words: "Not sent on November 6, 2026: …". */
const WHY: Record<string, string> = {
  allowance: "too few of this month's emails were left for everyone on your list.",
  studio: "this month's studio requests were used up.",
  setup: "your list email was not set up.",
  plan: "your plan did not include email.",
  empty: "nobody on your list could be written to.",
  room: "your store's data room was full.",
  error: "it could not be made.",
  waiting: "too many stores' emails were due at once, and it could not be made within a week.",
};

type Row = { id: number; name: string; month: number; day: number; subject: string; message: string };
type Field = "name" | "day" | "subject" | "message";
/** Which field a refusal of the server is about, for a refusal that names a date. */
function fieldOf(reason: string, row: Row | undefined): Field | null {
  if (reason === "name") return "name";
  if (reason === "subject") return "subject";
  if (reason === "message") return "message";
  if (reason === "placeholder") return row && hasPlaceholder(row.subject) ? "subject" : "message";
  if (reason === "date" || reason === "twice" || reason === "leap") return "day";
  return null;
}
const DAY_MS = 86_400_000;

/** The store's own dates, each with its email, once a year (lib/store-dates-rules.ts, lib/store-dates-send.ts; 283 [HG2] unit 2). */
export function StoreDatesEditor({
  setting,
  results,
  mailReady,
  emailInPlan,
  now,
}: {
  setting: StoreDates;
  /** By the date's key (lib/store-dates-rules.ts, dateKey). */
  results: Record<string, DateResultView>;
  /** The list email is set up: sender name and postal address. */
  mailReady: boolean;
  /** The plan includes email. */
  emailInPlan: boolean;
  /** The server's time, so the page and the server say the same next day. */
  now: number;
}) {
  const router = useRouter();
  const [on, setOn] = useState(setting.on);
  const [rows, setRows] = useState<Row[]>(() => setting.dates.map((d, i) => ({ id: i, name: d.name, month: d.month, day: d.day, subject: d.subject, message: d.message })));
  const [nextId, setNextId] = useState(setting.dates.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The field a refusal is about: marked invalid, with the reason under it. */
  const [fieldError, setFieldError] = useState<{ id: number; field: Field; text: string } | null>(null);
  /** The last date removed before saving, with where it was, so it can be put back. */
  const [removed, setRemoved] = useState<{ row: Row; index: number } | null>(null);

  const change = (id: number, patch: Partial<Row>) =>
    setRows((list) =>
      list.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...patch };
        // A month with fewer days keeps a day it has.
        return { ...next, day: Math.min(next.day, MONTH_DAYS[next.month - 1]) };
      }),
    );

  function add() {
    if (rows.length >= MAX_STORE_DATES) return;
    setRows((list) => [...list, { id: nextId, name: "", month: 1, day: 1, subject: "", message: "" }]);
    setNextId((id) => id + 1);
  }

  function remove(row: Row, index: number) {
    setRows((list) => list.filter((r) => r.id !== row.id));
    setRemoved({ row, index });
    if (fieldError?.id === row.id) setFieldError(null);
  }

  function undoRemove() {
    if (!removed) return;
    setRows((list) => [...list.slice(0, removed.index), removed.row, ...list.slice(removed.index)]);
    setRemoved(null);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const dates = rows.map(({ name, month, day, subject, message }) => ({ name, month, day, subject, message }));
      const response = await fetch("/api/store/store-dates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, dates }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const saved = data.storeDates && typeof data.storeDates === "object" && !Array.isArray(data.storeDates) ? (data.storeDates as Record<string, unknown>) : {};
      const savedDays = Array.isArray(saved.dates) ? (saved.dates as Record<string, unknown>[]).map((d) => `${d.month}-${d.day}`).sort() : null;
      const askedDays = rows.map((r) => `${r.month}-${r.day}`).sort();
      if (response.ok && data.ok === true && data.error === undefined && saved.on === on && savedDays !== null && savedDays.join() === askedDays.join()) {
        toast("Store dates saved.");
        setRemoved(null);
        router.refresh();
        return;
      }
      const reason = typeof data.error === "string" ? data.error : "";
      const known = !response.ok && data.ok === false && Object.prototype.hasOwnProperty.call(MESSAGES, reason);
      const index = typeof data.index === "number" && Number.isInteger(data.index) && data.index >= 0 && data.index < rows.length ? data.index : null;
      const which = index !== null ? `Date ${index + 1}: ` : "";
      const field = known && index !== null ? fieldOf(reason, rows[index]) : null;
      if (field && index !== null) setFieldError({ id: rows[index].id, field, text: MESSAGES[reason] });
      setError(known ? `${which}${MESSAGES[reason]}` : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const bullets = [
    "Pick a few days of the year that matter to your store, like the day it opened. On each one, every year, your list gets the email you write here.",
    "It goes to everyone on your list who agreed to hear from you and is still on it. Never to somebody who left your list, whose email bounced or who marked your email as spam.",
    "Each person gets it once for each date, each year. It is made around 9:00 in the morning, UTC, on that day, and you can follow it under Sent and scheduled in Email.",
    `On a day many stores' dates fall on, like January 1, it can be made on one of the following mornings instead, up to ${STORE_DATE_WINDOW_DAYS} days after the day. This page says when it is waiting its turn, and why if it was not sent.`,
    "A date you add on its own day goes out at the next run: if that morning's run is over, the next morning.",
    "Making it uses one studio request, and each email counts toward your store's emails for the month. If too few are left for your whole list, it is not made, and this page says so.",
    "It carries your list email's footer: why they get it, a one-click way off your list and your postal address. We never ask anyone for a birth date.",
  ];

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="store-dates-title" data-store-dates-editor aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="store-dates-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Email your list on your store&apos;s own dates
        </h2>
        <span className={`tag ${setting.on ? "tag-live" : ""}`}>{setting.on ? "On" : "Off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((text) => (
          <li key={text} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {!mailReady ? (
        <p className="notice mt-3" role="note">
          These emails need your list email set up first: your sender name and your postal address.{" "}
          <Link className="font-semibold underline" href="/studio/email">
            Set up your list email
          </Link>
        </p>
      ) : null}
      {mailReady && !emailInPlan ? (
        <p className="notice mt-3" role="note">
          Your plan does not include email right now, so these emails cannot go out.
        </p>
      ) : null}
      <form
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="store-dates-on">
          <input id="store-dates-on" disabled={busy} type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Email my list on these dates every year</span>
        </label>
        {rows.length === 0 ? <p className="text-sm text-ink-soft">No dates yet. Add one to start.</p> : null}
        {rows.map((row, index) => {
          const savedDate = setting.dates.find((d) => d.month === row.month && d.day === row.day);
          const result = savedDate ? results[dateKey(savedDate)] : undefined;
          const stillDue = savedDate && result ? now < dayIn(savedDate, result.year) + STORE_DATE_WINDOW_DAYS * DAY_MS : false;
          const resultWords = savedDate && result
            ? result.outcome === "made"
              ? `On ${dayWords(savedDate)}, ${result.year}, it was made for ${result.total} ${result.total === 1 ? "person" : "people"} on your list.`
              : result.outcome === "unconfirmed"
                ? `On ${dayWords(savedDate)}, ${result.year}, making it could not be confirmed. Check Sent and scheduled in Email. It is never made twice in a year.`
                : result.outcome === "waiting" && stillDue
                  ? `Waiting its turn: many stores' emails were due on ${dayWords(savedDate)}, ${result.year}. It is made on one of the next mornings, at the latest ${STORE_DATE_WINDOW_DAYS} days after the day.`
                  : `Not sent on ${dayWords(savedDate)}, ${result.year}: ${WHY[result.outcome] ?? WHY.error}`
            : null;
          const next = savedDate && setting.on ? new Date(nextDay(savedDate, now)) : null;
          const base = `store-date-${row.id}`;
          const invalid = (field: Field) => fieldError?.id === row.id && fieldError.field === field;
          const errorId = `${base}-error`;
          const errorLine = (field: Field) =>
            invalid(field) ? (
              <span id={errorId} className="mt-1 block text-sm font-semibold text-ink">
                {fieldError!.text}
              </span>
            ) : null;
          return (
            <fieldset key={row.id} className="rounded-xl border border-line p-4">
              <legend className="px-1 text-sm font-semibold text-ink">{`Date ${index + 1}${row.name ? `: ${row.name}` : ""}`}</legend>
              <div className="space-y-4">
                <label className="block" htmlFor={`${base}-name`}>
                  <span className="field-label">Name, only you see it</span>
                  <input
                    id={`${base}-name`}
                    aria-invalid={invalid("name") || undefined}
                    aria-describedby={invalid("name") ? errorId : undefined}
                    disabled={busy}
                    className="field mt-2"
                    maxLength={MAX_DATE_NAME}
                    value={row.name}
                    placeholder="Store birthday"
                    onChange={(event) => change(row.id, { name: event.target.value })}
                  />
                  {errorLine("name")}
                </label>
                <div className="flex flex-wrap gap-4">
                  <label className="block" htmlFor={`${base}-month`}>
                    <span className="field-label">Month</span>
                    <select id={`${base}-month`} disabled={busy} className="field mt-2" value={row.month} onChange={(event) => change(row.id, { month: Number(event.target.value) })}>
                      {MONTH_NAMES.map((name, i) => (
                        <option key={name} value={i + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block" htmlFor={`${base}-day`}>
                    <span className="field-label">Day</span>
                    <select
                      id={`${base}-day`}
                      aria-invalid={invalid("day") || undefined}
                      aria-describedby={invalid("day") ? errorId : undefined}
                      disabled={busy}
                      className="field mt-2"
                      value={row.day}
                      onChange={(event) => change(row.id, { day: Number(event.target.value) })}
                    >
                      {Array.from({ length: MONTH_DAYS[row.month - 1] }, (_, i) => i + 1).map((day) => (
                        <option key={day} value={day}>
                          {row.month === 2 && day === 29 ? "29 (March 1 in other years)" : day}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {errorLine("day")}
                <label className="block" htmlFor={`${base}-subject`}>
                  <span className="field-label">Subject line</span>
                  <input
                    id={`${base}-subject`}
                    aria-invalid={invalid("subject") || undefined}
                    aria-describedby={invalid("subject") ? errorId : undefined}
                    disabled={busy}
                    className="field mt-2"
                    maxLength={MAX_DATE_SUBJECT}
                    value={row.subject}
                    onChange={(event) => change(row.id, { subject: event.target.value })}
                  />
                  {errorLine("subject")}
                </label>
                <label className="block" htmlFor={`${base}-message`}>
                  <span className="field-label">The email</span>
                  <span id={`${base}-message-help`} className="mt-1 block text-sm text-ink-soft">
                    {`For example: "Our store opened a year ago today. Thank you for being part of it." Up to ${MAX_DATE_MESSAGE} characters. Sent exactly as you write it.`}
                  </span>
                  <textarea
                    id={`${base}-message`}
                    aria-describedby={invalid("message") ? `${base}-message-help ${errorId}` : `${base}-message-help`}
                    aria-invalid={invalid("message") || undefined}
                    disabled={busy}
                    className="field mt-2"
                    rows={5}
                    maxLength={MAX_DATE_MESSAGE}
                    value={row.message}
                    onChange={(event) => change(row.id, { message: event.target.value })}
                  />
                  {errorLine("message")}
                </label>
                {next ? (
                  <p className="text-sm text-ink">
                    {"Next email: "}
                    <time dateTime={next.toISOString().slice(0, 10)}>{`${dayWords(savedDate!)}, ${next.getUTCFullYear()}`}</time>
                  </p>
                ) : null}
                {resultWords ? (
                  <p className="text-sm text-ink" role="status">
                    {resultWords}
                  </p>
                ) : null}
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => remove(row, index)}>
                  {`Remove date ${index + 1}`}
                </button>
              </div>
            </fieldset>
          );
        })}
        {removed ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink" role="status">
            <span>{`Removed ${removed.row.name ? `"${removed.row.name}"` : "a date"}. It is gone only once you save.`}</span>
            {rows.length < MAX_STORE_DATES ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={undoRemove}>
                Undo remove
              </button>
            ) : null}
          </p>
        ) : null}
        {rows.length < MAX_STORE_DATES ? (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={add}>
            Add a date
          </button>
        ) : (
          <p className="text-sm text-ink-soft">{`You have the most dates a store can keep: ${MAX_STORE_DATES}.`}</p>
        )}
        <p className="text-sm text-ink-soft">Nothing changes until you save. To undo any other change before saving, reload this page.</p>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
