"use client";

import { useId, useState } from "react";

/**
 * A draft's private preview link, made and stopped from the studio (754 [STN1],
 * unit 4b; app/api/store/draft-preview). The link is shown once, with a Copy
 * button and the day it ends; making a new one ends the one before, and "Stop
 * this link" ends it at once. Every answer is said in a live region.
 */
export function DraftPreviewLink({ productId, handle }: { productId: string; handle: string }) {
  const statusId = useId();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; until: string } | null>(null);
  const [said, setSaid] = useState("");

  async function send(action: "make" | "revoke") {
    if (busy) return;
    setBusy(true);
    setSaid("");
    try {
      const response = await fetch("/api/store/draft-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: productId }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; code?: string; expiresAt?: number; error?: string } | null;
      if (!response.ok || !data?.ok) {
        setSaid(
          data?.error === "not_draft"
            ? "This product is on your store, so its own page is the preview."
            : "The preview link could not be changed just now. Try again in a minute.",
        );
        return;
      }
      if (action === "revoke") {
        setLink(null);
        setSaid("The preview link is stopped. Nobody can open it now.");
        return;
      }
      if (typeof data.code !== "string" || typeof data.expiresAt !== "number") {
        setSaid("The preview link could not be changed just now. Try again in a minute.");
        return;
      }
      const until = new Date(data.expiresAt * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      setLink({ url: `${window.location.origin}/@${handle}/preview/${data.code}`, until });
      setSaid(`A new preview link is ready. It works until ${until}. Any older link no longer works.`);
    } catch {
      setSaid("The preview link could not be changed just now. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setSaid("The preview link is copied.");
    } catch {
      setSaid("Copying did not work here. Select the link and copy it yourself.");
    }
  }

  return (
    <div className="mt-3 space-y-2" data-draft-preview>
      <p className="text-sm text-ink-soft">Show this draft to someone before you publish it. Only people with the link can see it, for seven days.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" aria-busy={busy} disabled={busy} aria-describedby={statusId} onClick={() => void send("make")}>
          {link ? "Make a new preview link" : "Get a private preview link"}
        </button>
        {link ? (
          <button type="button" className="btn btn-secondary btn-sm" aria-busy={busy} disabled={busy} onClick={() => void send("revoke")}>
            Stop this link
          </button>
        ) : null}
      </div>
      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`${statusId}-url`}>
            Private preview link
          </label>
          <input id={`${statusId}-url`} className="field min-w-0 flex-1" readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
            Copy
          </button>
        </div>
      ) : null}
      <p id={statusId} role="status" className="text-sm text-ink">
        {said}
      </p>
    </div>
  );
}
