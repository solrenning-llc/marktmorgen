"use client";

import { useState } from "react";
import { UrlField } from "@/components/url-field";
import { HOST_ICS_CHECK } from "@/lib/fetch-url-check";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import type { HostCalendarView, HostSource, SyncState } from "@/lib/host-calendar";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  signed_out: "Your session ended. Log in again.",
  limited: "That is too many changes in a few minutes. Wait a moment and try again.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
  google_off: "Google Calendar sync for hosts is not switched on yet. Add your calendar's private iCal address instead.",
  google_none: "Connect your Google Calendar first, or connect it again.",
  ics_none: "Add your calendar's private iCal address first.",
  calendars: "Pick up to 10 of the calendars listed.",
  write: "Bookings can only be written to a calendar you can edit.",
  invalid: "That could not be saved. Reload the page and try again.",
};

const STATE_WORDS: Record<SyncState, { tag: string; tone: "ok" | "warn" | "off" }> = {
  none: { tag: "Not reading a calendar", tone: "off" },
  ok: { tag: "Synced", tone: "ok" },
  stale: { tag: "Out of date: your times are hidden", tone: "warn" },
  failed: { tag: "Cannot be read: your times are hidden", tone: "warn" },
  scope: { tag: "Permission missing: your times are hidden", tone: "warn" },
  off: { tag: "Google sync not switched on: your times are hidden", tone: "warn" },
};

// In UTC, said so: the server draws this first, and the browser must draw the same text.
function when(ms: number): string {
  return `${new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/**
 * One team host's own calendar for the team calls they host: where their
 * busy times are read from, which Google calendars count and which one
 * bookings are written to, and how the last reading went (lib/host-calendar.ts).
 */
export function HostCalendar({ view: first, pin, tz, hosting }: { view: HostCalendarView; pin: string; tz: string; hosting: string[] }) {
  const [view, setView] = useState(first);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [read, setRead] = useState<string[]>(first.read);
  const [write, setWrite] = useState(first.write);

  async function send(action: string, extra: Record<string, unknown>, done: string) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch("/api/store/host-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, tz, ...extra }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; view?: HostCalendarView };
      if (data.ok && data.view) {
        setView(data.view);
        setRead(data.view.read);
        setWrite(data.view.write);
        toast(done);
        if (action === "ics-add") setUrl("");
        return;
      }
      setError(data.message ?? MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(null);
    }
  }

  const state = STATE_WORDS[view.sync.state];
  const start = `/api/integrations/google/start?for=host${pin ? `&${pin.replace(/^\?/, "")}` : ""}`;
  const sources: { value: HostSource; label: string; note: string; disabled: boolean }[] = [
    {
      value: "google",
      label: "My Google Calendar (two-way)",
      note: view.googleOffered
        ? "Busy times read from the calendars you select; bookings you host written to the one you choose, with a Google Meet link, and moved or deleted with them."
        : "Not switched on on Marktmorgen yet. Until it is, use your calendar's private iCal address.",
      disabled: !view.googleOffered || !view.google,
    },
    { value: "ics", label: "A private iCal address", note: "Read-only: Google, Outlook or iCloud busy times, by the calendar's secret address.", disabled: !view.ics },
    { value: "none", label: "No calendar", note: "Only your Marktmorgen bookings block your times. Meetings you have elsewhere are not seen.", disabled: false },
  ];

  return (
    <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 gap-6">
        <section className="card p-6 sm:p-8" aria-labelledby="host-sync-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 id="host-sync-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Sync status
            </h2>
            <span className={`tag ${state.tone === "ok" ? "tag-live" : ""}`} data-sync-state={view.sync.state}>
              {state.tag}
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            {view.sync.lastSuccess ? `Last successful sync: ${when(view.sync.lastSuccess)}.` : "Last successful sync: never."}{" "}
            {view.source === "none"
              ? "Pick a calendar below so meetings you have elsewhere are never booked over."
              : "Read again at most every 15 minutes while someone is looking at a booking page. If the last good reading is more than 45 minutes old, or your calendar cannot be read, your times are hidden until it can be, and the other hosts' times stay open."}
          </p>
          {view.sync.message ? (
            <p className={`notice mt-3 ${view.sync.blocked ? "notice-warn" : ""}`} role="status">
              {view.sync.message}
            </p>
          ) : null}
          {view.source !== "none" ? (
            <button type="button" className="btn btn-secondary btn-sm mt-4" disabled={busy !== null} aria-busy={busy === "check"} onClick={() => send("check", {}, "Calendar checked.")}>
              <Icon name="refresh" size={16} />
              {busy === "check" ? "Checking…" : "Check now"}
            </button>
          ) : null}
        </section>

        <section className="card p-6 sm:p-8" aria-labelledby="host-source-title">
          <h2 id="host-source-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Where your busy times come from
          </h2>
          <fieldset className="mt-3 grid gap-2">
            <legend className="sr-only">Busy times</legend>
            {sources.map((s) => (
              <label key={s.value} className={`flex items-start gap-3 rounded-[12px] border px-3 py-3 ${view.source === s.value ? "border-violet-brand bg-lilac/40" : "border-line bg-white"} ${s.disabled && view.source !== s.value ? "opacity-70" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  name="host-source"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={view.source === s.value}
                  disabled={busy !== null || (s.disabled && view.source !== s.value)}
                  onChange={() => send("source", { source: s.value }, "Saved.")}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{s.label}</span>
                  <span className="mt-0.5 block text-sm text-ink-soft">{s.note}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </section>

        <section className="card p-6 sm:p-8" aria-labelledby="host-google-title">
          <h2 id="host-google-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Google Calendar
          </h2>
          {!view.googleOffered ? (
            <p className="notice mt-3" role="status">
              Two-way Google Calendar sync for hosts is not switched on on Marktmorgen yet: it needs a permission Google has to approve
              for our app first. Until then, add your Google Calendar&apos;s secret address in iCal format below, and your busy times are read from it.
            </p>
          ) : view.google ? (
            <>
              <p className="mt-2 text-sm text-ink-soft">
                <span className="break-all font-semibold text-ink">{view.google.account}</span>
                {view.google.broken ? ` · needs connecting again: ${view.google.broken}` : " · connected"}
              </p>
              {!view.google.freebusy || !view.google.calendars ? (
                <p className="notice notice-warn mt-3" role="status">
                  {!view.google.freebusy
                    ? "Google was connected without the permission to see your free/busy times, so your busy times cannot be read and your team times stay hidden while Google is your source. Connect again and check every box Google shows."
                    : "Google was connected without the permission to list your calendars, so only your primary calendar is read and written. Connect again and check every box to choose others."}
                </p>
              ) : null}
              {view.calendars ? (
                <div className="mt-4">
                  <p className="field-label">Calendars that make you busy</p>
                  <ul className="mt-2 grid gap-1.5 text-sm">
                    {view.calendars.map((c) => (
                      <li key={c.id}>
                        <label className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0"
                            checked={read.includes(c.id)}
                            onChange={(e) => setRead(e.target.checked ? [...read, c.id] : read.filter((id) => id !== c.id))}
                          />
                          <span className="min-w-0 break-words">{`${c.name}${c.primary ? " (primary)" : ""}`}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-ink-soft">None checked reads your primary calendar. Up to 10.</p>
                  <label className="field-label mt-4 block" htmlFor="host-write">
                    Calendar your team bookings are written to
                  </label>
                  <select id="host-write" className="field mt-1 w-full" value={write} onChange={(e) => setWrite(e.target.value)}>
                    <option value="">Primary calendar</option>
                    {view.calendars
                      .filter((c) => c.writable && !c.primary)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm mt-3" disabled={busy !== null} aria-busy={busy === "calendars"} onClick={() => send("calendars", { read, write }, "Calendars saved.")}>
                    {busy === "calendars" ? "Saving…" : "Save calendars"}
                  </button>
                </div>
              ) : view.calendarsError ? (
                <p className="notice notice-warn mt-3" role="status">{view.calendarsError}</p>
              ) : null}
              <div className="mt-5 flex flex-wrap gap-2">
                <form action={start} method="post">
                  <button type="submit" className="btn btn-secondary btn-sm">
                    <Icon name="refresh" size={16} />
                    {view.google.broken ? "Connect again" : "Connect again or use another account"}
                  </button>
                </form>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} aria-busy={busy === "disconnect"} onClick={() => send("disconnect", {}, "Google Calendar disconnected.")}>
                  <Icon name="trash" size={16} />
                  {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-soft">
                Connect your own Google account. Google will ask to let Marktmorgen see your free/busy times (never what your events are),
                see the list of your calendars, and add, change and delete events. We only ever touch the events we make for the team
                calls you host.
              </p>
              <form action={start} method="post" className="mt-4">
                <button type="submit" className="btn btn-primary">
                  Connect Google Calendar
                </button>
              </form>
            </>
          )}
        </section>

        <section className="card p-6 sm:p-8" aria-labelledby="host-ics-title">
          <h2 id="host-ics-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Or a private iCal address
          </h2>
          {view.ics ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
              <span>{`${view.ics.provider} · added ${view.ics.addedAt ? when(Date.parse(view.ics.addedAt)) : ""}`}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => send("ics-remove", {}, "Calendar address removed.")}>
                <Icon name="trash" size={16} />
                Remove
              </button>
            </div>
          ) : (
            <form
              className="mt-3"
              onSubmit={(e) => {
                e.preventDefault();
                // Trimmed here, as the field checks it: the route cuts at its length before it trims.
                if (url.trim()) void send("ics-add", { url: url.trim() }, "Calendar added and read.");
              }}
            >
              <label className="field-label" htmlFor="host-ics">
                Secret address in iCal format
              </label>
              <UrlField id="host-ics" className="field mt-1 w-full" autoComplete="off" value={url} onChange={setUrl} check={HOST_ICS_CHECK} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
              <p className="mt-1 text-xs text-ink-soft">Read once now, then kept sealed; never shown again, not even to you.</p>
              <button type="submit" className="btn btn-secondary btn-sm mt-3" disabled={busy !== null || !url.trim()} aria-busy={busy === "ics-add"}>
                {busy === "ics-add" ? "Reading it…" : "Add and use it"}
              </button>
            </form>
          )}
        </section>

        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-6">
        <section className="card p-6 sm:p-8" aria-labelledby="host-hosting-title">
          <h2 id="host-hosting-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Team calls you host here
          </h2>
          {hosting.length ? (
            <ul className="mt-3 space-y-1.5 text-sm text-ink-soft">
              {hosting.map((title) => (
                <li key={title} className="break-words">
                  {title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">None yet. The store&apos;s owner or an Editor adds you as a host under a call&apos;s Team.</p>
          )}
          <p className="mt-3 text-sm text-ink-soft">
            Your hours, time zone, gap between calls, notice and daily cap are set on each call. Your calendar is yours: set once, it counts on every store you host team calls on.
          </p>
        </section>
      </div>
    </div>
  );
}
