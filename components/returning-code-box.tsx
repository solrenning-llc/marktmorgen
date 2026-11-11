"use client";

import { useState, useSyncExternalStore } from "react";
import { EmailField } from "@/components/email-field";
import { returningCodeWords } from "@/lib/buyer-words/returning-code";
import { type ReturningStatus, readLinkToken, readRefusal, readTypedCode } from "@/lib/returning-code-rules";

/**
 * The field on the buy form for a code only for people who already bought
 * from this store (554 [DS1], unit 2; lib/returning-code.ts). Closed until
 * the buyer opens it; both boxes start empty.
 *
 * The code and the email only ask for a link ("Email me the link"): the
 * page then says, the same for every address, that a link was sent if the
 * email paid for an order here. The emailed link brings the buyer back here
 * with it in the address: the field opens, says the email is confirmed, and
 * the buy button carries the link, which alone opens the checkout with the
 * code. A refusal comes back with its reason, said beside the field, and
 * the typed code filled in again (WCAG 3.3.7); the email is never in an
 * address, and the browser offers it again (autocomplete="email").
 */
/** The address does not change while the page is open: nothing to subscribe to. */
const stays = () => () => {};
const query = () => new URLSearchParams(window.location.search);
const statusHere = () => readRefusal(query().get("returning"));
const codeHere = () => readTypedCode(query().get("rc"));
const tokenHere = () => readLinkToken(query().get("rtoken"));
const nothing = () => null;
const empty = () => "";

export function ReturningCodeBox({ id, lang, className = "" }: { id: string; lang: string; className?: string }) {
  const w = returningCodeWords(lang);
  // Read from the address once the page is in the browser; on the server there is none.
  const status: ReturningStatus | null = useSyncExternalStore(stays, statusHere, nothing);
  const sentBack = useSyncExternalStore(stays, codeHere, empty);
  const token = useSyncExternalStore(stays, tokenHere, empty);
  // What the buyer types wins; until then, the code that was sent back.
  const [typed, setTyped] = useState<string | null>(null);
  const code = typed ?? (status ? sentBack : "");
  const error = `${id}-error`;
  const note = `${id}-note`;
  const refused = status && status !== "sent" ? status : null;
  return (
    <details id="returning" open={status !== null || token !== ""} className={`scroll-mt-24 rounded-2xl px-4 py-3 text-sm ${className}`} style={{ border: "1px solid var(--st-line)" }}>
      <summary className="flex min-h-11 cursor-pointer items-center font-medium">{w.open}</summary>
      {token ? (
        <>
          {/* The emailed link: the buy button sends it, and only it opens the checkout with the code. */}
          <input type="hidden" name="rtoken" value={token} />
          <p className="st-note mt-2 text-sm" role="status">
            {w.confirmed}
          </p>
        </>
      ) : (
        <>
          <p id={note} className="st-muted mt-1 text-xs">
            {w.note}
          </p>
          {status === "sent" ? (
            <p className="st-note mt-2 text-sm" role="status">
              {w.sent}
            </p>
          ) : null}
          {refused ? (
            <p id={error} className="st-note mt-2 text-sm" role="alert">
              {w.refused[refused]}
            </p>
          ) : null}
          <div className="mt-3 space-y-3 pb-1">
            <div>
              <label htmlFor={`${id}-code`} className="st-label">
                {w.codeLabel}
              </label>
              <input
                id={`${id}-code`}
                name="rcode"
                className="st-field"
                value={code}
                onChange={(event) => setTyped(event.target.value)}
                maxLength={24}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby={refused === "code" ? `${error} ${note}` : note}
                aria-invalid={refused === "code" ? true : undefined}
              />
            </div>
            <div>
              <label htmlFor={`${id}-email`} className="st-label">
                {w.emailLabel}
              </label>
              <EmailField id={`${id}-email`} name="remail" className="st-field" autoComplete="email" language={lang} describedBy={refused === "email" ? `${error} ${id}-email-note` : `${id}-email-note`} />
              <p id={`${id}-email-note`} className="st-muted mt-1 text-xs">
                {w.emailNote}
              </p>
            </div>
            {/* Asking for the link is not buying: the boxes for buying are not checked for it. */}
            {/* name="rask": only this button asks for a link (the buy button never does); data-no-checkout: not a checkout started, for the pixels and the page's depth. */}
            <button type="submit" name="rask" value="1" formNoValidate data-no-checkout="" className="btn st-btn-ghost min-h-11">
              {w.send}
            </button>
          </div>
        </>
      )}
    </details>
  );
}
