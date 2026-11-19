"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { useLeaveGuard } from "@/components/leave-guard";
import { PAGE_PARTS, type PagePart, USUAL_ORDER, isUsualOrder } from "@/lib/store-order";

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const LABELS = new Map<string, { label: string; note: string }>(PAGE_PARTS.map((part) => [part.id, part]));

/**
 * The order of the parts of the store page (lib/store-order.ts): moved one
 * place at a time, seen as a list before it is saved, and put back to the
 * usual order in one press. Each part says whether it shows on the page now,
 * so a creator is never puzzled by a part that is placed but empty.
 */
export function PageOrderEditor({ order, on }: { order: PagePart[]; on: Record<PagePart, boolean> }) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [list, setList] = useState<PagePart[]>(order);
  const [saved, setSaved] = useState<PagePart[]>(order);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // What a move did, for screen readers: the place number beside each part is hidden from them (WCAG 4.1.3, 1.3.1).
  const [said, setSaid] = useState("");
  const changed = list.some((part, i) => part !== saved[i]);
  useLeaveGuard(changed);

  function say(words: string) {
    // Emptied first, so the same words said twice in a row are said again.
    setSaid("");
    requestAnimationFrame(() => setSaid(words));
  }

  function move(at: number, by: -1 | 1) {
    if (!ready || saving) return;
    const to = at + by;
    const name = LABELS.get(list[at])?.label ?? "This part";
    // At either end the button stays focusable (aria-disabled) and says so, instead of turning off under the focus.
    if (to < 0 || to >= list.length) {
      say(`${name} is already ${by < 0 ? "first" : "last"}.`);
      return;
    }
    const next = [...list];
    [next[at], next[to]] = [next[to], next[at]];
    setList(next);
    say(`Moved ${name} to place ${to + 1} of ${list.length}.`);
  }

  async function save(next: PagePart[]) {
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/store/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const reply = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (response.ok && reply?.ok === true && !("error" in reply) && Array.isArray(reply.order) && JSON.stringify(reply.order) === JSON.stringify(next)) {
        setList([...next]);
        setSaved([...next]);
        toast("Page order settings saved.");
        router.refresh();
        return;
      }
      setError("We could not confirm this page order. Reload this page to check before trying again.");
    } catch {
      setError("We could not confirm this page order. Reload this page to check before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-order-ready={ready ? "true" : "false"} aria-busy={saving} id="order" aria-labelledby="order-title" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
      <h2 id="order-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        The order of your page
      </h2>
      <p className="mt-2 text-ink-soft">
        What comes first under your name. Put your links first if your page is mostly links, what buyers say above your
        products if their words sell best, or the sign-up box at the top while you build a list. A visitor who searches
        your store always sees the results first.
      </p>

      <ol className="mt-5 space-y-2">
        {list.map((part, i) => {
          const about = LABELS.get(part);
          return (
            <li data-order-part={part} key={part} className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
              <span aria-hidden="true" className="w-5 shrink-0 text-center text-sm font-bold text-ink-soft">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink">{about?.label}</span>
                <span className="block text-sm text-ink-soft">
                  {on[part] ? about?.note : `Not on your page now. ${about?.note}`}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={!ready || saving}
                  aria-disabled={i === 0 || undefined}
                  aria-label={`Move ${about?.label} up`}
                  className="btn btn-secondary btn-sm px-2.5 disabled:opacity-40 aria-disabled:opacity-40"
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={!ready || saving}
                  aria-disabled={i === list.length - 1 || undefined}
                  aria-label={`Move ${about?.label} down`}
                  className="btn btn-secondary btn-sm px-2.5 disabled:opacity-40 aria-disabled:opacity-40"
                >
                  <span aria-hidden="true">↓</span>
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <p role="status" className="sr-only">{said}</p>

      {error ? (
        <p role="alert" className="notice notice-error mt-3 text-sm">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save(list)}
          disabled={!ready || !changed || saving}
          aria-busy={saving}
          className="btn btn-primary"
        >
          {saving ? "Saving…" : "Save the order"}
        </button>
        {isUsualOrder(list) ? null : (
          <button
            type="button"
            onClick={() => void save([...USUAL_ORDER])}
            disabled={!ready || saving}
            className="btn btn-secondary"
          >
            Back to the usual order
          </button>
        )}
      </div>
    </section>
  );
}
