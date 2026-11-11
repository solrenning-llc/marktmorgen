"use client";

import { useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { StudioEmptyState } from "@/components/empty-state";
import { toast } from "@/components/toast";
import {
  type Collection,
  MAX_COLLECTIONS,
  MAX_COLLECTION_BLURB,
  MAX_COLLECTION_PRODUCTS,
  MAX_COLLECTION_TITLE,
  collectionSegment,
  parseCollections,
} from "@/lib/store-collections";
import { NewTab } from "@/components/new-tab";

const MESSAGES: Record<string, string> = {
  title: "Give every collection a name.",
  empty: "Put at least one product in every collection.",
  too_many: `A store can have up to ${MAX_COLLECTIONS} collections.`,
  too_big: `A collection holds up to ${MAX_COLLECTION_PRODUCTS} products.`,
  unknown: "One of those products is no longer in your store. Reload the page and try again.",
  store_full: "Your store record is full. Remove something from it and try again.",
};
const FAILED = "We could not confirm these collections. Reload this page to check before trying again.";

type Row = { id: string; title: string; blurb: string; products: string[] };

/**
 * The store's collections (lib/store-collections.ts): named groups of its
 * products, each with a page of its own and a link above the products on the
 * store page. Saved all at once, like the sections beside it.
 */
export function CollectionsEditor({
  collections,
  products,
  handle,
}: {
  collections: Collection[];
  /** The store's published products, in its own order. */
  products: { id: string; title: string }[];
  handle: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [saved, setSaved] = useState(collections);
  const [rows, setRows] = useState<Row[]>(collections.map((c) => ({ ...c, products: [...c.products] })));
  const [adding, setAdding] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const unavailable = !hydrated || busy;
  const [error, setError] = useState<string | null>(null);

  const titles = new Map(products.map((p) => [p.id, p.title]));
  const changed = JSON.stringify(rows) !== JSON.stringify(saved);
  const incomplete = rows.some((row) => !row.title.trim() || row.products.length === 0);
  const update = (index: number, change: Partial<Row>) => setRows((all) => all.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function save() {
    if (unavailable) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collections: rows.map((row) => ({ id: row.id || undefined, title: row.title.trim(), blurb: row.blurb.trim(), products: row.products })) }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const received = parseCollections(data?.collections);
      const matches = Array.isArray(data?.collections) && data.collections.length === rows.length && received.length === rows.length && received.every((collection, index) => {
        const row = rows[index];
        const sameId = row.id ? collection.id === row.id : !saved.some(previous => previous.id === collection.id);
        const expected = parseCollections([{ ...row, id: collection.id }])[0];
        return sameId && expected && JSON.stringify(collection) === JSON.stringify(expected);
      });
      if (!response.ok || data?.ok !== true || data.error || !matches) {
        const problem = data?.ok === true ? undefined : data?.error;
        setError(typeof problem === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, problem) ? MESSAGES[problem] : FAILED);
        return;
      }
      setSaved(received);
      setRows(received.map(collection => ({ ...collection, products: [...collection.products] })));
      toast("Collection settings saved.");
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-collections-editor data-collections-ready={hydrated} aria-busy={unavailable} className="card p-6 sm:p-8">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Collections</p>
      <p className="mt-2 text-ink-soft">
        {`Group products under a name, like "Beginner guides" or "Everything for weddings". Each collection gets a page of its own you can link to, and a link above your products on your store page. A product can be in more than one. Up to ${MAX_COLLECTIONS} collections of up to ${MAX_COLLECTION_PRODUCTS} products each.`}
      </p>
      <p className="mt-2 text-sm text-ink-soft">
        On a collection&apos;s page, the products that can go in a cart can be added together, up to four at a time. Only published products are shown; a draft waits until you publish it.
      </p>

      {products.length === 0 ? (
        <StudioEmptyState title="No products to group yet" body="Publish a product and you can start a collection." className="mt-4" />
      ) : (
        <>
          {rows.length > 0 ? (
          <ul className="mt-5 space-y-4">
            {rows.map((row, index) => {
              const free = products.filter((p) => !row.products.includes(p.id));
              const pick = adding[index] ?? free[0]?.id ?? "";
              return (
                <li key={row.id || `new-${index}`} className="rounded-2xl bg-paper p-4 ring-1 ring-line">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-[12rem] flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="field-label">{`Collection ${index + 1}: name`}</span>
                        <span className="text-xs tabular-nums text-ink-mute">{`${row.title.length}/${MAX_COLLECTION_TITLE}`}</span>
                      </span>
                      <input disabled={unavailable} className="field mt-1" maxLength={MAX_COLLECTION_TITLE} value={row.title} placeholder="For example: Beginner guides" onChange={(event) => update(index, { title: event.target.value })} />
                    </label>
                    <button
                      type="button"
                      disabled={unavailable}
                      onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                      aria-label={`Remove collection ${index + 1}`}
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  </div>
                  <label className="mt-3 block">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="field-label">A line about it (optional)</span>
                      <span className="text-xs tabular-nums text-ink-mute">{`${row.blurb.length}/${MAX_COLLECTION_BLURB}`}</span>
                    </span>
                    <textarea disabled={unavailable} className="field mt-1" rows={2} maxLength={MAX_COLLECTION_BLURB} value={row.blurb} onChange={(event) => update(index, { blurb: event.target.value })} />
                  </label>
                  <p className="field-label mt-3">{`Products in it (${row.products.length} of ${MAX_COLLECTION_PRODUCTS}), in the order shown`}</p>
                  {row.products.length === 0 ? <p className="mt-1 text-sm text-ink-soft">Nothing yet. Add a product below.</p> : null}
                  <ol className="mt-2 space-y-2">
                    {row.products.map((id, at) => (
                      <li key={id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 ring-1 ring-line">
                        <span className="min-w-0 truncate text-sm text-ink">{titles.get(id) ?? "A product that is no longer published"}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            disabled={unavailable || at === 0}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-lilac disabled:opacity-40"
                            aria-label={`Move ${titles.get(id) ?? "this product"} up`}
                            onClick={() => {
                              const next = [...row.products];
                              [next[at - 1], next[at]] = [next[at], next[at - 1]];
                              update(index, { products: next });
                            }}
                          >
                            <span aria-hidden="true" className="text-sm">&uarr;</span>
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                            disabled={unavailable}
                            aria-label={`Take ${titles.get(id) ?? "this product"} out`}
                            onClick={() => update(index, { products: row.products.filter((other) => other !== id) })}
                          >
                            <Icon name="close" size={15} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                  {row.products.length < MAX_COLLECTION_PRODUCTS && free.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <label className="min-w-[12rem] flex-1">
                        <span className="sr-only">{`Product to add to collection ${index + 1}`}</span>
                        <select disabled={unavailable} className="field" value={pick} onChange={(event) => setAdding((all) => ({ ...all, [index]: event.target.value }))}>
                          {free.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={unavailable || !pick} onClick={() => update(index, { products: [...row.products, pick] })}>
                        <Icon name="plus" size={15} />
                        Add to this collection
                      </button>
                    </div>
                  ) : null}
                  {row.id ? (
                    <p className="mt-3 text-xs text-ink-mute">
                      {"Its page: "}
                      <a className="break-all underline" href={`/@${handle}/shop/${collectionSegment({ id: row.id, title: row.title || "collection" })}`} target="_blank" rel="noreferrer">
                        {`/@${handle}/shop/${collectionSegment({ id: row.id, title: row.title || "collection" })}`}
                      <NewTab /></a>
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-ink-mute">Its page address appears once it is saved.</p>
                  )}
                </li>
              );
            })}
          </ul>
          ) : saved.length === 0 ? (
            <StudioEmptyState title="No collections yet" body="A collection groups products under one name and gets a page of its own." className="mt-5" />
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {rows.length < MAX_COLLECTIONS ? (
              <button type="button" disabled={unavailable} className="btn btn-secondary btn-sm" onClick={() => setRows((all) => [...all, { id: "", title: "", blurb: "", products: [] }])}>
                <Icon name="plus" size={15} />
                {`Add a collection (${rows.length} of ${MAX_COLLECTIONS})`}
              </button>
            ) : null}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={unavailable || !changed || incomplete} aria-busy={busy}>
              {busy ? "Saving…" : "Save collections"}
            </button>
            {incomplete ? <span className="text-xs text-ink-soft">Give every collection a name and at least one product.</span> : null}
          </div>
        </>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
