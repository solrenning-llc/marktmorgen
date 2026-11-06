"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { useLeaveGuard } from "@/components/leave-guard";
import { toast } from "@/components/toast";
import { PROVIDER_NAMES, type Video, readVideo, videoAddress } from "@/lib/sales-page";

/**
 * The welcome video under the store's name (lib/store.ts, intro): pasted as
 * it is copied from YouTube, Vimeo or Loom, checked as it is typed, and
 * played on the page only when a visitor presses play.
 */
export function IntroEditor({ intro }: { intro: Video | null }) {
  const router = useRouter();
  const [url, setUrl] = useState(intro ? videoAddress(intro) : "");
  const [saved, setSaved] = useState(intro ? videoAddress(intro) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const video = url.trim() ? readVideo(url) : null;
  const wrong = url.trim() !== "" && !video;
  const changed = saved !== (video ? videoAddress(video) : url.trim());
  useLeaveGuard(changed);

  async function save(next: string) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/store/intro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: next }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const expected = next ? readVideo(next) : null;
      const saved = data.intro;
      const matches = expected === null
        ? saved === null
        : saved !== null && typeof saved === "object" && !Array.isArray(saved)
          && (saved as Record<string, unknown>).provider === expected.provider
          && (saved as Record<string, unknown>).id === expected.id
          && (saved as Record<string, unknown>).hash === expected.hash;
      if (response.ok && data.ok === true && data.error === undefined && matches) {
        // Committed at once, so useLeaveGuard's cleanup has run before the toast says it was saved: a page that says
        // "saved" never still asks before leaving.
        flushSync(() => setSaved(expected ? videoAddress(expected) : ""));
        toast(next ? "Welcome video settings saved." : "Welcome video removed.");
        router.refresh();
        return;
      }
      setError("We could not confirm whether your welcome video settings were saved. Reload this page to check before trying again.");
    } catch {
      setError("We could not confirm whether your welcome video settings were saved. Reload this page to check before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (!wrong && !saving) void save(url.trim());
      }}
      noValidate
    >
      <label htmlFor="intro-url" className="field-label">Welcome video (optional)</label>
      <input
        id="intro-url"
        disabled={saving}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://www.youtube.com/watch?v=…"
        aria-invalid={wrong ? true : undefined}
        aria-describedby="intro-note"
        className="field mt-2"
      />
      <p id="intro-note" className={`mt-1 text-sm ${wrong ? "font-semibold text-danger-text" : "text-ink-soft"}`}>
        {wrong
          ? "That is not a YouTube, Vimeo or Loom video address."
          : video
            ? `A ${PROVIDER_NAMES[video.provider]} video, under your name. It loads only when a visitor presses play.`
            : "A short hello under your name: who you are and what your store is for. YouTube, Vimeo or Loom."}
      </p>
      {error ? <p role="alert" className="mt-2 text-sm font-semibold text-danger-text">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={saving || wrong || !changed} className="btn btn-secondary btn-sm">
          {saving ? "Saving…" : "Save the video"}
        </button>
        {intro ? (
          <button type="button" disabled={saving} onClick={() => { setUrl(""); void save(""); }} className="btn btn-ghost btn-sm">
            Remove it
          </button>
        ) : null}
      </div>
    </form>
  );
}
