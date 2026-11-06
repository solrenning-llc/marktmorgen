"use client";

import { useEffect, useRef, useState } from "react";
import { BLOCKING_KINDS, type TermsCheckInput, type TermsWarningKind, checkCreatorTerms, replaceWords, withoutSentence } from "@/lib/terms-check-rules";

/** What each kind of warning is called, in plain words. */
const TITLES: Record<TermsWarningKind, string> = {
  other_company: "Names another company or site",
  price_mismatch: "A different price",
  no_refunds: "No refunds",
  earnings_claim: "A promise of earnings or results",
  fast_money: "Fast or easy money: not allowed by the Terms",
  false_urgency: "Urgency with nothing real behind it",
  resale_rights: "Resale rights",
};

export const countWords = (n: number) => (n === 1 ? "One thing to check" : `${n} things to check`);

/**
 * The text a press of a fix button leaves, or null for none: the second click of a double click (`detail` > 1) lands
 * on whatever moved under the cursor and never applies another fix, and a fix that changes nothing is not one.
 */
export function fixFromClick(detail: number, current: string, next: string): string | null {
  return detail > 1 || next === current ? null : next;
}

/**
 * The warnings on what a creator wrote (493 [DE2]), shown under the text while they write it, before they save. It
 * flags; it changes nothing by itself: each fix is applied only when the creator presses its button (a double click
 * applies one fix, never a second one under the cursor), only while the words it was shown for are still there, and
 * the last one can be undone. They still choose to save. Pure and in the browser (lib/terms-check-rules.ts): no
 * request, no model, no cost.
 *
 * For screen readers, one status line stays on the page all the time, so the first warning and the last fix are
 * both announced; after a fix, focus goes to the panel's heading, or back to the text field (`fieldId`) when nothing
 * is left to check.
 */
export function TermsCheckPanel({ id, fieldId, input, onChange }: { id: string; fieldId: string; input: TermsCheckInput; onChange: (text: string) => void }) {
  const warnings = checkCreatorTerms(input);
  const heading = `terms-check-${id}`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    if (warnings.length) headingRef.current?.focus();
    else document.getElementById(fieldId)?.focus();
  });

  const apply = (event: { detail: number }, proposed: string) => {
    const next = fixFromClick(event.detail, input.text, proposed);
    if (next === null) return;
    moveFocus.current = true;
    setUndo({ before: input.text, after: next });
    onChange(next);
  };
  const canUndo = undo !== null && undo.after === input.text;
  const status = warnings.length
    ? `${countWords(warnings.length)} in what you wrote.`
    : input.text.trim() ? "Nothing to check in what you wrote." : "";

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {canUndo ? (
        <p className="mt-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { moveFocus.current = true; setUndo(null); onChange(undo.before); }}>
            Undo the last change
          </button>
        </p>
      ) : null}
      {warnings.length ? (
        <section aria-labelledby={heading} className="notice notice-warn mt-3" data-terms-check="">
          <h3 id={heading} ref={headingRef} tabIndex={-1} className="font-semibold text-ink">
            {`${countWords(warnings.length)} before you save`}
          </h3>
          <p className="mt-1 text-sm text-ink-soft">These are suggestions, not legal advice. Nothing changes unless you press a button below and then save.</p>
          {warnings.some((w) => BLOCKING_KINDS.has(w.kind)) ? (
            <p className="mt-1 text-sm font-semibold text-ink">
              A promise of fast or easy money keeps this product off your store until it is changed: the Terms do not allow it. The others are only suggestions.
            </p>
          ) : null}
          <ul className="mt-3 space-y-4">
            {warnings.map((w) => {
              const words = input.text.slice(w.at, w.at + w.length);
              return (
                <li key={`${w.kind}:${w.at}`} className="text-sm">
                  <p className="font-semibold text-ink">{TITLES[w.kind]}</p>
                  <p className="mt-1 text-ink-soft">
                    <span className="sr-only">Your words: </span>
                    <q>{w.excerpt}</q>
                  </p>
                  <p className="mt-1 text-ink-soft">{w.why}</p>
                  <p className="mt-1 text-ink">{w.fix}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {w.replacement ? (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => apply(e, replaceWords(input.text, w.at, w.length, words, w.replacement!))}>
                        {`Change ${words.replace(/\s/g, "")} to ${w.replacement}`}
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => apply(e, withoutSentence(input.text, w.at, words))}>
                      Remove this sentence
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
