"use client";

import { useState } from "react";
import type { EmailPoll } from "@/lib/email-poll-rules";

/**
 * A poll's totals in the studio's "Sent and scheduled" (125 [F2-EMAIL-POLLS],
 * unit 7c). Read only when the creator asks (the mail route's
 * "poll_results", which takes the studio requests the email's size needs),
 * read exactly, and said in words: each answer, its count and its share.
 * Never who answered what.
 */
export type PollResult =
  | { kind: "totals"; counts: number[]; votes: number; open: boolean; closesAt: number }
  | { kind: "used"; message: string }
  | { kind: "none" }
  | { kind: "unknown" };

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The server's answer, or "unknown" when any part of it does not read (rule 24). */
export function readPollResultsAnswer(raw: unknown, optionCount: number): PollResult {
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const a = raw as Record<string, unknown>;
  if (a.ok === false && a.error === "studio_used" && typeof a.message === "string" && a.message) return { kind: "used", message: a.message };
  if (a.ok === false && a.error === "poll_none") return { kind: "none" };
  if (a.ok !== true || a.state !== "ok") return { kind: "unknown" };
  const counts = a.counts;
  if (!Array.isArray(counts) || counts.length !== optionCount || !counts.every(count)) return { kind: "unknown" };
  if (!count(a.votes) || counts.reduce((sum: number, n: number) => sum + n, 0) !== a.votes) return { kind: "unknown" };
  if (typeof a.open !== "boolean" || typeof a.closesAt !== "number" || !Number.isFinite(a.closesAt)) return { kind: "unknown" };
  return { kind: "totals", counts: counts as number[], votes: a.votes, open: a.open, closesAt: a.closesAt };
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const n = (value: number) => value.toLocaleString("en-US");

export function PollResultsView({ poll, result }: { poll: EmailPoll; result: PollResult }) {
  if (result.kind === "used") return <p className="mt-2 text-sm text-ink-soft" role="status">{result.message}</p>;
  if (result.kind === "none") return <p className="mt-2 text-sm text-ink-soft" role="status">This email&apos;s poll is no longer kept.</p>;
  if (result.kind === "unknown") return <p className="mt-2 text-sm text-ink-soft" role="status">The answers could not be read just now. Try again in a moment.</p>;
  const { counts, votes, open, closesAt } = result;
  const when = `${DATE.format(closesAt)} (UTC)`;
  return (
    <div className="mt-2 rounded-[var(--r-md)] bg-sand p-4 text-sm" role="status">
      <p className="font-semibold text-ink">{poll.question}</p>
      <ul className="mt-2 space-y-2">
        {poll.options.map((option, i) => {
          const share = votes ? Math.round((counts[i] * 100) / votes) : 0;
          return (
            <li key={i}>
              <span className="text-ink">{`${option}: ${n(counts[i])} (${share}%)`}</span>
              <span className="mt-1 block h-2 rounded-full bg-paper">
                <span aria-hidden="true" className="block h-2 rounded-full bg-violet-brand" style={{ width: `${share}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-ink-soft">
        {votes === 0 ? "No answers" : `${n(votes)} ${votes === 1 ? "answer" : "answers"}${open ? " so far" : ""}`}
        {open ? `. Open until ${when}.` : `. Closed on ${when}.`}
      </p>
      <p className="mt-1 text-ink-soft">You see only the totals, never who answered what.</p>
    </div>
  );
}

/** The button that reads a poll's totals when asked, and what it read. */
export function PollResults({ id, poll }: { id: string; poll: EmailPoll }) {
  const [result, setResult] = useState<PollResult | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4"
        onClick={async () => {
          setBusy(true);
          try {
            const response = await fetch("/api/store/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "poll_results", id }) });
            setResult(readPollResultsAnswer(await response.json().catch(() => null), poll.options.length));
          } catch {
            setResult({ kind: "unknown" });
          }
          setBusy(false);
        }}
      >
        {result ? "Read the answers again" : "See the poll's answers"}
      </button>
      {result ? <PollResultsView poll={poll} result={result} /> : null}
    </div>
  );
}
