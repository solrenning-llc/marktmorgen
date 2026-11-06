"use client";

import { useEffect, useRef, useState } from "react";
import { digitalConsentWords } from "@/lib/buyer-words/digital-consent";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD, type ConsentKind, EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { CLOSING_ACCESS_SENTENCE, CLOSING_TERMS_PATH, CLOSING_TERMS_WORDS } from "@/lib/closing-buyers-rules";

/**
 * The box a buyer checks before paying for something handed over during the
 * 14-day cancellation period (lib/digital-consent.ts): a real checkbox with
 * its visible label, never checked for them, and required, so the browser
 * itself stops the form and says why, with JavaScript or without. The server
 * checks it again whatever the browser did. `kind` picks the sentence: digital
 * content sold once, or a membership (lib/digital-consent.ts, consentKind).
 *
 * The whole label is the target (at least 44 px high); the note under it is
 * tied to the box by aria-describedby. When the server refused a payment for
 * want of it (`refused`):
 *
 *   - the reason is written beside the box and tied to it by
 *     aria-describedby, and the box is marked invalid, so it reads the same
 *     with scripts off;
 *   - with scripts on, the box takes the focus and the reason is put into a
 *     live region a moment after the page is drawn, so it is announced
 *     rather than sitting in an alert that was there from the start;
 *   - checking the box clears both the mark and the reason.
 */
export function DigitalConsentBox({
  id,
  lang,
  kind = "digital",
  refused = false,
  required = true,
  className = "",
}: {
  id: string;
  lang: string;
  kind?: ConsentKind;
  refused?: boolean;
  /** False only where nothing but a product added at checkout is opened at once: the server then asks for it only if that is checked. */
  required?: boolean;
  className?: string;
}) {
  const c = digitalConsentWords(lang);
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const [invalid, setInvalid] = useState(refused);
  const [announced, setAnnounced] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!refused) return;
    box.current?.focus();
    const later = setTimeout(() => setAnnounced(c.needed), 150);
    return () => clearTimeout(later);
  }, [refused, c.needed]);
  return (
    <div className={`text-sm ${className}`} data-digital-consent="">
      {invalid ? (
        <p id={errorId} className="st-note mb-2 font-semibold">
          {c.needed}
        </p>
      ) : null}
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {invalid ? announced : ""}
      </p>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 py-1" style={{ color: "var(--st-text)" }}>
        <input
          ref={box}
          id={id}
          type="checkbox"
          name={CONSENT_FIELD}
          value="yes"
          required={required}
          aria-describedby={invalid ? `${errorId} ${noteId}` : noteId}
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => {
            if (event.currentTarget.checked) {
              setInvalid(false);
              setAnnounced("");
            }
          }}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span>{c.box[kind]}</span>
      </label>
      <input type="hidden" name={CONSENT_VERSION_FIELD} value={EU_WITHDRAWAL_CONSENT_VERSION} />
      <p id={noteId} className="st-muted mt-1 text-xs">
        {required ? c.note : c.noteAdded}
      </p>
      {/* The fixed sentence of queue item 307 [EC1], before every payment for something that lasts: drawn here, never the creator's, in US English. */}
      <p lang="en" className="st-muted mt-2 text-sm" data-closing-access="">
        {CLOSING_ACCESS_SENTENCE}{" "}
        <a href={CLOSING_TERMS_PATH} className="underline underline-offset-2">
          {`${CLOSING_TERMS_WORDS}.`}
        </a>
      </p>
    </div>
  );
}
