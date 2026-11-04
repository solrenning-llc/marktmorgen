"use client";

import { suggestEmail } from "@/lib/email-typo";
import { emailTypoWords } from "@/lib/buyer-words/email-typo";

/**
 * The "Did you mean …?" line under an email field (308 [TC1], lib/email-typo.ts).
 *
 * Put it right after the field, give the field `aria-describedby` with this
 * `id`, and pass `show` once the person has left the field or tried to send.
 * The region is always on the page and polite, so a screen reader reads the
 * suggestion when it appears without moving the focus. The button puts the
 * suggested address in the field and gives the focus back to it; nothing is
 * changed without that tap, and nothing stops the form from being sent.
 * Runs in the browser only: no request is made because of it.
 */
export function EmailSuggestion({
  id,
  inputId,
  value,
  show,
  onUse,
  language = "en",
  store = false,
}: {
  id: string;
  inputId: string;
  value: string;
  show: boolean;
  onUse: (address: string) => void;
  language?: string;
  /** On a store's own pages: its look (st-*), not the site's. */
  store?: boolean;
}) {
  const suggested = show ? suggestEmail(value) : null;
  const words = emailTypoWords(language);
  return (
    <div id={id} aria-live="polite" data-email-suggestion>
      {suggested ? (
        <div className={store ? "st-note mt-2 text-sm [overflow-wrap:anywhere]" : "mt-2 rounded-2xl border border-transparent bg-paper p-3 text-sm text-ink ring-1 ring-line [overflow-wrap:anywhere]"}>
          <p className="font-semibold">{words.didYouMean(suggested)}</p>
          <p className={store ? "st-muted mt-1" : "mt-1 text-ink-soft"}>{words.keep}</p>
          <button
            type="button"
            className={`btn ${store ? "st-btn-ghost" : "btn-secondary"} btn-sm mt-2 max-w-full whitespace-normal [overflow-wrap:anywhere]`}
            onClick={() => {
              onUse(suggested);
              document.getElementById(inputId)?.focus();
            }}
          >
            {words.use(suggested)}
          </button>
        </div>
      ) : null}
    </div>
  );
}
