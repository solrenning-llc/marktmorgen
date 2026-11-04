"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import type { PersonNote } from "@/lib/buyer-profile";

const MAX_PERSON_NOTE = 500;

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Your team's notes about one buyer (lib/buyer-profile.ts): what they asked,
 * what was promised, what they like. Seen only by whoever may read orders.
 */
/** `preparedAt`: when the page read the person (ms), sent with every note, so a person deleted since is never written about again. */
export function PersonNotes({ person, initial, preparedAt }: { person: string; initial: PersonNote[]; preparedAt: number }) {
  const [notes, setNotes] = useState(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch("/api/store/person", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, person, preparedAt }),
      });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; notes?: PersonNote[]; error?: string };
      if (answer.ok && answer.notes) {
        setNotes(answer.notes);
        toast(done);
        return true;
      }
      toast(answer.error === "unknown" ? "This person is no longer in your store, so the note was not saved. Reload the page." : "That did not save. Try again in a moment.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return false;
  }

  return (
    <div>
      {notes.length ? (
        <ul className="mt-4 space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-xl bg-paper p-4 text-sm ring-1 ring-line">
              <p className="whitespace-pre-line text-ink [overflow-wrap:anywhere]">{note.text}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-mute">
                  {when(note.at)}
                  {note.by ? ` · ${note.by}` : ""}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void send({ action: "unnote", id: note.id }, "Note removed.")}
                  aria-label={`Remove the note from ${when(note.at)}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">No notes yet.</p>
      )}
      <form
        className="mt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await send({ action: "note", text }, "Note added.")) setText("");
        }}
      >
        <label className="block text-sm">
          <span className="field-label">Add a note</span>
          <textarea
            required
            rows={3}
            maxLength={MAX_PERSON_NOTE}
            className="field mt-1"
            placeholder="Asked about the advanced course. Prefers email to calls."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-ink-mute">{`${text.length}/${MAX_PERSON_NOTE}`}</p>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !text.trim()}>
            Save note
          </button>
        </div>
      </form>
    </div>
  );
}
