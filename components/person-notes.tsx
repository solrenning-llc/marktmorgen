"use client";

import { useState } from "react";
import { StudioEmptyState } from "@/components/empty-state";
import { toast } from "@/components/toast";
import type { PersonNote } from "@/lib/buyer-profile";

const MAX_PERSON_NOTE = 500;

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The route's answers given before anything is written: only these prove a change did not save. */
const REFUSED_BEFORE_WRITING = new Set(["invalid", "store_full", "notes_unreadable"]);

/**
 * What the notes box says when a change was not confirmed (Codex G on #3159).
 * A lost response, a body that is not JSON or any answer that does not prove
 * the change was refused before writing is an unknown outcome: the note may
 * have been saved, so it never says "did not save", which would lead to the
 * same note twice. `answer` is null when the response never arrived.
 */
export function personNoteFailureWords(answer: unknown): string {
  const error = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as { error?: unknown }).error : undefined;
  if (typeof error === "string" && REFUSED_BEFORE_WRITING.has(error)) return "That did not save. Try again in a moment.";
  if (error === "unavailable") return "Your notes could not be loaded just now. Open this page again in a moment to see whether that saved.";
  return "We could not confirm whether that saved. Open this page again to see whether it did before you try again.";
}

/**
 * Your team's notes about one buyer (lib/buyer-profile.ts): what they asked,
 * what was promised, what they like. Seen only by whoever may read orders.
 */
export function PersonNotes({ person, initial }: { person: string; initial: PersonNote[] }) {
  const [notes, setNotes] = useState(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch("/api/store/person", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, person }),
      });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; notes?: PersonNote[]; error?: string };
      if (answer.ok && answer.notes) {
        setNotes(answer.notes);
        toast(done);
        return true;
      }
      // Whether it saved is said only when the route proved it refused before writing.
      toast(personNoteFailureWords(answer));
    } catch {
      // The request may have reached the server and saved: unknown, never "did not save".
      toast(personNoteFailureWords(null));
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
        <StudioEmptyState title="No notes yet" body="A note you save here keeps what you know about this person, for you and your team." action={{ href: "#person-note", label: "Add the first note" }} className="mt-4" />
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
            id="person-note"
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
