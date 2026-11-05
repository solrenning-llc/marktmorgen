"use client";

import { useState } from "react";

/**
 * What the box says, in the store's language, with the store's name and the
 * product's title already in (lib/buyer-words/giving.ts, licenceKeyBoxWords).
 */
export type LicenceKeyWords = {
  label: string;
  copy: string;
  copied: string;
  yours: string;
  revoked: string;
  waiting: string;
  failed: string;
};

/** Today's English, for a page that passes no words. */
function english(storeName: string, title?: string): LicenceKeyWords {
  return {
    label: title ? `Your license key for ${title}` : "Your license key",
    copy: "Copy",
    copied: "Copied",
    yours: "It is yours alone: nobody else is given this key. It is also in your confirmation email and on your list of purchases.",
    revoked: `${storeName} has marked this key as no longer valid. If you think that is a mistake, reply to your order confirmation email and it reaches them.`,
    waiting: `Your payment went through just as ${storeName}'s keys ran out, so yours is not ready yet. They have been told, and it is emailed to you the moment they add more. It also appears here and on your list of purchases.`,
    failed: "Your key could not be shown just now. Refresh the page in a moment; it is kept for you.",
  };
}

/**
 * A buyer's licence key, shown where they will look for it: big enough to
 * read, in a type where 0 and O differ, selectable by hand, and with a button
 * that copies it. Works without scripts as plain selectable text.
 */
export function LicenceKeyBox({
  title,
  value,
  revoked = false,
  waiting = false,
  storeName,
  words,
}: {
  /** The product the key is for, when more than one key is on the page. */
  title?: string;
  value: string | null;
  revoked?: boolean;
  /** Paid while the creator's keys ran out: the key is emailed when they add more. */
  waiting?: boolean;
  storeName: string;
  /** Everything the box says, in the store's language; English when left out. */
  words?: LicenceKeyWords;
}) {
  const [copied, setCopied] = useState(false);
  const said = words ?? english(storeName, title);

  return (
    <div className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line-strong)", background: "var(--st-item)" }}>
      <p className="st-label">{said.label}</p>
      {value ? (
        <>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <code
              className="min-w-0 flex-1 select-all rounded-xl px-3 py-2 font-mono text-base font-semibold tracking-wide [overflow-wrap:anywhere] sm:text-lg"
              style={{ background: "var(--st-accent-soft)", color: "var(--st-text)", textDecoration: revoked ? "line-through" : undefined }}
            >
              {/* One text, read and copied whole; a long key wraps wherever it must (overflow-wrap: anywhere), with no element
                  per group, so a key from a creator's list of a hundred hyphens costs no more than its characters (C3-97). */}
              {value}
            </code>
            {revoked ? null : (
              <button
                type="button"
                className="btn st-btn btn-sm inline-flex min-h-11 items-center self-start sm:self-auto"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(value);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2200);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                <span aria-live="polite">{copied ? said.copied : said.copy}</span>
              </button>
            )}
          </div>
          <p className="st-muted mt-2 text-sm">{revoked ? said.revoked : said.yours}</p>
        </>
      ) : waiting ? (
        <p className="st-muted mt-2 text-sm">{said.waiting}</p>
      ) : (
        <p className="st-muted mt-2 text-sm">{said.failed}</p>
      )}
    </div>
  );
}
