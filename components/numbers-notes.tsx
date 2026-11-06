"use client";

import { useRef, useState } from "react";
import { toast } from "@/components/toast";
import type { StatsNote } from "@/lib/stats-notes";

const MAX_NOTE_LENGTH = 80;

function freshAttempt(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Notes on the numbers (lib/stats-notes.ts): what happened on a day, so a
 * rise or a fall on the chart has its reason beside it. The list shows the
 * notes inside the days the chart shows; all of them are kept.
 */
export function NumbersNotes({
  notes,
  onChange,
  from,
  to,
  today,
}: {
  notes: StatsNote[];
  onChange: (notes: StatsNote[]) => void;
  /** The days the chart shows, so the list says what is on it. */
  from: string;
  to: string;
  today: string;
}) {
  const [day, setDay] = useState(today);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const addAttempt = useRef<string | null>(null);
  const shown = notes.filter((note) => note.day >= from && note.day <= to);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; notes?: StatsNote[] };
      if (answer.ok && answer.notes) {
        onChange(answer.notes);
        toast(done);
        return true;
      }
      if (response.status === 409) addAttempt.current = null;
      toast("That did not save. Check the day and the words, and try again.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return false;
  }

  return (
    <div className="mt-4">
      <p className="text-sm font-bold text-ink">Notes on your numbers</p>
      <p className="mt-0.5 text-xs text-ink-soft">
        Mark what happened on a day, like a post, a launch or a new price, so you can see what it did. Days with a note are marked under the chart.
      </p>
      {shown.length ? (
        <ul className="mt-2 divide-y divide-line text-sm">
          {[...shown].reverse().map((note) => (
            <li key={note.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0">
                <span className="mr-2 tabular-nums text-ink-soft">{shortDay(note.day)}</span>
                <span className="text-ink [overflow-wrap:anywhere]">{note.text}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                disabled={busy}
                onClick={() => void send({ action: "remove", id: note.id }, "Note removed.")}
                aria-label={`Remove the note for ${shortDay(note.day)}: ${note.text}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          addAttempt.current ??= freshAttempt();
          if (await send({ action: "add", id: addAttempt.current, day, text }, "Note added.")) {
            addAttempt.current = null;
            setText("");
          }
        }}
      >
        <label className="min-w-0 text-sm">
          <span className="field-label">Day</span>
          <input type="date" required className="field mt-1 min-w-0 max-w-full py-2 sm:w-auto" value={day} max={today} onChange={(e) => { addAttempt.current = null; setDay(e.target.value); }} />
        </label>
        <label className="min-w-0 text-sm">
          <span className="field-label">What happened</span>
          <input
            required
            className="field mt-1 py-2"
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Posted the October reel"
            value={text}
            onChange={(e) => { addAttempt.current = null; setText(e.target.value); }}
          />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm justify-self-start" disabled={busy}>
          Add note
        </button>
      </form>
    </div>
  );
}
