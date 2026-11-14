"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES, LANGUAGE_CODES, isLanguage, type LanguageCode } from "@/lib/store-language";
import { NewTab } from "@/components/new-tab";

/**
 * The language a store speaks to its buyers (lib/store-language.ts).
 *
 * One choice for the whole store, as Kajabi does it per site, rather than a
 * page that guesses from each visitor's browser: a creator writes their
 * products in one language, and a page whose buttons speak Spanish around a
 * description written in English reads as a mistake. What it changes is
 * said in full before it is chosen, and so is what it leaves alone.
 */
export function StoreLanguageEditor({ language, handle }: { language: LanguageCode; handle: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<LanguageCode>(language);
  const [saved, setSaved] = useState<LanguageCode>(language);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || chosen === saved) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/store/language", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: chosen }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (!response.ok || data?.ok !== true || data.error || !isLanguage(data.language) || data.language !== chosen) {
        setStatus({ ok: false, text: "We could not confirm this setting. Reload this page to check before trying again." });
        return;
      }
      setSaved(data.language);
      setStatus({ ok: true, text: `Buyer language setting saved: ${LANGUAGES[data.language].english}.` });
      router.refresh();
    } catch {
      setStatus({ ok: false, text: "We could not confirm this setting. Reload this page to check before trying again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-busy={busy} className="card mt-8 p-6 sm:p-8" aria-labelledby="language-title">
      <h2 id="language-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        <label htmlFor="store-language">Your store&apos;s language</label>
      </h2>
      <p className="mt-2 text-ink-soft">
        What your buyers read in it: your store and product pages, checkout, the page after paying, their purchases,
        bookings, courses, memberships, your community, and the emails your store sends them. Dates, prices and numbers
        are written the way that language writes them.
      </p>
      <p className="mt-2 text-sm text-ink-soft">
        Your studio stays in English. What you write yourself — product names, descriptions, lessons, posts — is shown
        exactly as you wrote it, so write it in the same language and a page never mixes two. Drafts written with AI — descriptions, sales pages, course outlines, emails — come in this language too, and a sales page already written can be translated into it with AI in one step.
      </p>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={save}>
        <select
          disabled={busy}
          id="store-language"
          value={chosen}
          onChange={(event) => {
            setChosen(event.target.value as LanguageCode);
            setStatus(null);
          }}
          className="field max-w-xs"
        >
          {LANGUAGE_CODES.map((code) => (
            <option key={code} value={code} lang={code}>
              {code === "en" ? "English" : `${LANGUAGES[code].name} — ${LANGUAGES[code].english}`}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={busy || chosen === saved} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {status ? (
        <p className={`mt-3 text-sm ${status.ok ? "text-ink" : "notice notice-error"}`} role="status">
          {status.text}{" "}
          {status.ok ? (
            <a href={`/@${handle}`} target="_blank" rel="noopener" className="font-semibold underline underline-offset-4">
              See your store
            <NewTab /></a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
