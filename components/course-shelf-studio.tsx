"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_SHELF } from "@/lib/course-shelf-rules";

type Pick = { id: string; title: string };

/** Where the focus goes after an action (WCAG 2.4.3): a row's button, the "Add a product" list, or the shelf itself. */
export type ShelfFocus = { to: "remove" | "up" | "down"; id: string } | { to: "add" } | { to: "shelf" };

/**
 * The control that takes the focus after an action, so a keyboard or
 * screen-reader user is never sent back to the top of the page (independent
 * review of ca3c397): after Remove, the Remove of the row now in its place (or
 * the one before it, at the end), or the "Add a product" list when the shelf
 * is empty and something is left to add; after a move, the same button on the
 * moved row, or its other one when the moved row reached the end where that
 * button is disabled; after Add, the list again, or the new row's Remove when
 * the shelf is full and the list is disabled; after Save or Undo, whose
 * buttons go away, the shelf itself.
 */
export function focusAfter(
  action: { kind: "remove"; at: number } | { kind: "move"; at: number; by: -1 | 1 } | { kind: "add"; id: string } | { kind: "saved" },
  after: readonly Pick[],
  leftToAdd: number,
): ShelfFocus {
  if (action.kind === "saved") return { to: "shelf" };
  if (action.kind === "add") return after.length >= MAX_SHELF || leftToAdd === 0 ? { to: "remove", id: action.id } : { to: "add" };
  if (action.kind === "remove") {
    if (after.length === 0) return leftToAdd > 0 ? { to: "add" } : { to: "shelf" };
    return { to: "remove", id: after[Math.min(action.at, after.length - 1)].id };
  }
  const now = action.at + action.by;
  const id = after[now].id;
  if (after.length === 1) return { to: "remove", id };
  if (now === 0) return { to: "down", id };
  if (now === after.length - 1) return { to: "up", id };
  return { to: action.by < 0 ? "up" : "down", id };
}

const focusKey = (focus: ShelfFocus) => ("id" in focus ? `${focus.to}:${focus.id}` : focus.to);

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
  // Where the focus goes once the screen has drawn the action's result (focusAfter).
  const [pending, setPending] = useState<ShelfFocus | null>(null);
  const shelf = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pending || !shelf.current) return;
    const target = pending.to === "shelf" ? null : shelf.current.querySelector<HTMLElement>(`[data-focus="${focusKey(pending)}"]`);
    (target && !target.matches(":disabled") ? target : shelf.current).focus();
    setPending(null);
  }, [pending, chosen, saved]);
  const dirty = chosen.map((p) => p.id).join(",") !== saved.map((p) => p.id).join(",");
  const left = options.filter((o) => !chosen.some((c) => c.id === o.id));
  const full = chosen.length >= MAX_SHELF;

  function move(at: number, by: -1 | 1) {
    const next = [...chosen];
    const [one] = next.splice(at, 1);
    next.splice(at + by, 0, one);
    setChosen(next);
    setSaid(`${one.title} moved to place ${at + by + 1} of ${next.length}.`);
    setPending(focusAfter({ kind: "move", at, by }, next, left.length));
  }

  function add() {
    const one = left.find((o) => o.id === adding);
    if (!one || full) return;
    const next = [...chosen, one];
    setChosen(next);
    setAdding("");
    setPending(focusAfter({ kind: "add", id: one.id }, next, left.length - 1));
    setSaid(`${one.title} added, place ${chosen.length + 1} of ${chosen.length + 1}.`);
  }

  function remove(at: number) {
    const one = chosen[at];
    const next = chosen.filter((_, i) => i !== at);
    setChosen(next);
    setSaid(`${one.title} taken off the shelf.`);
    setPending(focusAfter({ kind: "remove", at }, next, left.length + 1));
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
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!data.ok) {
        // The route's own reason when it gives one (review of ca3c397, LOW): a full store, or the course being changed elsewhere.
        setError(
          data.error === "store_full"
            ? (data.message ?? "Your store has no room left. Nothing changed. Make room, then save again.")
            : data.error === "busy"
              ? "This course is being changed somewhere else right now. Nothing changed. Try again in a moment."
              : "The shelf could not be saved just now. Nothing changed. Try again in a moment.",
        );
        return;
      }
      toast(chosen.length ? "Saved. Students now see these products on the course page." : "Saved. The shelf is off.");
      router.refresh();
      setPending(focusAfter({ kind: "saved" }, chosen, left.length));
    } catch {
      setError("The shelf could not be saved just now. Nothing changed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4" ref={shelf} tabIndex={-1} role="group" aria-label="The shelf">
      {chosen.length ? (
        <ol className="space-y-2" aria-label="Products on the shelf, in order">
          {chosen.map((p, at) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-4 py-2">
              <span className="min-w-0 break-words font-semibold text-ink">
                {at + 1}. {p.title}
              </span>
              <span className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary btn-sm" disabled={at === 0 || busy} onClick={() => move(at, -1)} aria-label={`Move ${p.title} up`} data-focus={`up:${p.id}`}>
                  Up
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={at === chosen.length - 1 || busy} onClick={() => move(at, 1)} aria-label={`Move ${p.title} down`} data-focus={`down:${p.id}`}>
                  Down
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => remove(at)} aria-label={`Take ${p.title} off the shelf`} data-focus={`remove:${p.id}`}>
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
            <select id={`${id}-add`} data-focus="add" className="field" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={full || busy} aria-describedby={`${id}-help`}>
              <option value="">Choose one of your products</option>
              {left.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={add} disabled={!adding || full || busy}>
            Add
          </button>
        </div>
      ) : null}
      <p id={`${id}-help`} className="mt-1 max-w-2xl text-xs text-ink-soft">
        {full ? `The shelf holds ${MAX_SHELF} products. Remove one to add another.` : `Up to ${MAX_SHELF} products. Only products you list and sell today are shown.`}
      </p>

      {dirty ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy} aria-busy={busy}>
            Save shelf
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => {
              setChosen(saved);
              setSaid("Changes undone. The shelf is as it was saved.");
              setPending(focusAfter({ kind: "saved" }, saved, 0));
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
