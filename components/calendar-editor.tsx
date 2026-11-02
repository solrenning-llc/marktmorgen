"use client";

import { useState } from "react";
import { UrlField } from "@/components/url-field";
import { CALENDAR_CHECK } from "@/lib/fetch-url-check";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/components/use-hydrated";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import type { CalendarView } from "@/lib/calendar-sync";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";


const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

/** How long ago, by the reader's clock; "recently" until the page runs. */
function ago(ms: number, local: boolean): string {
  if (!ms) return "";
  if (!local) return "recently";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

function addedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The creator's calendars, both ways: private calendar addresses read for
 * busy times, and the private address that puts every booking into theirs.
 */
export function CalendarEditor({ view: initial, weekly }: { view: CalendarView; weekly: boolean }) {
  const local = useHydrated();
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  async function send(action: "add" | "remove" | "rotate", extra: Record<string, string> = {}) {
    setBusy(action === "remove" ? `remove:${extra.id}` : action);
    setError(null);
    try {
      const response = await fetch("/api/store/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; view?: CalendarView; busyTimes?: number };
      if (data.ok && data.view) {
        setView(data.view);
        if (action === "add") {
          setUrl("");
          toast(`Calendar added. ${data.busyTimes ?? 0} busy ${data.busyTimes === 1 ? "time" : "times"} found ahead.`);
        } else if (action === "remove") {
          toast("Calendar removed.");
        } else {
          setConfirmRotate(false);
          toast("New calendar address made. The old one no longer works.");
        }
        router.refresh();
        return;
      }
      setError(data.message ?? MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!view.subscribeUrl) return;
    try {
      await navigator.clipboard.writeText(view.subscribeUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // The field is selectable; copying by hand still works.
    }
  }

  const full = view.feeds.length >= MAX_FEEDS;

  return (
    <section id="calendar" className="card mt-8 scroll-mt-32 p-6 sm:p-8" aria-labelledby="calendar-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="calendar-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your calendars
        </h2>
        <span className={`tag ${view.feeds.length ? "tag-live" : ""}`}>{`${view.feeds.length} of ${MAX_FEEDS} read`}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        Paste the private address of a calendar and the times you are busy there are not offered for calls. No account
        to connect and no password: the address gives us a read-only copy, and only the busy times are kept, never a
        title or a guest.
      </p>
      {!weekly ? (
        <p className="mt-3 rounded-2xl bg-sand px-4 py-3 text-sm text-ink-soft">
          This blocks times in calls booked from your weekly hours. Dated sessions keep the dates you set; when one clashes
          with your calendar, Upcoming calls says so.
        </p>
      ) : null}

      {view.feeds.length ? (
        <ul className="mt-5 space-y-3">
          {view.feeds.map((feed) => (
            <li key={feed.id} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${feed.state === "ok" ? "bg-mint-brand" : feed.state === "error" ? "bg-danger" : "bg-amber-brand"}`}
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{feed.provider}</span>
                    <span className="block text-sm text-ink-soft">
                      {feed.state === "ok"
                        ? `Read ${ago(feed.checkedAt, local)} · ${feed.busyTimes} busy ${feed.busyTimes === 1 ? "time" : "times"} in the next ${LOOKAHEAD_DAYS} days`
                        : feed.state === "error"
                          ? `Could not be read ${ago(feed.checkedAt, local)}`
                          : "Waiting for its first reading"}
                      {feed.addedAt ? ` · added ${addedOn(feed.addedAt)}` : ""}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => send("remove", { id: feed.id })}
                  disabled={busy !== null}
                  aria-busy={busy === `remove:${feed.id}`}
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove ${feed.provider}`}
                >
                  <Icon name="trash" size={16} />
                  Remove
                </button>
              </div>
              {feed.state === "error" && feed.message ? (
                <p className="notice notice-error mt-3 text-sm">
                  {`${feed.message} Bookings go on meanwhile${feed.busyTimes ? ", using what was last read" : ""}.`}
                </p>
              ) : null}
              {feed.unsupported ? (
                <p className="mt-2 text-xs text-ink-soft">
                  {`${feed.unsupported} repeating ${feed.unsupported === 1 ? "event uses a rule" : "events use rules"} we cannot read (such as "the second Tuesday of the month"); only the first time of ${feed.unsupported === 1 ? "it" : "each"} blocks a call.`}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!full ? (
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) send("add", { url: url.trim() });
          }}
        >
          <label htmlFor="calendar-url" className="field-label">
            Private calendar address (iCal or .ics link)
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
            <UrlField
              id="calendar-url"
              autoComplete="off"
              value={url}
              onChange={setUrl}
              check={CALENDAR_CHECK}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              describedBy="calendar-url-hint"
              wrapClassName="min-w-0 flex-1"
              className="field w-full"
            />
            <button type="submit" disabled={busy !== null} aria-busy={busy === "add"} className="btn btn-primary shrink-0">
              {busy === "add" ? "Reading it…" : "Add calendar"}
            </button>
          </div>
          <p id="calendar-url-hint" className="mt-2 text-xs text-ink-soft">
            It is read once now, so you know it works, then every 10 minutes while people book. Once saved, the address is
            never shown again, here or anywhere.
          </p>
        </form>
      ) : (
        <p className="mt-5 text-sm text-ink-soft">{`That is ${MAX_FEEDS} calendars, as many as a store reads. Remove one to add another.`}</p>
      )}

      {error ? (
        <p className="notice notice-error mt-4" role="alert">
          {error}
        </p>
      ) : null}

      <details className="mt-4 rounded-[12px] bg-paper px-4 py-3 text-sm ring-1 ring-line">
        <summary className="cursor-pointer font-semibold text-ink-soft transition hover:text-violet-deep">Where to find the address</summary>
        <ul className="mt-3 space-y-2 text-ink-soft">
          <li>
            <strong className="text-ink">Google Calendar:</strong> on a computer, Settings, then your calendar under
            &ldquo;Settings for my calendars,&rdquo; then &ldquo;Secret address in iCal format.&rdquo;
          </li>
          <li>
            <strong className="text-ink">Outlook:</strong> Settings, Calendar, Shared calendars, &ldquo;Publish a
            calendar,&rdquo; choose &ldquo;Can view when I&apos;m busy,&rdquo; then copy the ICS link.
          </li>
          <li>
            <strong className="text-ink">Apple Calendar (iCloud):</strong> on iCloud.com or a Mac, share the calendar as a
            Public Calendar and copy its address (webcal:// works as it is).
          </li>
        </ul>
        <p className="mt-3 text-ink-soft">
          Changes in your calendar reach your booking page within about 10 minutes. To stop, remove it here, or reset the
          address in your calendar&apos;s settings.
        </p>
      </details>

      <div className="mt-8 border-t border-line pt-6">
        <h3 className="font-semibold text-ink">Your bookings in your calendar</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Subscribe to this private address from Google Calendar (&ldquo;From URL&rdquo;), Outlook (&ldquo;Subscribe from
          web&rdquo;) or Apple Calendar (&ldquo;New Calendar Subscription&rdquo;), and every booked call and dated session
          shows up with who booked it. Calendar apps refresh it on their own schedule, from every few minutes to a few
          hours.
        </p>
        {view.subscribeUrl ? (
          <>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <label htmlFor="calendar-subscribe" className="sr-only">
                Your private bookings calendar address
              </label>
              <input
                id="calendar-subscribe"
                readOnly
                value={view.subscribeUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="field min-w-0 flex-1 font-mono text-sm"
              />
              <button type="button" onClick={copy} className="btn btn-secondary shrink-0">
                <Icon name={copied ? "check" : "link"} size={16} />
                <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              It holds your buyers&apos; names and email addresses, so keep it to yourself. If it has been shared by mistake, make
              a new one: the old one stops working at once.
            </p>
            {!confirmRotate ? (
              <button type="button" onClick={() => setConfirmRotate(true)} className="btn btn-ghost btn-sm mt-3">
                <Icon name="refresh" size={16} />
                Make a new address
              </button>
            ) : (
              <div className="notice notice-warn mt-3">
                <p className="text-sm text-ink">
                  The address you subscribed to stops working, and you will need to subscribe again with the new one.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" onClick={() => send("rotate")} disabled={busy !== null} aria-busy={busy === "rotate"} className="btn btn-primary btn-sm">
                    Make a new address
                  </button>
                  <button type="button" onClick={() => setConfirmRotate(false)} className="btn btn-ghost btn-sm">
                    Keep this one
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <button type="button" onClick={() => send("rotate")} disabled={busy !== null} aria-busy={busy === "rotate"} className="btn btn-secondary mt-3">
            Make my calendar address
          </button>
        )}
      </div>
    </section>
  );
}
