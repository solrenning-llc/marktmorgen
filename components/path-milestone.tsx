"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { markSeen, milestoneKey, nextMilestone, readSeen, type Milestone } from "@/lib/path-milestone-rules";

/** The device's value changes under this page only by this card, which keeps its own state. */
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

/**
 * Whether this browser can keep a mark at all, tested once a page load with a write that is removed at once. A browser
 * that reads but cannot write (a full storage) could never show a card only once, so it shows none (Claude 3's F3 on #3138).
 */
let writable: boolean | undefined;
function canKeep(): boolean {
  if (writable !== undefined) return writable;
  try {
    window.localStorage.setItem("mm:pm:probe", "1");
    window.localStorage.removeItem("mm:pm:probe");
    writable = true;
  } catch {
    writable = false;
  }
  return writable;
}

/**
 * A step on the Path that the store's records show done, once (654 [WG14], part (b1);
 * lib/path-milestone-rules.ts). Nothing is drawn on the server or before the device
 * is read, nothing where storage is blocked or cannot be written (it could not be shown
 * only once), and nothing once every recorded step was seen. Its words name the step
 * and nothing else: no amount, no ranking, no counter. The line under the heading is
 * drawn once, only when motion is welcome (app/globals.css, .mm-milestone-line).
 *
 * After a Dismiss that shows the next step, the change is said in the card's own status
 * region and focus stays on Dismiss; after the last one, a short "all seen" line takes
 * the focus, so it never falls to the page (Claude 3's F1 on #3138, WCAG 2.4.3, 4.1.3).
 * Dismiss reads what this browser keeps again and adds to it, so another tab's marks
 * are never lost and no step is written twice (F2).
 */
export function PathMilestone({ sid, done, shareHref }: { sid: string; done: readonly Milestone[]; shareHref: string | null }) {
  const key = milestoneKey(sid);
  const raw = useSyncExternalStore(noSubscription, () => kept(key), () => undefined);
  const keeps = useSyncExternalStore(noSubscription, canKeep, () => false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const allSeen = useRef<HTMLParagraphElement>(null);
  const seen = raw === undefined || !keeps ? null : readSeen(raw);
  const shown = nextMilestone(done, seen ? [...seen, ...dismissed] : null);
  const finished = Boolean(seen) && dismissed.length > 0 && !shown;
  useEffect(() => {
    if (finished) allSeen.current?.focus();
  }, [finished]);
  if (!key || !seen || (!shown && !finished)) return null;
  function dismiss(id: string) {
    const now = readSeen(kept(key) ?? null) ?? [];
    const union = [...new Set([...(seen as string[]), ...now, ...dismissed])];
    try {
      window.localStorage.setItem(key as string, markSeen(union, id));
    } catch {
      // Storage refused this write since the page was read: hidden for this visit only.
    }
    const next = nextMilestone(done, [...union, id]);
    setSaid(next ? `Next step recorded: ${next.title}` : "");
    setDismissed((list) => [...list, id]);
  }
  return (
    <section aria-labelledby="path-milestone-heading" className="card mt-8 min-w-0 p-6" data-path-milestone>
      <h2 id="path-milestone-heading" className="t-h3">Step recorded</h2>
      {shown ? (
        <>
          <span aria-hidden="true" className="mm-milestone-line mt-3 block h-1 w-16 rounded-full bg-current" />
          <p className="mt-3 min-w-0 [overflow-wrap:anywhere]">{shown.title}</p>
          <p className="mt-2 text-sm text-ink-soft">Your store&apos;s records show this step done.</p>
          <div className="mt-4 flex min-w-0 flex-wrap gap-3">
            {shareHref ? (
              <a href={shareHref} className="btn btn-sm btn-wrap min-w-0" onClick={() => dismiss(shown.id)}>
                Share a thank-you
              </a>
            ) : null}
            <button type="button" className="btn btn-sm btn-ghost btn-wrap min-w-0" onClick={() => dismiss(shown.id)}>
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <p ref={allSeen} tabIndex={-1} className="mt-3 min-w-0">
          You have seen every recorded step.
        </p>
      )}
      <p role="status" className="sr-only">{said}</p>
    </section>
  );
}
