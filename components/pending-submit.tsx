"use client";

import { useState } from "react";

/**
 * A submit button that says it is working once pressed, for a plain HTML form
 * that posts to a route and leaves the page.
 *
 * On a slow phone the next page can take a few seconds to arrive, and a
 * button that looks the same after the tap gets tapped again. Here the tap
 * still submits the form the browser's own way — nothing is intercepted, and
 * without JavaScript it is an ordinary button — but the button shows a spinner
 * and the words of what is happening, and a second tap is ignored.
 *
 * The same words are said, politely, in a status region beside the button
 * (WCAG 2.2 4.1.3, #3953): it is there and empty from the start, because a
 * region added together with its text is not announced reliably, and focus
 * stays on the button.
 */
export function PendingSubmit({ label, pending, className }: { label: string; pending: string; className: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="submit"
        className={className}
        aria-busy={busy}
        onClick={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          // Native validation can cancel a click before it submits. Keep the
          // button available so the person can correct a required field and retry.
          const button = event.currentTarget;
          if (button.form && !button.formNoValidate && !button.form.noValidate && !button.form.checkValidity()) return;
          // Set after the browser has taken the submit, so the form still sends.
          setTimeout(() => setBusy(true), 0);
        }}
      >
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> {pending}
          </>
        ) : (
          label
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {busy ? pending : ""}
      </span>
    </>
  );
}
