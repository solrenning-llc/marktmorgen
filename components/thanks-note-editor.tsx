"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { useLeaveGuard } from "@/components/leave-guard";
import { STUDIO_MESSAGES, SESSION_ENDED } from "@/lib/studio-messages";
import { MAX_NOTE_BODY, MAX_NOTE_HEADING, MAX_NOTE_LABEL, readNote, parseNote, type ThanksNote } from "@/lib/thanks-note";
import { videoAddress } from "@/lib/sales-page";
import { MAX_LINK_LENGTH } from "@/lib/product-link";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  video: "That video address is not one we can play. Paste a YouTube, Vimeo or Loom link, or leave it empty.",
  link: "The button needs the full https address of the page it opens, like https://discord.gg/yourgroup.",
  label: "Give the button its words, like “Join the group”, or empty the address.",
  empty: "Write something, add a video or a button, or press Remove to have no note.",
  unknown: "That product is no longer in your store. Reload the page.",
  signed_out: SESSION_ENDED,
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Fields = { heading: string; body: string; video: string; label: string; url: string };

function fieldsOf(note: ThanksNote | null): Fields {
  return {
    heading: note?.heading ?? "",
    body: note?.body ?? "",
    video: note?.video ? videoAddress(note.video) : "",
    label: note?.button?.label ?? "",
    url: note?.button?.url ?? "",
  };
}

/**
 * A product's note after paying (lib/thanks-note.ts): what the buyer reads on
 * the thank-you page under what they bought, and in their confirmation email.
 */
export function ThanksNoteEditor({ productId, productTitle, storeName, initial }: { productId: string; productTitle: string; storeName: string; initial: ThanksNote | null }) {
  const [saved, setSaved] = useState<Fields>(() => fieldsOf(initial));
  const [fields, setFields] = useState<Fields>(saved);
  const [has, setHas] = useState(initial !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  useLeaveGuard(dirty && !busy);

  async function send(note: Fields | null) {
    if (busy) return;
    const expected = note === null ? null : readNote(note);
    if (typeof expected === "string") {
      setError(MESSAGES[expected]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/thanks-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, note }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (!response.ok || data?.ok !== true || data.error || !Object.prototype.hasOwnProperty.call(data, "note") || (expected === null ? data.note !== null : JSON.stringify(parseNote(data.note)) !== JSON.stringify(expected))) {
        const problem = data?.ok === true ? undefined : data?.error;
        setError(typeof problem === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, problem) ? MESSAGES[problem] : "We could not confirm this note. Reload this page to check before trying again.");
        return;
      }
      const kept = fieldsOf(expected);
      setSaved(kept);
      setFields(kept);
      setHas(expected !== null);
      toast(note ? "After-payment note settings saved." : "Note removed.");
    } catch {
      setError("We could not confirm this note. Reload this page to check before trying again.");
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields({ ...fields, [key]: event.target.value });
  const count = (value: string, max: number) => <span className="text-xs tabular-nums text-ink-mute">{`${value.length}/${max}`}</span>;

  return (
    <section aria-busy={busy} id="after-paying" aria-labelledby="after-paying-title" className="card mt-6 scroll-mt-32 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="after-paying-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            After paying: a note from you
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            {`What buyers of ${productTitle} read on the thank-you page, under what they bought, and in their confirmation email: what to do first, a welcome video, one button to your group, a booking or a next step.`}
          </p>
        </div>
        <span className={`tag ${has ? "tag-live" : ""}`}>{has ? "On" : "None"}</span>
      </div>
      <div className="mt-5 space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="note-heading" className="field-label">Heading (optional)</label>
            {count(fields.heading, MAX_NOTE_HEADING)}
          </div>
          <input disabled={busy} id="note-heading" className="field" maxLength={MAX_NOTE_HEADING} value={fields.heading} placeholder={`A note from ${storeName}`} onChange={set("heading")} />
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="note-body" className="field-label">Your note</label>
            {count(fields.body, MAX_NOTE_BODY)}
          </div>
          <textarea
            disabled={busy}
            id="note-body"
            className="field"
            rows={5}
            maxLength={MAX_NOTE_BODY}
            value={fields.body}
            placeholder={"Thank you for joining! Start with the first lesson today, then come and say hello in the group.\n\n- Read the welcome guide\n- Join the group"}
            onChange={set("body")}
          />
          <p className="mt-1 text-xs text-ink-soft">A blank line starts a new paragraph, a line starting with &ldquo;- &rdquo; is a point, and a full https address becomes a link.</p>
        </div>
        <div>
          <label htmlFor="note-video" className="field-label">Video (optional)</label>
          <input disabled={busy} id="note-video" className="field" inputMode="url" value={fields.video} placeholder="https://www.youtube.com/watch?v=…" onChange={set("video")} />
          <p className="mt-1 text-xs text-ink-soft">From YouTube, Vimeo or Loom. It loads only when the buyer presses play.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="note-label" className="field-label">Button words (optional)</label>
            <input disabled={busy} id="note-label" className="field" maxLength={MAX_NOTE_LABEL} value={fields.label} placeholder="Join the group" onChange={set("label")} />
          </div>
          <div>
            <label htmlFor="note-url" className="field-label">Where the button goes</label>
            <input disabled={busy} id="note-url" className="field" inputMode="url" maxLength={MAX_LINK_LENGTH} value={fields.url} placeholder="https://" onChange={set("url")} />
          </div>
        </div>
        <p className="text-xs text-ink-soft">The button opens in a new tab, with the site it leads to written under it.</p>
      </div>
      {error ? (
        <p className="notice notice-error mt-4" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} aria-busy={busy} onClick={() => void send(fields)}>
          {busy ? "Saving…" : "Save the note"}
        </button>
        {has ? (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send(null)}>
            Remove
          </button>
        ) : null}
      </div>
    </section>
  );
}
