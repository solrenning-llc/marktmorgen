"use client";

import { useEffect, useRef, useState } from "react";

/** Not before the visitor has been here this long: a glance is not a visit. */
const SETTLED_MS = 8_000;
/** Shown once per store per visitor in this many days. */
const QUIET_DAYS = 30;
/** Set when the visitor turns such offers off: no store's leaving offer shows again in this browser (WCAG 2.2.4). */
const OFF_KEY = "nl_exit_off";

/**
 * The creator's free product, offered once to a visitor who is about to
 * leave (lib/exit-offer.ts, chosen in the studio).
 *
 * Measured before it was built (7 October 2026): Hotmart's checkout and
 * Whop's store pages both offer a popup as a visitor leaves; Stan has none.
 * What keeps this one fair:
 *
 *   - Only on a computer, when the pointer leaves through the top of the
 *     window — the move toward the tabs or the address bar — and only after
 *     the visitor has been on the page a few seconds. Never on a phone, where
 *     "about to leave" cannot be told from scrolling, and never on load.
 *   - Once per visitor per store in a month, remembered in this browser only.
 *     Closed with the button, Escape, or a click outside; nothing comes back.
 *     "Don't show offers like this" turns every store's leaving offer off in
 *     this browser (WCAG 2.2.4).
 *   - It offers something free, says so, and asks for nothing but an address,
 *     with the same unticked box for more email the page itself has. No
 *     countdown, no "wait!", no discount that was not on offer to everyone.
 */
export function ExitOffer({
  store,
  title,
  words,
  children,
}: {
  store: string;
  title: string;
  /** In the store's language (lib/buyer-words). */
  words: { close: string; beforeYouGo: string; noMore: string };
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [armed, setArmed] = useState(false);
  const key = `nl_exit_${store}`;

  useEffect(() => {
    let seen = false;
    try {
      const at = Number(window.localStorage.getItem(key) || 0);
      seen = (at > 0 && Date.now() - at < QUIET_DAYS * 86_400_000) || window.localStorage.getItem(OFF_KEY) === "1";
    } catch {
      // Without storage it may show again another day, which is acceptable.
    }
    if (seen || !window.matchMedia("(pointer: fine)").matches) return;
    const timer = window.setTimeout(() => setArmed(true), SETTLED_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  useEffect(() => {
    if (!armed) return;
    const leave = (event: MouseEvent) => {
      if (event.relatedTarget !== null || event.clientY > 0) return;
      document.removeEventListener("mouseout", leave);
      try {
        window.localStorage.setItem(key, String(Date.now()));
      } catch {}
      dialog.current?.showModal();
    };
    document.addEventListener("mouseout", leave);
    return () => document.removeEventListener("mouseout", leave);
  }, [armed, key]);

  return (
    <dialog
      ref={dialog}
      className="st-exit"
      aria-labelledby="exit-title"
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="st-card st-exit-card p-6 sm:p-8">
        <button type="button" className="st-exit-close" aria-label={words.close} onClick={() => dialog.current?.close()}>
          ×
        </button>
        <p className="st-label">{words.beforeYouGo}</p>
        <h2 id="exit-title" className="font-display mt-2 text-2xl font-semibold leading-tight">
          {title}
        </h2>
        {children}
        <button
          type="button"
          className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          onClick={() => {
            try {
              window.localStorage.setItem(OFF_KEY, "1");
            } catch {}
            dialog.current?.close();
          }}
        >
          {words.noMore}
        </button>
      </div>
    </dialog>
  );
}
