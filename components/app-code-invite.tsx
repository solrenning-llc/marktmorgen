"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { APP_CODE_INVITE_HREF, appCodeInviteWords, inviteLanguage } from "@/lib/app-code-invite-words";
import type { LanguageCode } from "@/lib/store-language";

/** The browser's sessionStorage key that remembers the note was shown in this session (nothing is stored on our side). */
export const APP_CODE_INVITE_SEEN = "nl:app-code-invite-seen";

/**
 * Whether this page is the note's one showing in this browser session, and
 * if so, remembers it. Storage that throws or is missing (a private window,
 * blocked site data) never hides the note: it shows, and its close button
 * still works, page by page.
 */
export function claimShowing(storage: () => Pick<Storage, "getItem" | "setItem">): boolean {
  try {
    const kept = storage();
    if (kept.getItem(APP_CODE_INVITE_SEEN) === "1") return false;
    kept.setItem(APP_CODE_INVITE_SEEN, "1");
  } catch {
    // Nothing to remember it in: shown all the same.
  }
  return true;
}

/**
 * The studio's quiet invitation to add an app's code as a second step
 * (lib/app-code-invite-words.ts). The page renders it only for an account
 * with passkeys and no app (showAppCodeInvite), from what it already loaded.
 *
 * At most once per browser session: on its first showing it marks
 * sessionStorage, and a later page of the same session draws nothing. If the
 * browser refuses storage, it still shows and closes, page by page. It is a
 * named region, never a live one: it does not take the focus or interrupt a
 * screen reader; closing it puts the focus where the note was, not at the
 * top of the page. Drawn after the page loads, so the server never guesses.
 */
export function AppCodeInvite() {
  const [language, setLanguage] = useState<LanguageCode | null>(null);
  // Where the focus goes when the note is closed, so it does not fall back to the top of the page (2.4.3).
  const after = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!claimShowing(() => window.sessionStorage)) return;
    const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
    const chosen = inviteLanguage(preferred);
    // Read once from the browser after hydration; there is no server value to match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanguage(chosen);
  }, []);

  const words = language ? appCodeInviteWords(language) : null;

  return (
    <>
      {language && words ? (
        <section lang={language} aria-labelledby="app-code-invite-title" className="notice mt-6 flex items-start gap-3">
          <Icon name="shield" className="mt-0.5 shrink-0 text-ink" />
          <div className="min-w-0 flex-1">
            <h2 id="app-code-invite-title" className="font-bold text-ink">
              {words.title}
            </h2>
            <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{words.body}</p>
            <a href={APP_CODE_INVITE_HREF} className="mt-1 inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4">
              {words.link}
            </a>
          </div>
          <button
            type="button"
            aria-label={words.close}
            onClick={() => {
              setLanguage(null);
              after.current?.focus();
            }}
            className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper hover:text-ink"
          >
            <Icon name="close" size={18} />
          </button>
        </section>
      ) : null}
      <div ref={after} tabIndex={-1} className="outline-none" />
    </>
  );
}
