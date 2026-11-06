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
 * tab is never overwritten (the server answers "changed").
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
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  const length = noteLength(text);
  const over = length > MAX_NOTE_CHARS;
  const count = w.count(length, MAX_NOTE_CHARS);
  useLeaveGuard(initial.state !== "unknown" && text !== kept && !busy);

  // The count is said to a screen reader once typing pauses, not on every key.
  useEffect(() => {
    if (pause.current) clearTimeout(pause.current);
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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (over) {
      setSaid(w.tooLong(MAX_NOTE_CHARS));
      return;
    }
    setBusy(true);
    setSaid(w.saving);
    try {
      const response = await fetch("/api/store/course/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...where, text, was: kept }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: unknown; text?: unknown; error?: unknown };
      if (data.ok === true && typeof data.text === "string") {
        setKept(data.text);
        setText(data.text);
        setSaid(data.text ? w.saved : w.cleared);
        return;
      }
      const errors: Record<string, string> = {
        too_long: w.tooLong(MAX_NOTE_CHARS),
        too_many: w.tooMany(MAX_NOTES_PER_STUDENT),
        changed: w.changed,
        full: w.full,
        slow: w.slow,
      };
      setSaid(errors[typeof data.error === "string" ? data.error : ""] ?? w.failed);
    } catch {
      setSaid(w.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="lesson-notes-heading">
      <h2 id="lesson-notes-heading" className="text-lg font-semibold">{w.heading}</h2>
      <p id="lesson-notes-private" className="st-muted mt-1 text-sm">{w.privateLine}</p>
      <form onSubmit={save} className="mt-3">
        <label htmlFor="lesson-notes-text" className="st-label block">{w.label}</label>
        <textarea
          id="lesson-notes-text"
          name="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
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
          <button type="submit" className="btn st-btn min-h-[44px]" disabled={busy} aria-disabled={busy}>{w.save}</button>
          <p role="status" className="text-sm">{said}</p>
        </div>
      </form>
      <a href={exportHref} download className="st-footer-link mt-3 inline-flex min-h-[44px] items-center text-sm font-semibold">{w.download}</a>
    </section>
  );
}
