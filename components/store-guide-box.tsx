"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { MAX_QUESTION, MIN_QUESTION } from "@/lib/answers-rules";
import { guideWords } from "@/lib/buyer-words/guide";

const never = () => () => {};

type Pick = { title: string; href: string; price: string; why: string };

/**
 * "Not sure which one is for you?" on the store page (lib/store-guide.ts): the
 * visitor says what they want, and sees the products that fit, with why.
 * Drawn only once the browser has taken the page over, because it needs
 * JavaScript to ask; the page sells without it.
 */
export function StoreGuideBox({ handle, storeName, lang }: { handle: string; storeName: string; lang: string }) {
  const here = useSyncExternalStore(never, () => true, () => false);
  const w = guideWords(lang);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ asked: string; picks: Pick[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!here) return null;

  const NOTES: Record<string, string> = { question: w.short, slow: w.slow, closed: w.closed, off: w.closed, failed: w.failed };

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const asked = goal.trim();
    if (busy) return;
    if (asked.length < MIN_QUESTION) {
      setNote(w.short);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/store/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, goal: asked }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; picks?: Pick[]; error?: string };
      if (data.ok && Array.isArray(data.picks)) setResult({ asked, picks: data.picks });
      else setNote(NOTES[data.error ?? ""] ?? w.failed);
    } catch {
      setNote(w.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card st-guide p-6 sm:p-7" aria-labelledby="guide-title">
      <h2 id="guide-title" className="font-display flex items-center gap-2 text-xl font-semibold leading-snug">
        <Icon name="sparkle" size={20} />
        {w.title}
      </h2>
      <p className="st-muted mt-2">{w.lead(storeName)}</p>
      <form onSubmit={ask} className="mt-4">
        <label htmlFor="guide-goal" className="st-label">
          {w.label}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="guide-goal"
            className="st-field min-w-0 flex-1"
            maxLength={MAX_QUESTION}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={w.placeholder}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit" className="btn st-btn shrink-0" disabled={busy} aria-busy={busy}>
            {busy ? w.busy : w.button}
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {result ? (
          <div className="mt-4">
            <p className="st-muted text-xs font-semibold">{result.asked}</p>
            {result.picks.length ? (
              <>
                <p className="mt-2 text-sm font-bold">{w.picks}</p>
                <ol className="mt-2 space-y-2">
                  {result.picks.map((pick) => (
                    <li key={pick.href}>
                      <Link href={pick.href} className="st-guide-pick" aria-label={w.see(pick.title)}>
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="font-bold">{pick.title}</span>
                          <span className="st-price shrink-0 text-xs">{pick.price}</span>
                        </span>
                        {/* A reason the catalog does not back is dropped (lib/store-guide.ts): then only the title and price. */}
                        {pick.why ? <span className="st-muted mt-1 block text-sm leading-relaxed">{pick.why}</span> : null}
                      </Link>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="st-note mt-2 text-sm">{w.none(storeName)}</p>
            )}
          </div>
        ) : null}
        {note ? (
          <p className="st-note mt-3 text-sm" role="status">
            {note}
          </p>
        ) : null}
      </div>
      <p className="st-muted mt-3 text-xs">{w.note}</p>
    </section>
  );
}
