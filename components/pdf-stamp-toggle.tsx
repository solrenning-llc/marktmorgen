"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { MAX_STAMP_BYTES, isEpub, isPdf, readableSize } from "@/lib/product-file";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  signed_out: "Your session ended. Log in again.",
  unknown: "This product was not found. It may have been deleted; reload the page.",
  none: "This account has no store yet.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm whether your marking setting was saved. Reload this page to check before trying again.",
};

type Problem = { name: string; bytes: number; kind?: "pdf" | "epub"; reason: "too_big" | "unreadable" | "signed" | "encrypted" | "storage" };

/**
 * Stamping the buyer's email on every page of a product's PDFs, and as an
 * invisible mark inside its EPUBs (630 [HN6] item 30, unit 2). Shown on a
 * product that delivers at least one PDF or EPUB, or that has it switched on.
 */
export function PdfStampToggle({ product }: { product: Product }) {
  const router = useRouter();
  const files = [product.file, ...product.options.map((o) => o.file)].filter((f): f is NonNullable<typeof f> => f !== null);
  const pdfs = files.filter(isPdf);
  const epubs = files.filter(isEpub);
  // What the box is about, in its own words: an EPUB-only product's box says EPUB.
  const kind = pdfs.length === 0 && epubs.length > 0 ? "EPUB" : "PDF";
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

  if (pdfs.length === 0 && epubs.length === 0 && !on) return null;

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
      toast(next ? `${kind} marking setting saved.` : `${kind} marking switched off.`);
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
        {pdfs.length === 0 && epubs.length > 0 ? (
          <>Mark each buyer&apos;s email inside the EPUB</>
        ) : (
          <>Stamp each buyer&apos;s email on every page of the PDF</>
        )}
      </label>
      {pdfs.length === 0 && epubs.length > 0 ? (
        <p id={`${id}-hint`} className="mt-2 text-sm text-ink-soft">
          When a buyer downloads it, the book carries one line hidden inside its files, where reading apps do not show it, like{" "}
          <span className="break-words font-mono text-xs text-ink">Sold to maya@example.com on Sep 26, 2026 · order …E54F2A · for personal use</span>
          . It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing. EPUBs up to{" "}
          {readableSize(MAX_STAMP_BYTES)}; one with a digital signature or encryption (DRM) is handed over as you uploaded it, since a mark would break it.
        </p>
      ) : (
        <p id={`${id}-hint`} className="mt-2 text-sm text-ink-soft">
          When a buyer downloads it, each page carries one small line along the bottom, like{" "}
          <span className="break-words font-mono text-xs text-ink">Sold to maya@example.com on Sep 26, 2026 · order …E54F2A · for personal use</span>
          . It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing. PDFs up to{" "}
          {readableSize(MAX_STAMP_BYTES)}; a bigger one, or one locked with a password, is handed over as you uploaded it.
          {epubs.length > 0
            ? ` An EPUB on this product gets the same line hidden inside the book, where reading apps do not show it and a copy still carries it. EPUBs up to ${readableSize(MAX_STAMP_BYTES)}; one with a digital signature or encryption (DRM) is handed over as you uploaded it, since a mark would break it.`
            : null}
        </p>
      )}
      {on && pdfs.length === 0 && epubs.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">There is no PDF or EPUB on this product right now, so nothing is stamped.</p>
      ) : null}
      {on && problems.length ? (
        <ul className="notice notice-warn mt-3 space-y-1 text-sm" role="status">
          {problems.map((problem) => (
            <li key={`${problem.name}-${problem.bytes}`}>
              <strong>{problem.name}</strong>
              {problem.reason === "too_big"
                ? ` is ${readableSize(problem.bytes)}, over the ${readableSize(MAX_STAMP_BYTES)} that can be stamped, so buyers get it unstamped.`
                : problem.reason === "storage"
                  ? " was not stamped for a recent buyer: each buyer's stamped copy is kept in your store's storage, and there was no room for one more (or the storage could not be checked). That buyer got it unstamped. Free up storage to stamp it again."
                  : problem.reason === "signed"
                    ? " carries a digital signature that a mark would break, so buyers get it unstamped."
                    : problem.reason === "encrypted"
                      ? " is encrypted (DRM), so buyers get it unstamped."
                      : problem.kind === "epub"
                        ? " could not be stamped — it is damaged, holds more inside than can be marked, or is built in a way the mark does not read — so buyers get it unstamped."
                        : " could not be stamped — it is locked with a password or damaged — so buyers get it unstamped. Save it again without a password to stamp it."}
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
