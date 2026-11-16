"use client";

import { useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { MAX_STAMP_BYTES, isPdf, readableSize } from "@/lib/product-file";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const UNCONFIRMED = "We could not confirm whether your preview setting was saved. Reload this page to check before trying again.";

/** What the preview switch says when a change is not confirmed: the hold's words (cloud P on #3471), or to reload and check. */
export function previewRefusal(code: unknown): string {
  return code === "on_hold" || code === "hold_unread" ? STUDIO_MESSAGES[code] : UNCONFIRMED;
}

/** The choices a creator has: off, or 1 to 10 pages (lib/pdf-preview.ts). */
const CHOICES = [0, 1, 2, 3, 5, 10];

/**
 * Letting anyone read the first pages of a product's PDF before buying.
 * Shown on a product whose own file is a PDF, or that has it switched on.
 */
export function PdfPreviewToggle({ product }: { product: Product }) {
  const router = useRouter();
  // This control writes through React. Keep the server-rendered choice inert
  // until its handler is mounted, so an early change cannot be replayed with
  // the controlled field restored to its previous persisted value.
  const ready = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = product.file;
  const pdf = file !== null && isPdf(file);
  if (!pdf && product.preview === 0) return null;
  const tooBig = file !== null && file.bytes > MAX_STAMP_BYTES;

  async function change(pages: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, pages }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      if (!response.ok || data.ok !== true || data.error !== undefined || data.id !== product.id || data.pages !== pages) {
        setError(previewRefusal(data.ok === false ? data.error : undefined));
        return;
      }
      toast(pages ? "Preview setting saved." : "Preview switched off.");
      router.refresh();
    } catch {
      setError(UNCONFIRMED);
    } finally {
      setBusy(false);
    }
  }

  const id = `preview-${product.id}`;
  return (
    <div aria-busy={busy} className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
      <label htmlFor={id} className="field-label">
        Let anyone read the first pages before buying
      </label>
      <select id={id} className="field mt-1 w-auto" value={product.preview} disabled={!ready || busy || (tooBig && product.preview === 0)} onChange={(event) => void change(Number(event.target.value))}>
        {CHOICES.map((pages) => (
          <option key={pages} value={pages}>
            {pages === 0 ? "Off" : `The first ${pages === 1 ? "page" : `${pages} pages`}`}
          </option>
        ))}
      </select>
      <p className="mt-2 text-sm text-ink-soft">
        {tooBig
          ? `This PDF is over ${readableSize(MAX_STAMP_BYTES)}, so a preview cannot be cut from it.`
          : "Your page gets a link to a separate PDF holding only those pages, cut from yours once and kept. The rest of the file never leaves your store, and the preview counts as a free download."}
      </p>
      {error ? (
        <p className="notice notice-error mt-2" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
