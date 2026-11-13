"use client";

import { useEffect, useRef, useState } from "react";

/** Not before the visitor has been here this long: a glance is not a visit. */
const SETTLED_MS = 8_000;
/** Shown once per store per visitor in this many days. */
const QUIET_DAYS = 30;

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
 *     "about to leave" cannot be told from scrolling, never on load, and never
     while a field, a box or an editable block has the focus, so it never takes
     the keyboard away from an address being typed
     (tests/exit-offer-interruption.test.ts).
 *   - Once per visitor per store in a month, remembered in this browser only.
 *     Closed with the button, Escape, or a click outside; nothing comes back.
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
  words: { close: string; beforeYouGo: string };
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [armed, setArmed] = useState(false);
  const key = `nl_exit_${store}`;

  useEffect(() => {
    let seen = false;
    try {
      const at = Number(window.localStorage.getItem(key) || 0);
      seen = at > 0 && Date.now() - at < QUIET_DAYS * 86_400_000;
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
      // Never over what the visitor is filling in: a dialog takes the keyboard focus, and the pointer moving
      // toward the tabs is not a request for one (WCAG 3.2.5 Change on Request, 2.2.4 Interruptions). Nothing is
      // remembered, so the offer is still free to come later in the same visit, once the field is left.
      const busy = document.activeElement as (Element & { isContentEditable?: boolean }) | null;
      if (busy && (["INPUT", "TEXTAREA", "SELECT"].includes(busy.tagName) || busy.isContentEditable)) return;
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
      </div>
    </dialog>
  );
}
