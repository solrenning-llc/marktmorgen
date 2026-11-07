"use client";

import { useState, useSyncExternalStore } from "react";
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
 * A step on the Path that the store's records show done, once (654 [WG14], part (b1);
 * lib/path-milestone-rules.ts). Nothing is drawn on the server or before the device
 * is read, nothing where storage is blocked (it could not be shown only once), and
 * nothing once every recorded step was seen. Its words name the step and nothing
 * else: no amount, no ranking, no counter. The line under the heading is drawn once,
 * only when motion is welcome (app/globals.css, .mm-milestone-line).
 */
export function PathMilestone({ sid, done, shareHref }: { sid: string; done: readonly Milestone[]; shareHref: string | null }) {
  const key = milestoneKey(sid);
  const raw = useSyncExternalStore(noSubscription, () => kept(key), () => undefined);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const seen = raw === undefined ? null : readSeen(raw);
  const shown = nextMilestone(done, seen ? [...seen, ...dismissed] : null);
  if (!shown || !key || !seen) return null;
  function dismiss(id: string) {
    try {
      window.localStorage.setItem(key as string, markSeen([...(seen as string[]), ...dismissed], id));
    } catch {
      // Storage blocked since the page was read: hidden for this visit only.
    }
    setDismissed((list) => [...list, id]);
  }
  return (
    <section aria-labelledby="path-milestone-heading" className="card mt-8 min-w-0 p-6" data-path-milestone>
      <h2 id="path-milestone-heading" className="t-h3">Step recorded</h2>
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
    </section>
  );
}
