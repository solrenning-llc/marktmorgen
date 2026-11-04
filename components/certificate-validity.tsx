"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

/** The same bound as lib/course.ts MAX_CERTIFICATE_MONTHS (ten years), which the server holds; kept here so the page loads no server code. */
const MAX_CERTIFICATE_MONTHS = 120;

/**
 * How long a course's certificates stay valid (639 [GL7](32)), for a training
 * that has to be renewed: empty is for good. Fixed on each certificate when it
 * is issued, so a change here never changes one already given.
 */
export function CertificateValidity({ productId, months }: { productId: string; months: number | null }) {
  const id = useId();
  const router = useRouter();
  const [value, setValue] = useState(months ? String(months) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value.trim() !== (months ? String(months) : "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, action: "cert-months", months: value.trim() ? Number(value.trim()) : null }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(data.error === "months" ? `Type a whole number of months from 1 to ${MAX_CERTIFICATE_MONTHS}, or leave it empty for good.` : "That could not be saved just now. Try again in a moment.");
        return;
      }
      toast(value.trim() ? "Saved. Certificates issued from now on show until when they are valid." : "Saved. Certificates issued from now on are valid for good.");
      router.refresh();
    } catch {
      setError("That could not be saved just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="block" htmlFor={`${id}-months`}>
        <span className="field-label">Valid for (optional)</span>
        <span className="relative block max-w-[12rem]">
          <input
            id={`${id}-months`}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CERTIFICATE_MONTHS}
            step={1}
            placeholder="For good"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={`${id}-help`}
            className="field pr-20"
          />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink-soft">months</span>
        </span>
        <span id={`${id}-help`} className="mt-1 block max-w-md text-xs text-ink-soft">
          For a training people renew. Each certificate shows until when it is valid, and says it expired after that day.
          Certificates already issued keep what they had.
        </span>
      </label>
      {dirty ? (
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy} aria-busy={busy}>
          Save
        </button>
      ) : null}
      {error ? <p className="notice notice-error w-full" role="alert">{error}</p> : null}
    </form>
  );
}
