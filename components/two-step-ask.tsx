"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons";
import { TWO_STEP_ASK_DISMISSED, TWO_STEP_ASK_HREF, TWO_STEP_ASK_WORDS, askShown, twoStepAskKey } from "@/lib/two-step-ask-rules";

/** The browser's value changes under this page only by this note, which keeps its own state. */
const noSubscription = () => () => {};

/** What this browser keeps under a key; null where nothing is kept, undefined where storage is blocked. */
function kept(key: string | null): string | null | undefined {
  if (!key) return undefined;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

/** Whether this browser can keep a dismissal at all, tested once a page load with a write removed at once. */
let writable: boolean | undefined;
function canKeep(): boolean {
  if (writable !== undefined) return writable;
  try {
    window.localStorage.setItem("mm:2fa-ask:probe", "1");
    window.localStorage.removeItem("mm:2fa-ask:probe");
    writable = true;
  } catch {
    writable = false;
  }
  return writable;
}

/**
 * The studio's ask to turn on two-step login, after the store's first sale
 * (757 [STN4] unit 3; lib/two-step-ask-rules.ts). The page draws it only for
 * an account with no second step whose store's first sale is known.
 *
 * A status region that is there from the first paint, empty on the server, so
 * the note is said politely once the browser has read its dismissal, and the
 * line after dismissing is said too (WCAG 4.1.3). Nothing is drawn where the
 * dismissal could not be kept. No timer and no motion. Dismissing writes one
 * short value under the store's own key and moves the focus to the line that
 * says where to find it again, never to the top of the page (2.4.3).
 */
export function TwoStepAsk({ sid }: { sid: string }) {
  const key = twoStepAskKey(sid);
  const raw = useSyncExternalStore(noSubscription, () => kept(key), () => undefined);
  const keeps = useSyncExternalStore(noSubscription, canKeep, () => false);
  const [dismissed, setDismissed] = useState(false);
  const said = useRef<HTMLParagraphElement>(null);
  const shown = !dismissed && askShown(raw, keeps);
  const words = TWO_STEP_ASK_WORDS;

  useEffect(() => {
    if (dismissed) said.current?.focus();
  }, [dismissed]);

  function dismiss() {
    try {
      if (key) window.localStorage.setItem(key, TWO_STEP_ASK_DISMISSED);
    } catch {
      // Refused since the page was read: hidden for this visit only.
    }
    setDismissed(true);
  }

  return (
    <div role="status">
      {shown ? (
        <section aria-labelledby="two-step-ask-title" className="notice mt-6 flex items-start gap-3">
          <Icon name="shield" className="mt-0.5 shrink-0 text-ink" />
          <div className="min-w-0 flex-1">
            <h2 id="two-step-ask-title" className="font-bold text-ink">
              {words.title}
            </h2>
            <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{words.body}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <a href={TWO_STEP_ASK_HREF} className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4">
                {words.link}
              </a>
              <button
                type="button"
                onClick={dismiss}
                className="inline-flex min-h-11 min-w-11 items-center text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
              >
                {words.dismiss}
              </button>
            </div>
          </div>
        </section>
      ) : dismissed ? (
        <p ref={said} tabIndex={-1} className="mt-6 max-w-[80ch] text-sm text-ink-soft">
          {words.dismissed}
        </p>
      ) : null}
    </div>
  );
}
