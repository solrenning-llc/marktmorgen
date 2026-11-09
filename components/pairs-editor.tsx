"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_PAIRS } from "@/lib/store-collections";

const MESSAGES: Record<string, string> = {
  target: "One of those products is no longer in your store. Reload the page and try again.",
  too_many: `A product can name up to ${MAX_PAIRS} others.`,
  unknown: "This product is no longer in your store. Reload the page.",
  store_full: "Your store record is full. Remove something from it and try again.",
};
const FAILED = "We could not confirm these picks. Reload this page to check before trying again.";

/**
 * "Goes well with" for one product (lib/store-collections.ts): up to
 * MAX_PAIRS of the creator's other products, shown on this product's page
 * under the heading "Goes well with <this product>" and "Picked by <store>",
 * and offered in the cart while this one is in it. The creator's pick, said
 * as theirs; nothing about it is counted or claimed.
 */
export function PairsEditor({
  productId,
  initial,
  choices,
}: {
  productId: string;
  initial: string[];
  /** The store's published products, by name; null when their names could not be read just now. */
  choices: { id: string; title: string }[] | null;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [slots, setSlots] = useState<string[]>(() => Array.from({ length: MAX_PAIRS }, (_, i) => initial[i] ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = (choices ?? []).filter((p) => p.id !== productId);
  const titles = new Map((choices ?? []).map((p) => [p.id, p.title]));
  const picked = slots.filter(Boolean);
  const changed = picked.join(",") !== saved.join(",");

  // The names could not be read: said, with the picks kept as they are, never left out as if there were none (VR 2).
  if (choices === null) {
    return (
      <div data-pairs-editor={productId} className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line">
        <p className="font-semibold text-ink">Goes well with</p>
        <p className="mt-1 text-sm text-ink-soft" role="status">
          We could not read your other products&apos; names just now, so your picks cannot be changed here. They are kept as they are. Reload this page in a moment to check again.
        </p>
      </div>
    );
  }
  if (others.length === 0) return null;

  async function save() {
    if (busy) return;
    const expected = [...new Set(picked)];
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, pairs: expected }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (!response.ok || data?.ok !== true || data.error || data.id !== productId || !Array.isArray(data.pairs) || JSON.stringify(data.pairs) !== JSON.stringify(expected)) {
        const problem = data?.ok === true ? undefined : data?.error;
        setError(typeof problem === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, problem) ? MESSAGES[problem] : FAILED);
        return;
      }
      setSaved(expected);
      setSlots(Array.from({ length: MAX_PAIRS }, (_, index) => expected[index] ?? ""));
      toast("Product pick settings saved.");
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-pairs-editor={productId} aria-busy={busy} className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line">
      <p className="font-semibold text-ink">Goes well with</p>
      <p className="mt-1 text-sm text-ink-soft">
        {`Pick up to ${MAX_PAIRS} of your other products that go with this one. Its page shows them as your pick, with Add to cart where they can go in one, and the cart offers them while this one is in it. Nothing is said about other buyers: that only comes from your real sales.`}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {slots.map((value, index) => (
          <label key={index} className="block min-w-0">
            <span className="field-label">{`Pick ${index + 1}`}</span>
            <select
              disabled={busy}
              className="field mt-1"
              value={value}
              onChange={(event) => {
                const selected = event.currentTarget.value;
                setSlots((all) => all.map((v, i) => (i === index ? selected : v)));
              }}
            >
              <option value="">None</option>
              {value && !titles.has(value) ? <option value={value}>A product that is no longer published</option> : null}
              {others
                .filter((p) => p.id === value || !slots.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || !changed} aria-busy={busy}>
          {busy ? "Saving…" : "Save picks"}
        </button>
      </div>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
