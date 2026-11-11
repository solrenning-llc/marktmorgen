"use client";

import { useState, useSyncExternalStore } from "react";
import { EmailField } from "@/components/email-field";
import { returningCodeWords } from "@/lib/buyer-words/returning-code";
import { type ReturningRefusal, readRefusal, readTypedCode } from "@/lib/returning-code-rules";

/**
 * The field on the buy form for a code only for people who already bought
 * from this store (554 [DS1], unit 2; lib/returning-code-rules.ts). Closed
 * until the buyer opens it; both boxes start empty, and an empty code sends
 * nothing to be checked.
 *
 * When the server did not take a code it sends the buyer back here with the
 * reason and the code in the address (app/api/store/checkout/route.ts): the
 * field opens, the reason is said beside it, and the code is filled in again
 * so it is not typed twice (WCAG 3.3.7). The email is never in the address;
 * the browser offers it again (autocomplete="email").
 */
/** The address does not change while the page is open: nothing to subscribe to. */
const stays = () => () => {};
const refusalHere = () => readRefusal(new URLSearchParams(window.location.search).get("returning"));
const codeHere = () => readTypedCode(new URLSearchParams(window.location.search).get("rc"));
const nothing = () => null;
const empty = () => "";

export function ReturningCodeBox({ id, lang, className = "" }: { id: string; lang: string; className?: string }) {
  const w = returningCodeWords(lang);
  // Read from the address once the page is in the browser; on the server there is none.
  const refused: ReturningRefusal | null = useSyncExternalStore(stays, refusalHere, nothing);
  const sentBack = useSyncExternalStore(stays, codeHere, empty);
  // What the buyer types wins; until then, the code that was sent back.
  const [typed, setTyped] = useState<string | null>(null);
  const code = typed ?? (refused ? sentBack : "");
  const setCode = (value: string) => setTyped(value);
  const error = `${id}-error`;
  const note = `${id}-note`;
  return (
    <details id="returning" open={refused !== null} className={`scroll-mt-24 rounded-2xl px-4 py-3 text-sm ${className}`} style={{ border: "1px solid var(--st-line)" }}>
      <summary className="flex min-h-11 cursor-pointer items-center font-medium">{w.open}</summary>
      <p id={note} className="st-muted mt-1 text-xs">
        {w.note}
      </p>
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
            onChange={(event) => setCode(event.target.value)}
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
          <EmailField id={`${id}-email`} name="remail" className="st-field" autoComplete="email" language={lang} describedBy={refused === "email" || refused === "bought" ? `${error} ${id}-email-note` : `${id}-email-note`} />
          <p id={`${id}-email-note`} className="st-muted mt-1 text-xs">
            {w.emailNote}
          </p>
        </div>
      </div>
    </details>
  );
}
