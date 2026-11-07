"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { lastKey, lastShown, readLast } from "@/lib/lesson-position-rules";

/** The device's value never changes under this page on its own: read once, on the client. */
const noSubscription = () => () => {};

/** What this browser keeps under a key, or null where nothing is kept or storage is blocked. */
function kept(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * "Continue where you left off" in a buyer's library (650 [WG10], unit 2): the
 * last lesson they opened in this browser, read only from the device
 * (components/remember-last-lesson.tsx), under the key the server made from
 * the library's own address. Nothing is drawn on the server or before the
 * device is read, and nothing when no lesson is kept, so the card never shows
 * something that is not there. One kept but unreadable or too old is removed.
 * A lesson from a store the library does not show (`open`, the handles it
 * shows, or null when it could not read every store) is not drawn, and is
 * kept: it lapses after KEEP_DAYS like any other.
 */
export function LibraryContinue({ person, open }: { person: string; open: readonly string[] | null }) {
  const key = lastKey(person);
  const raw = useSyncExternalStore(noSubscription, () => kept(key), () => null);
  const [now] = useState(() => Date.now());
  const read = raw === null ? null : readLast(raw, now);
  useEffect(() => {
    if (!key || raw === null || read) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing to remove.
    }
  }, [key, raw, read]);
  const last = lastShown(read, open);
  if (!last) return null;
  return (
    <section aria-labelledby="library-continue-heading" className="card mt-6 min-w-0 p-5" data-library-continue>
      <h2 id="library-continue-heading" className="text-lg font-semibold">Continue where you left off</h2>
      <p className="mt-2 min-w-0 text-ink-soft [overflow-wrap:anywhere]">{`${last.course}, from ${last.store}. The last lesson you opened in this browser.`}</p>
      <div className="mt-4 flex min-w-0 flex-wrap gap-3">
        <a href={last.path} className="btn btn-primary btn-sm btn-wrap min-w-0">
          <span className="min-w-0 [overflow-wrap:anywhere]">{`Continue “${last.lesson}”`}</span>
        </a>
      </div>
    </section>
  );
}
