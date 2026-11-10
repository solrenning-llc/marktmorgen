"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_SHELF } from "@/lib/course-shelf-rules";

type Pick = { id: string; title: string };

/**
 * The course's "More from" shelf in the studio (628 [HN4](b), unit 2): the
 * creator picks up to MAX_SHELF of the store's own products, in the order the
 * students will see them, and saves. Nothing changes until Save is pressed, and
 * "Undo changes" puts back what is saved. Every control is a native button or
 * select, so it works by keyboard, touch, mouse and voice alike, with no drag.
 */
export function CourseShelfStudio({ productId, saved, options }: { productId: string; saved: Pick[]; options: Pick[] }) {
  const id = useId();
  const router = useRouter();
  const [chosen, setChosen] = useState<Pick[]>(saved);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const dirty = chosen.map((p) => p.id).join(",") !== saved.map((p) => p.id).join(",");
  const left = options.filter((o) => !chosen.some((c) => c.id === o.id));
  const full = chosen.length >= MAX_SHELF;

  function move(at: number, by: -1 | 1) {
    const next = [...chosen];
    const [one] = next.splice(at, 1);
    next.splice(at + by, 0, one);
    setChosen(next);
    setSaid(`${one.title} moved to place ${at + by + 1} of ${next.length}.`);
  }

  function add() {
    const one = left.find((o) => o.id === adding);
    if (!one || full) return;
    setChosen([...chosen, one]);
    setAdding("");
    setSaid(`${one.title} added, place ${chosen.length + 1} of ${chosen.length + 1}.`);
  }

  function remove(at: number) {
    const one = chosen[at];
    setChosen(chosen.filter((_, i) => i !== at));
    setSaid(`${one.title} taken off the shelf.`);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, action: "shelf", products: chosen.map((p) => p.id) }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!data.ok) {
        setError("The shelf could not be saved just now. Nothing changed. Try again in a moment.");
        return;
      }
      toast(chosen.length ? "Saved. Students now see these products on the course page." : "Saved. The shelf is off.");
      router.refresh();
    } catch {
      setError("The shelf could not be saved just now. Nothing changed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      {chosen.length ? (
        <ol className="space-y-2" aria-label="Products on the shelf, in order">
          {chosen.map((p, at) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-4 py-2">
              <span className="min-w-0 break-words font-semibold text-ink">
                {at + 1}. {p.title}
              </span>
              <span className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary btn-sm min-h-11" disabled={at === 0 || busy} onClick={() => move(at, -1)} aria-label={`Move ${p.title} up`}>
                  Up
                </button>
                <button type="button" className="btn btn-secondary btn-sm min-h-11" disabled={at === chosen.length - 1 || busy} onClick={() => move(at, 1)} aria-label={`Move ${p.title} down`}>
                  Down
                </button>
                <button type="button" className="btn btn-secondary btn-sm min-h-11" disabled={busy} onClick={() => remove(at)} aria-label={`Take ${p.title} off the shelf`}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-ink-soft">No products on the shelf yet. Students see nothing extra on the course page.</p>
      )}

      {left.length ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1" htmlFor={`${id}-add`}>
            <span className="field-label">Add a product</span>
            <select id={`${id}-add`} className="field" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={full || busy} aria-describedby={`${id}-help`}>
              <option value="">Choose one of your products</option>
              {left.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary btn-sm min-h-11" onClick={add} disabled={!adding || full || busy}>
            Add
          </button>
        </div>
      ) : null}
      <p id={`${id}-help`} className="mt-1 max-w-2xl text-xs text-ink-soft">
        {full ? `The shelf holds ${MAX_SHELF} products. Remove one to add another.` : `Up to ${MAX_SHELF} products. Only products you list and sell today are shown.`}
      </p>

      {dirty ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary btn-sm min-h-11" onClick={save} disabled={busy} aria-busy={busy}>
            Save shelf
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm min-h-11"
            disabled={busy}
            onClick={() => {
              setChosen(saved);
              setSaid("Changes undone. The shelf is as it was saved.");
            }}
          >
            Undo changes
          </button>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
