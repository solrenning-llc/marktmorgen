"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

/**
 * Chooses the free product offered once to a visitor about to leave the
 * store (components/exit-offer.tsx). Only free products are listed: the
 * offer is something to take away for an address, never a price.
 */
export function ExitOfferEditor({ current, free }: { current: string | null; free: { id: string; title: string }[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState(current ?? "");
  const [saved, setSaved] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/exit-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: choice }),
      });
      const data: unknown = await response.json().catch(() => null);
      const reply = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
      if (!response.ok || reply?.ok !== true || "error" in reply || reply.exitOffer !== (choice || null)) {
        setError(reply?.ok !== true && reply?.error === "not_free" ? "Only something free, and published, can be offered here." : "We could not confirm this offer setting. Reload this page to check before trying again.");
        return;
      }
      setSaved(choice);
      toast("Exit offer settings saved.");
      router.refresh();
    } catch {
      setError("We could not confirm this offer setting. Reload this page to check before trying again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-exit-offer-editor aria-busy={busy} className="card p-6 sm:p-8">
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">When a visitor is about to leave</h2>
      <p className="mt-2 text-ink-soft">
        Offer one of your free products, once, to a visitor on a computer whose pointer heads for the tabs to leave your store or a
        product&apos;s page. They can take it for their email address, with the same unchecked box for your emails, or close it.
        Shown once a month at most to the same visitor, never on a phone and never in the first seconds.
      </p>
      {free.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          Add something free — a guide, a checklist, a sample — and it can be offered here.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1">
            <span className="field-label">What to offer</span>
            <select disabled={busy} className="field mt-1" value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value="">Nothing (off)</option>
              {free.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || choice === saved} aria-busy={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
