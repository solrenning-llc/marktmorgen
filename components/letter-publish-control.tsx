"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { LETTER_PREVIEW_MAX, MAX_LETTER_PRODUCTS, MEMBERS_PUBLISH_WARNING, PUBLISH_WARNING } from "@/lib/letter-rules";

/** The studio's words for a request that failed on our side (components/email-studio.tsx says the same). */
const SERVER_ERROR = "Something went wrong on our side. Try again in a moment.";

/**
 * Publishing a sent email on the store, or taking it off (lib/letter-rules.ts):
 * asked before it is published, because anyone can read it once it is,
 * unless the creator checks the products whose holders alone may read its
 * words (lib/letter-access.ts). Once published it says whether it is for
 * members only (lib/letters.ts, publishedLetters); when that could not be
 * read it says so and offers nothing that could publish it on a guess.
 * With products checked, the creator may let everyone read its first parts
 * (previewOf); none is the default.
 */
export function PublishControl({ id, path, members, unknown, disabled, onDone, products }: { id: string; path: string | null; members: boolean; unknown: boolean; disabled: boolean; onDone: () => void; products: readonly { id: string; title: string }[] }) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [preview, setPreview] = useState(0);
  async function act(action: "publish" | "unpublish") {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/store/letters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "publish" ? { action, id, products: chosen, preview: chosen.length ? preview : 0 } : { action, id }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (data.ok !== true) setError(data.message ?? SERVER_ERROR);
      else {
        toast(action === "publish" ? (chosen.length ? "Published on your store for members." : "Published on your store.") : "Taken off your store.");
        setChosen([]);
        setPreview(0);
        setAsking(false);
        onDone();
      }
    } catch {
      setError(SERVER_ERROR);
    } finally {
      setWorking(false);
    }
  }
  if (unknown) {
    // Whether it is published could not be read: nothing is offered that could publish it again on a guess.
    return <span className="inline-flex min-h-11 items-center text-sm text-ink-soft">Could not check whether it is on your store. Reload the page to see.</span>;
  }
  if (path) {
    return (
      <span className="inline-flex min-h-11 flex-wrap items-center gap-x-4 text-sm">
        <a href={path} className="font-bold text-ink underline underline-offset-4">Published on your store</a>
        {members ? <span className="font-semibold text-ink-soft">For members only</span> : null}
        <button type="button" disabled={disabled || working} aria-busy={working} className="font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => act("unpublish")}>
          Take it off
        </button>
        {error ? <span role="alert" className="text-danger">{error}</span> : null}
      </span>
    );
  }
  return asking ? (
    <div className="block w-full rounded-[var(--r-sm)] bg-sand p-3 text-sm text-ink">
      {products.length ? (
        <fieldset className="mb-3">
          <legend className="font-bold">Who can read its words</legend>
          <span className="mt-1 block text-ink-soft">Check nothing and everyone can. Check products and only people who have one of them can (up to {MAX_LETTER_PRODUCTS}).</span>
          <div className="mt-2 max-h-48 overflow-y-auto">
            {products.map((p) => {
              const on = chosen.includes(p.id);
              return (
                <label key={p.id} className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={working || (!on && chosen.length >= MAX_LETTER_PRODUCTS)}
                    onChange={(e) => setChosen((now) => (e.target.checked ? [...now, p.id] : now.filter((x) => x !== p.id)))}
                  />
                  <span className="[overflow-wrap:anywhere]">{p.title}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {chosen.length ? (
        <label className="mb-3 block">
          <span className="font-bold">What everyone else sees</span>
          <span className="mt-1 block text-ink-soft">A part is a heading, a paragraph, a list, a button or a picture. The last part always stays for members.</span>
          <select className="mt-2 block min-h-11 rounded-[var(--r-sm)] border border-line bg-paper px-3" value={preview} disabled={working} onChange={(e) => setPreview(Number(e.target.value))}>
            <option value={0}>Only the subject</option>
            {Array.from({ length: LETTER_PREVIEW_MAX }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n === 1 ? "The subject and the first part" : `The subject and the first ${n} parts`}</option>
            ))}
          </select>
        </label>
      ) : null}
      <span className="block" aria-live="polite">{chosen.length ? MEMBERS_PUBLISH_WARNING : PUBLISH_WARNING}</span>
      <span className="mt-2 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled || working} aria-busy={working} onClick={() => act("publish")}>Publish it</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={working} onClick={() => { setAsking(false); setChosen([]); setPreview(0); }}>Not now</button>
      </span>
      {error ? <span role="alert" className="mt-2 block text-danger">{error}</span> : null}
    </div>
  ) : (
    <button type="button" disabled={disabled} className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4" onClick={() => setAsking(true)}>
      Publish on your store
    </button>
  );
}
