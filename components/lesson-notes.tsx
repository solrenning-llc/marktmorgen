"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_NOTE_CHARS, MAX_NOTES_PER_STUDENT, noteLength } from "@/lib/lesson-notes-rules";
import { lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { useLeaveGuard } from "@/components/leave-guard";
import type { LanguageCode } from "@/lib/store-language";

export type NoteShown = { state: "kept"; text: string } | { state: "none" } | { state: "unknown" };

/**
 * A student's private notes on a lesson (290 [SQ1], lib/lesson-notes.ts):
 * a labeled box, its count of characters, a save button and a link to
 * download every note of the course as text.
 *
 * A note that could not be read is said so, with no box to type over it:
 * an empty box would look like no note and overwrite the kept one on save.
 * A save names the note it started from, so a newer one saved in another
 * tab is never overwritten (the server answers "changed"). Words typed while
 * a save is on its way stay in the box, and leaving the page is guarded
 * until what the box holds is what the server kept. A whole note deleted
 * can be put back with one button. The count is said to a screen reader
 * only once the student has typed.
 *
 * What is typed while a save is on its way stays in the box, and leaving
 * the page stays guarded until it is saved too; deleting a whole note offers
 * to undo it; the count is said to a screen reader only once the student has
 * typed (Claude 2's review of #3031, M2, L6, L7). Undo leaves focus in the
 * box (third review of #3031, L2).
 *
 * Said in the store's `language` (lib/buyer-words/lesson-notes.ts).
 */
export function LessonNotes({
  initial,
  where,
  language = "en",
}: {
  initial: NoteShown;
  where: { handle: string; product: string; lesson: string };
  language?: LanguageCode;
}) {
  const w = lessonNotesWords(language);
  const start = initial.state === "kept" ? initial.text : "";
  const [text, setText] = useState(start);
  const [kept, setKept] = useState(start);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [heard, setHeard] = useState("");
  // The words of a note just deleted, while the box is still empty: what Undo puts back.
  const [lost, setLost] = useState<string | null>(null);
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The box as it is now, for a save that answers after the student typed more.
  const latest = useRef(start);
  // Whether the student has typed: nothing is said to a screen reader before that.
  const typed = useRef(false);
  // The box, for focus to land on when Undo, the control that had it, goes away (third review of #3031, L2).
  const area = useRef<HTMLTextAreaElement | null>(null);
  const length = noteLength(text);
  const over = length > MAX_NOTE_CHARS;
  const count = w.count(length, MAX_NOTE_CHARS);
  // Guarded while anything in the box is not saved, also while a save is on its way.
  useLeaveGuard(initial.state !== "unknown" && text !== kept);

  // The count is said to a screen reader once typing pauses, not on every key, and never before the student types.
  useEffect(() => {
    if (!typed.current) return;
    if (pause.current) clearTimeout(pause.current);
    if (!typed.current) return;
    pause.current = setTimeout(() => setHeard(over ? w.tooLong(MAX_NOTE_CHARS) : count), 1_000);
    return () => {
      if (pause.current) clearTimeout(pause.current);
    };
  }, [count, over, w]);

  const exportHref = `/api/store/course/note?h=${encodeURIComponent(where.handle)}&p=${encodeURIComponent(where.product)}`;

  if (initial.state === "unknown") {
    return (
      <section className="mt-8 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="lesson-notes-heading">
        <h2 id="lesson-notes-heading" className="text-lg font-semibold">{w.heading}</h2>
        <p className="st-note mt-2 text-sm" role="status">{w.unloaded}</p>
      </section>
    );
  }

  /** Sends `next` over `was`; the box keeps whatever was typed meanwhile, and only what was sent is said saved. */
  async function send(next: string, was: string): Promise<void> {
    setBusy(true);
    setSaid(w.saving);
    try {
      const response = await fetch("/api/store/course/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...where, text: next, was }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: unknown; text?: unknown; error?: unknown };
      if (data.ok === true && typeof data.text === "string") {
        const saved = data.text;
        setKept(saved);
        setLost(saved === "" && was !== "" ? was : null);
        if (latest.current === next) {
          // Nothing typed since: the box shows the note as kept (the server trims what trails it).
          latest.current = saved;
          setText(saved);
          setSaid(saved ? w.saved : w.cleared);
        } else setSaid(w.savedEarlier);
        return;
      }
      const errors: Record<string, string> = {
        too_long: w.tooLong(MAX_NOTE_CHARS),
        too_many: w.tooMany(MAX_NOTES_PER_STUDENT),
        mine: w.mine,
        changed: w.changed,
        full: w.full,
        // The students' notes of the store have reached their share of its room (lib/lesson-notes.ts).
        notes_full: w.notesFull,
        slow: w.slow,
        // Trying again cannot help: the lesson is not open to them now (signed out, access ended, held by a quiz).
        closed: w.closed,
        owner: w.closed,
      };
      setSaid(errors[typeof data.error === "string" ? data.error : ""] ?? w.failed);
    } catch {
      setSaid(w.failed);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (over) {
      setSaid(w.tooLong(MAX_NOTE_CHARS));
      return;
    }
    await send(text, kept);
  }

  /** Puts a note just deleted back, as a new note. */
  async function undo() {
    if (busy || lost === null) return;
    latest.current = lost;
    setText(lost);
    // Undo disappears once the box holds words again: focus goes to the words it put back, not to the page.
    area.current?.focus();
    await send(lost, "");
  }

  return (
    <section className="mt-8 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="lesson-notes-heading">
      <h2 id="lesson-notes-heading" className="text-lg font-semibold">{w.heading}</h2>
      <p id="lesson-notes-private" className="st-muted mt-1 text-sm">{w.privateLine}</p>
      <form onSubmit={save} className="mt-3">
        <label htmlFor="lesson-notes-text" className="st-label block">{w.label}</label>
        <textarea
          ref={area}
          id="lesson-notes-text"
          name="text"
          value={text}
          onChange={(event) => {
            typed.current = true;
            latest.current = event.target.value;
            setText(event.target.value);
          }}
          rows={6}
          aria-describedby="lesson-notes-private lesson-notes-count"
          aria-invalid={over ? true : undefined}
          className="st-field mt-2 block w-full"
          style={{ lineHeight: 1.6 }}
        />
        <p id="lesson-notes-count" className={`mt-1 text-sm ${over ? "font-semibold" : "st-muted"}`}>
          {over ? `${count}. ${w.tooLong(MAX_NOTE_CHARS)}` : count}
        </p>
        <p className="sr-only" aria-live="polite">{heard}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn st-btn inline-flex min-h-[44px] items-center" disabled={busy} aria-disabled={busy}>{w.save}</button>
          {lost !== null && text === "" ? (
            <button type="button" className="btn st-btn-ghost inline-flex min-h-[44px] items-center" onClick={undo} disabled={busy} aria-disabled={busy}>{w.undo}</button>
          ) : null}
          <p role="status" className="text-sm">{said}</p>
        </div>
      </form>
      <a href={exportHref} download className="st-footer-link mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold">{w.download}</a>
    </section>
  );
}
