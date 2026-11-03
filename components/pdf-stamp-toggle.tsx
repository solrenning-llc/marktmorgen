"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { MAX_STAMP_BYTES, isMarkable, readableSize } from "@/lib/product-file";
import { STAMP_WORDS } from "@/lib/pdf-stamp-faq";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** Why one file is handed over as uploaded, in the studio's words. */
function problemWords(problem: Problem): string {
  if (problem.reason === "too_big") return ` is ${readableSize(problem.bytes)}, over the ${readableSize(MAX_STAMP_BYTES)} that can be marked, so buyers get it unmarked.`;
  if (!problem.epub) return " could not be stamped — it is locked with a password or damaged — so buyers get it unstamped. Save it again without a password to stamp it.";
  if (problem.reason === "protected") return " has copy protection (DRM) or a digital signature, so the mark is not written into it and buyers get it unmarked.";
  if (problem.reason === "unsupported") return " is saved in a format the mark cannot read, so buyers get it unmarked. Export it again from your writing app to mark it.";
  return " could not be marked — it is damaged or is not a complete EPUB — so buyers get it unmarked. Export it again from your writing app to mark it.";
}

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  signed_out: "Your session ended. Log in again.",
  unknown: "This product was not found. It may have been deleted; reload the page.",
  none: "This account has no store yet.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm whether your PDF and EPUB marking setting was saved. Reload this page to check before trying again.",
};

type Problem = { name: string; bytes: number; reason: "too_big" | "unreadable" | "protected" | "unsupported"; epub?: boolean };

/**
 * Marking a product's files with the buyer's email: on every page of a PDF,
 * and inside an EPUB where reading apps do not show it (630 [HN6](30)).
 * Shown on a product that delivers at least one PDF or EPUB, or that has it
 * switched on.
 */
export function PdfStampToggle({ product }: { product: Product }) {
  const router = useRouter();
  const files = [product.file, ...product.options.map((o) => o.file)].filter((f): f is NonNullable<typeof f> => f !== null);
  const marked = files.filter(isMarkable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const on = product.stamp;

  useEffect(() => {
    if (!on) return;
    let live = true;
    (async () => {
      try {
        const response = await fetch(`/api/store/stamp?id=${encodeURIComponent(product.id)}`, { cache: "no-store" });
        const data = (await response.json()) as { ok?: boolean; problems?: Problem[] };
        if (live && data.ok) setProblems(data.problems ?? []);
      } catch {
        // The notes are extra; the setting itself is shown either way.
      }
    })();
    return () => {
      live = false;
    };
  }, [on, product.id, product.file, product.options]);

  if (marked.length === 0 && !on) return null;

  async function change(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/stamp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, on: next }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      if (!response.ok || data.ok !== true || data.error !== undefined || data.id !== product.id || data.on !== next) {
        const reason = typeof data.error === "string" ? data.error : "";
        setError(data.ok === false && !response.ok && Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : MESSAGES.server_error);
        return;
      }
      toast(next ? "PDF and EPUB marking setting saved." : "PDF and EPUB marking switched off.");
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const id = `stamp-${product.id}`;
  return (
    <div aria-busy={busy} className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input
          id={id}
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(event) => change(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
          aria-describedby={`${id}-hint`}
        />
        {STAMP_WORDS.box}
      </label>
      <p id={`${id}-hint`} className="mt-2 text-sm text-ink-soft">
        When a buyer downloads a PDF, each page carries one small line along the bottom, like{" "}
        <span className="break-words font-mono text-xs text-ink">Sold to maya@example.com on Sep 26, 2026 · order …E54F2A · for personal use</span>
        . An EPUB gets the same line written inside the book, where reading apps do not show it but the file the buyer downloads carries it.
        It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing. Files up to{" "}
        {readableSize(MAX_STAMP_BYTES)}; a bigger one, a PDF locked with a password or an EPUB with copy protection (DRM) is handed over as you uploaded it.
      </p>
      {on && marked.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">There is no PDF or EPUB on this product right now, so nothing is marked.</p>
      ) : null}
      {on && problems.length ? (
        <ul className="notice notice-warn mt-3 space-y-1 text-sm" role="status">
          {problems.map((problem) => (
            <li key={`${problem.name}-${problem.bytes}`}>
              <strong>{problem.name}</strong>
              {problemWords(problem)}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="notice notice-error mt-2" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
