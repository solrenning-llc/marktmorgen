"use client";

/**
 * "Can everyone read it?" in the email's "Check before it goes out" step (AX274 Part A item 6; ATAG 2.0 Part B).
 * Lists what lib/mail-access-check.ts finds, each in plain words with why it matters, a way to see it in the
 * text and, where it is safe, a fix the creator does in one press with words they type. Nothing is changed
 * until they press, every change can be undone, and nothing here stops the email from going out.
 *
 * A picture the creator says is only decoration is left as it is: an email already draws a picture with no
 * words as one a screen reader skips (alt=""). That choice is kept on this page only, not with the email.
 */
import { useId, useState } from "react";
import { addressToButton, describePicture, mailAccessNotes, MAIL_ACCESS_DONE_FOR_YOU, renameButton, type FixResult, type MailAccessNote } from "@/lib/mail-access-check";
import { MAX_MAIL_BUTTON } from "@/lib/mail-body";
import { MAX_PICTURE_ALT } from "@/lib/mail-picture-rules";

const REFUSED: Record<Exclude<FixResult, { ok: true }>["why"], string> = {
  empty: "Type the words first.",
  vague: "Say where it goes, for example “Read the bread guide”.",
  long: `Keep it to ${MAX_MAIL_BUTTON} characters or fewer.`,
  changed: "This part of the text changed. Look at it again below.",
  not_alone: "Put the address on a line of its own first.",
};

/** A short, readable form of an address for a sentence: no https://, and cut when it is long. */
function shortAddress(address: string): string {
  const bare = address.replace(/^https:\/\//, "");
  return bare.length > 48 ? `${bare.slice(0, 45)}…` : bare;
}

const link = "inline-flex min-h-11 min-w-11 items-center font-bold underline underline-offset-4";

export function MailAccessReview({
  body,
  onChange,
  onShow,
}: {
  body: string;
  /** The email's text after a fix the creator pressed. */
  onChange: (next: string) => void;
  /** Shows that place in the text: [start, end) of the body. */
  onShow: (start: number, end: number) => void;
}) {
  const id = useId();
  const [decoration, setDecoration] = useState<string[]>([]);
  const [words, setWords] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [said, setSaidText] = useState("");
  // The same sentence twice is still a change to the live region, so it is said again (as in the page editor).
  const setSaid = (text: string) => setSaidText((was) => (was === text ? `${text}\u00a0` : text));
  const [undo, setUndo] = useState<{ before: string; after: string; what: string } | null>(null);

  const all = mailAccessNotes(body);
  const notes = all.filter((note) => !(note.kind === "picture" && decoration.includes(note.url)));
  const decorative = all.filter((note) => note.kind === "picture" && decoration.includes(note.url)).length;
  const keyOf = (note: MailAccessNote, i: number) => `${note.kind}-${i}-${note.source}`;

  function apply(key: string, result: FixResult, done: string) {
    if (!result.ok) {
      setRefused((was) => ({ ...was, [key]: REFUSED[result.why] }));
      return;
    }
    setRefused({});
    setWords({});
    setUndo({ before: body, after: result.body, what: done });
    setSaid(`${done} You can undo it.`);
    onChange(result.body);
  }

  function fix(note: MailAccessNote, key: string) {
    const typed = words[key] ?? "";
    if (note.kind === "picture") apply(key, describePicture(body, note, typed), "Picture described.");
    else if (note.kind === "button") apply(key, renameButton(body, note, typed), "Button words changed.");
    else apply(key, addressToButton(body, note, typed), "Address made a button.");
  }

  return (
    <section aria-labelledby={`${id}-title`} className="mt-3 border-t border-line pt-3">
      <h4 id={`${id}-title`} className="font-semibold">Can everyone read it?</h4>
      {/* Says only what a press did, never what is typed: a fix, an undo, a choice. */}
      <p role="status" className="mt-1 empty:hidden">{said}</p>
      {undo && body === undo.after ? (
        <button
          type="button"
          className={link}
          onClick={() => {
            onChange(undo.before);
            setUndo(null);
            setSaid(`${undo.what.replace(/\.$/, "")}: undone.`);
          }}
        >
          Undo<span className="sr-only">: {undo.what}</span>
        </button>
      ) : null}
      {notes.length === 0 ? (
        <p className="mt-1">
          Nothing to fix: every picture has a description or is marked as decoration, and every link says where it goes.
        </p>
      ) : (
        <>
          <p className="mt-1">
            {notes.length === 1 ? "1 thing to check." : `${notes.length} things to check.`} You can still send it. Fixing them helps
            people who use a screen reader or cannot see pictures.
          </p>
          <ol className="mt-2 space-y-3">
            {notes.map((note, i) => {
              const key = keyOf(note, i);
              const field = `${id}-${i}`;
              const error = refused[key];
              const canFix = note.kind !== "address" || note.alone;
              return (
                <li key={key} className="rounded-[var(--r-md)] bg-white p-3">
                  <p className="font-semibold">
                    {note.kind === "picture"
                      ? "A picture has no description."
                      : note.kind === "button"
                        ? `The button “${note.label}” does not say where it goes.`
                        : `The address ${shortAddress(note.address)} is read out letter by letter.`}
                  </p>
                  <p className="mt-1">
                    {note.kind === "picture"
                      ? "A screen reader cannot say what it shows. Describe it in a few words, or mark it as decoration if it adds nothing."
                      : note.kind === "button"
                        ? "Someone who jumps from link to link hears only these words. Say what they get, for example “Read the bread guide”."
                        : note.alone
                          ? "It does not say what is there. Give it words and it becomes a button."
                          : "It does not say what is there. Put it on a line of its own in the text and it can become a button with words."}
                  </p>
                  {canFix ? (
                    <form
                      className="mt-2 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        fix(note, key);
                      }}
                    >
                      <label htmlFor={field} className="min-w-0 flex-1 basis-56">
                        <span className="field-label">{note.kind === "picture" ? "What the picture shows" : "Words for the button"}</span>
                        <input
                          id={field}
                          type="text"
                          className="field mt-1"
                          maxLength={note.kind === "picture" ? MAX_PICTURE_ALT : MAX_MAIL_BUTTON}
                          value={words[key] ?? ""}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `${field}-error` : undefined}
                          onChange={(event) => {
                            const value = event.target.value;
                            setWords((was) => ({ ...was, [key]: value }));
                            setRefused((was) => ({ ...was, [key]: "" }));
                          }}
                        />
                      </label>
                      <button type="submit" className="btn btn-secondary btn-sm">
                        {note.kind === "address" ? "Make it a button" : "Use these words"}
                      </button>
                      {error ? <p id={`${field}-error`} className="basis-full font-semibold text-danger-text">{error}</p> : null}
                    </form>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    {note.kind === "picture" ? (
                      <button
                        type="button"
                        className={link}
                        onClick={() => {
                          setDecoration((was) => [...was, note.url]);
                          setSaid("Marked as decoration: screen readers skip it.");
                        }}
                      >
                        It is only decoration
                      </button>
                    ) : null}
                    <button type="button" className={link} onClick={() => onShow(note.start, note.end)}>
                      Show it in the text<span className="sr-only">: {note.kind === "picture" ? "the picture" : note.kind === "button" ? `the button ${note.label}` : `the address ${shortAddress(note.address)}`}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {decorative > 0 ? (
        <p className="mt-2">
          {decorative === 1 ? "1 picture is marked as decoration" : `${decorative} pictures are marked as decoration`} on this page.{" "}
          <button
            type="button"
            className={link}
            onClick={() => {
              setDecoration([]);
              setSaid("Decoration marks removed.");
            }}
          >
            Ask again<span className="sr-only"> about the pictures marked as decoration</span>
          </button>
        </p>
      ) : null}
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-4">What we do for every email</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {MAIL_ACCESS_DONE_FOR_YOU.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
