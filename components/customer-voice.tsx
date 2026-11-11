"use client";

import { useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import type { VoiceSource, VoiceSummary } from "@/lib/customer-voice";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  unread: "Some of what customers said could not be read just now, so no summary was made: it would leave them out for the whole month. No AI job was used. Try again in a moment.",
  few: "Not enough yet: fewer than 8 things customers wrote or searched for in the last 90 days. It is worth reading once there are more.",
  used: "This month's AI jobs are used up. They come back with your next billing month.",
  off: "This summary is not available right now.",
  busy: "It is already being read. Look again in a minute.",
  changed: "Your store changed while this was being read (for example, someone was deleted), or it could not be saved, so it was not kept. Read it again. This try counted as one of this month's AI jobs.",
  slow: "A few AI jobs a minute at most. Try again in a moment.",
  failed: "No summary came back. Try again. This try may have counted as one of this month's AI jobs.",
  late: "Reading your store took too long this time, so no AI job was used. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again in a moment. If the summary had already started, this try may have counted as one of this month's AI jobs.",
};

const SOURCE_WORDS: Record<VoiceSource, [string, string]> = {
  cancel: ["member leaving", "members leaving"],
  question: ["unanswered question", "unanswered questions"],
  review: ["review", "reviews"],
  search: ["search with no result", "searches with no result"],
  assistant: ["question the assistant could not answer", "questions the assistant could not answer"],
  waitlist: ["waitlist of a product coming soon", "waitlists of products coming soon"],
};
const SOURCES: VoiceSource[] = ["cancel", "question", "review", "search", "assistant", "waitlist"];

const said = (counts: Partial<Record<VoiceSource, number>>) =>
  SOURCES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${SOURCE_WORDS[s][counts[s] === 1 ? 0 : 1]}`)
    .join(" · ");

/** The lists named in plain words, the first capitalized: "Reviews and searches with no result". Pure. */
export function unreadWords(unread: VoiceSource[]): string {
  const names = SOURCES.filter((s) => unread.includes(s)).map((s) => SOURCE_WORDS[s][1]);
  const list = names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return list ? `${list[0].toUpperCase()}${list.slice(1)}` : "";
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * What customers are saying (lib/customer-voice.ts): the last 90 days of
 * cancellation words, unanswered questions (the pages' and the Store
 * assistant's), reviews and searches that found
 * nothing, sorted into themes once a month, each with its count and the
 * customers' own words.
 */
export function CustomerVoice({ initial }: { initial: VoiceSummary | null }) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [summary, setSummary] = useState<VoiceSummary | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = summary?.month === thisMonth;

  async function read() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; summary?: VoiceSummary; unread?: VoiceSource[] | null };
      if (data.ok && data.summary) setSummary(data.summary);
      else {
        const message = MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
        const named = data.error === "unread" && Array.isArray(data.unread) ? unreadWords(data.unread) : "";
        setError(named ? `${message} Not read: ${named}.` : message);
      }
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6" role="region" aria-labelledby="customer-voice" data-customer-voice>
      <p id="customer-voice" className="text-sm font-bold text-ink">
        What customers are saying
      </p>
      <p className="mt-1 text-xs text-ink-soft">
        The last 90 days of what members wrote when leaving, questions your pages or your Store assistant could not answer, reviews and searches that found nothing, with how many are on the waitlist of each product coming soon so far (confirmed or not), sorted into the themes they repeat. AI only names each theme: the counts and the words under it are your customers&apos; own. What members wrote when leaving is counted but not quoted here: nothing kept with it says who wrote it, so it could not be left out for someone who was deleted. Once a month, as one of the month&apos;s AI jobs.
      </p>
      {summary ? (
        <div className="mt-3">
          <p className="text-xs text-ink-soft">{`${monthName(summary.month)}: read ${said(summary.read) || "nothing"}.`}</p>
          {summary.themes.length ? (
            <ol className="mt-2 space-y-3">
              {summary.themes.map((theme) => (
                <li key={theme.title} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line" data-voice-theme>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold text-ink">{theme.title}</p>
                    <p className="text-xs tabular-nums text-ink-soft">{said(theme.sources)}</p>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                    {theme.examples.map((example, i) => (
                      <li key={`${example.source}-${i}`} className="[overflow-wrap:anywhere]">
                        {`“${example.text}”`}
                        <span className="text-xs">
                          {` — ${SOURCE_WORDS[example.source][0]}${example.product ? `, ${example.product}` : ""}${example.stars ? `, ${example.stars} of 5 stars` : ""}${example.n > 1 ? `, ${example.n} times` : ""}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-ink">Nothing was said by more than one customer: no theme repeats yet.</p>
          )}
          {summary.themes.length && summary.other ? <p className="mt-2 text-xs text-ink-soft">{`${summary.other} more said something no one else did.`}</p> : null}
        </div>
      ) : null}
      {!current ? (
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => void read()} disabled={busy} aria-busy={busy}>
          {busy ? "Reading…" : summary ? `Read ${monthName(thisMonth)}` : "Sum up what customers said"}
        </button>
      ) : null}
      {error ? (
        <p className="notice mt-3 text-sm" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
