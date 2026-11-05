"use client";

import { PRODUCT_OUTLINE_LEFT } from "@/lib/product-outline";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { useStudioHref } from "@/components/studio-store-pin";
import { type Currency, fieldPrefix, formatMoney, priceExample, readMoney } from "@/lib/money";
import { MAX_BUNDLE_ITEMS, MIN_BUNDLE_ITEMS, MIN_PICK } from "@/lib/bundle-rules";
import { MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/catalog";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** A product as the picker shows it. */
export type PickerProduct = {
  id: string;
  title: string;
  priceCents: number;
  /** "Download", "Link", "Course, 12 lessons", or "". */
  what: string;
  hidden: boolean;
  /** Why it cannot go in a bundle; null when it can. */
  why: string | null;
};

const MESSAGES: Record<string, string> = {
  outline_left: PRODUCT_OUTLINE_LEFT,
  ...STUDIO_MESSAGES,
  count: `A bundle holds ${MIN_BUNDLE_ITEMS} to ${MAX_BUNDLE_ITEMS} different products.`,
  self: "A bundle cannot hold itself.",
  unknown: "One of those products is no longer in your store. Reload the page and pick again.",
  kind: "One of those products can no longer go in a bundle: it needs one price, no limit on how many are for sale, and a file, a link or a course with lessons. Reload the page to see which.",
  free: "A bundle is sold. Give it a price.",
  pick: `Buyers choose at least ${MIN_PICK}, and fewer than the bundle holds. Add more products to it, or lower the number.`,
  recurring: "A membership cannot be a bundle. Make it a one-off product first.",
  call: "A call cannot be a bundle. Stop selling it as a call first.",
  course: "A course cannot be a bundle. Make a new product for the bundle instead.",
  delivery: "Take this product's own file or link off first: a bundle hands over the products in it, not a file of its own.",
  options: "Take this product's price options off first: a bundle has one price.",
  pwyw: "A bundle has a set price. Stop letting its buyers choose the price first.",
  title: "Give the bundle a name.",
  price: "Type the bundle's price as a plain amount, like 49.",
  too_many: "Your store is full. Remove a product to make room for the bundle.",
  store_full: "Your store is full. Remove a product to make room for the bundle.",
  slow: "That was a lot of searching in a short time. Wait a minute and try again.",
  signed_out: "Your session ended. Log in again.",
  role: "Your role on this store does not change products.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/**
 * Making a bundle, or changing what one holds: the products in it, in the
 * order a buyer sees them, and a picker that finds any product of the store
 * by name, a page at a time, however many the store has.
 */
export function BundleEditor({
  mode,
  owner,
  initial,
  currency,
}: {
  /** A new product; an existing bundle; or an existing product becoming one. */
  mode: "create" | "edit" | "convert";
  owner: { id: string; title: string; priceCents: number; pick?: number | null } | null;
  initial: PickerProduct[];
  currency: Currency;
}) {
  const router = useRouter();
  const studioHref = useStudioHref();
  const [items, setItems] = useState<PickerProduct[]>(initial);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // A bundle its buyers build: how many of its products each one chooses (lib/bundle-rules.ts).
  const [choosing, setChoosing] = useState(Boolean(owner?.pick));
  const [pick, setPick] = useState(owner?.pick ?? MIN_PICK);

  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PickerProduct[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [matches, setMatches] = useState(0);
  const [searching, setSearching] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const asked = useRef(0);
  const ownerId = owner?.id ?? "";

  // The picker asks the server for one page at a time, as the name is typed.
  useEffect(() => {
    const ticket = ++asked.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: query, page: String(page) });
        if (ownerId) params.set("for", ownerId);
        const response = await fetch(`/api/store/bundle?${params}`);
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          products?: PickerProduct[];
          more?: boolean;
          matches?: number;
        };
        if (ticket !== asked.current) return;
        if (!data.ok) {
          setPickError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
          return;
        }
        setPickError(null);
        setFound((current) => (page === 1 ? data.products ?? [] : [...current, ...(data.products ?? [])]));
        setMore(Boolean(data.more));
        setMatches(data.matches ?? 0);
      } catch {
        if (ticket === asked.current) setPickError(MESSAGES.server_error);
      } finally {
        if (ticket === asked.current) setSearching(false);
      }
    }, page === 1 ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, page, ownerId]);

  const chosen = new Set(items.map((p) => p.id));
  const full = items.length >= MAX_BUNDLE_ITEMS;
  const priceCents = owner ? owner.priceCents : readMoney(price, currency);
  const worth = items.reduce((sum, p) => sum + p.priceCents, 0);
  const initialIds = initial.map((p) => p.id).join(",");
  const sentPick = choosing ? pick : null;
  const dirty = mode !== "edit" || items.map((p) => p.id).join(",") !== initialIds || sentPick !== (owner?.pick ?? null);

  function move(index: number, by: -1 | 1) {
    setItems((current) => {
      const next = [...current];
      const to = index + by;
      if (to < 0 || to >= next.length) return current;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }

  async function post(payload: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; id?: string }> {
    const response = await fetch("/api/store/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
  }

  async function save() {
    setError(null);
    if (items.length < MIN_BUNDLE_ITEMS) {
      setError(MESSAGES.count);
      return;
    }
    if (mode === "create" && !title.trim()) {
      setError(MESSAGES.title);
      return;
    }
    if (mode === "create" && (priceCents === null || priceCents <= 0)) {
      setError(MESSAGES.price);
      return;
    }
    if (sentPick !== null && (sentPick < MIN_PICK || sentPick >= items.length)) {
      setError(MESSAGES.pick);
      return;
    }
    setBusy(true);
    try {
      const ids = items.map((p) => p.id);
      const data =
        mode === "create"
          ? await post({ action: "create", title, summary, price, items: ids, pick: sentPick })
          : await post({ action: "save", id: owner?.id, items: ids, pick: sentPick });
      if (!data.ok) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        return;
      }
      toast(mode === "create" ? "Bundle added to your store." : "Bundle saved.");
      router.push(studioHref(`/studio/bundles?product=${encodeURIComponent(data.id ?? owner?.id ?? "")}`));
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post({ action: "clear", id: owner.id });
      if (!data.ok) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        return;
      }
      toast("It is an ordinary product again.");
      router.push(studioHref("/studio/bundles"));
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }

  return (
    <section className="card min-w-0 p-5 sm:p-7" aria-labelledby="bundle-title">
      <h2 id="bundle-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        {mode === "create" ? "A new bundle" : owner?.title}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {mode === "create"
          ? "One product, at one price, that hands over several of yours. Each buyer gets every product in it exactly as if they had bought it on its own."
          : mode === "convert"
            ? `Choose what ${owner?.title ?? "this product"} hands over. Its name, price, picture and page stay as they are.`
            : "What a buyer gets, in the order they see it. People who bought it before keep what was in it when they paid."}
      </p>

      {mode === "create" ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2" htmlFor="bundle-name">
            <span className="field-label">Name</span>
            <input
              id="bundle-name"
              className="field"
              value={title}
              maxLength={MAX_TITLE_LENGTH}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The complete toolkit"
            />
          </label>
          <label className="block" htmlFor="bundle-price">
            <span className="field-label">{currency === "usd" ? "Price, in dollars" : `Price, ${fieldPrefix(currency)}`}</span>
            <input
              id="bundle-price"
              className="field"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={priceExample(currency, 49)}
            />
          </label>
          <label className="block sm:col-span-2" htmlFor="bundle-summary">
            <span className="field-label">One line about it (optional)</span>
            <input
              id="bundle-summary"
              className="field"
              value={summary}
              maxLength={MAX_SUMMARY_LENGTH}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Every guide and template, in one purchase."
            />
          </label>
        </div>
      ) : null}

      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-ink">{`In it: ${items.length} of ${MAX_BUNDLE_ITEMS}`}</h3>
          {items.length >= MIN_BUNDLE_ITEMS && priceCents !== null && priceCents > 0 && !choosing ? (
            <p className="text-sm font-semibold text-ink" aria-live="polite">
              {worth > priceCents
                ? `${formatMoney(worth, currency)} of products for ${formatMoney(priceCents, currency)}`
                : `${formatMoney(worth, currency)} of products; the bundle costs ${formatMoney(priceCents, currency)}`}
            </p>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p className="mt-3 rounded-2xl border-2 border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-soft">
            {`Nothing in it yet. Add at least ${MIN_BUNDLE_ITEMS} products from the list below.`}
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {items.map((p, i) => (
              <li key={p.id} className="flex min-h-[52px] items-center gap-3 rounded-2xl bg-white px-3 py-2 ring-1 ring-line">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-lilac text-xs font-bold text-violet-deep">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold leading-snug text-ink">{p.title}</span>
                  <span className="block text-xs text-ink-soft">
                    {[formatMoney(p.priceCents, currency), p.what, p.hidden ? "Draft, sold only in bundles" : ""].filter(Boolean).join(" · ")}
                  </span>
                  {p.why ? <span className="block text-xs font-semibold text-danger">{`${p.why}: take it out before saving.`}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${p.title} up`}
                    className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-paper hover:text-ink disabled:opacity-30"
                  >
                    <Icon name="chevron-down" size={16} className="rotate-180" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === items.length - 1}
                    aria-label={`Move ${p.title} down`}
                    className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-paper hover:text-ink disabled:opacity-30"
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setItems((current) => current.filter((x) => x.id !== p.id))}
                    aria-label={`Take ${p.title} out`}
                    className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="mt-5 rounded-2xl bg-white p-4 ring-1 ring-line">
        <label className="flex min-h-11 items-start gap-3">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={choosing} onChange={(e) => setChoosing(e.target.checked)} />
          <span>
            <span className="block font-semibold text-ink">Let each buyer choose which ones they get</span>
            <span className="block text-sm text-ink-soft">
              {`"Any ${pick} of these ${Math.max(items.length, pick + 1)} for one price." Its page lists them with their own prices, the buyer selects that many, and gets exactly those. Bought from its own page only: not in a box at checkout, as an offer after paying, as a gift or through PayPal.`}
            </span>
          </span>
        </label>
        {choosing ? (
          <label className="mt-3 flex items-center gap-3" htmlFor="bundle-pick">
            <span className="text-sm font-semibold text-ink">Each buyer chooses</span>
            <input
              id="bundle-pick"
              type="number"
              inputMode="numeric"
              min={MIN_PICK}
              max={Math.max(MIN_PICK, items.length - 1)}
              className="field w-24"
              value={pick}
              onChange={(e) => setPick(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
            <span className="text-sm text-ink-soft">{`of the ${items.length} in it`}</span>
          </label>
        ) : null}
      </div>

      <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line">
        <label htmlFor="bundle-find" className="text-sm font-bold text-ink">
          Add your products
        </label>
        <input
          id="bundle-find"
          type="search"
          className="field field-search mt-2 w-full"
          placeholder="Find a product by its name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <p className="mt-2 text-xs text-ink-mute" role="status">
          {searching && page === 1
            ? "Looking…"
            : pickError
              ? ""
              : matches === 0
                ? query
                  ? "Nothing has that in its name."
                  : "Your store has no other products yet."
                : `${matches.toLocaleString("en-US")} ${matches === 1 ? "product" : "products"}${query ? " found" : ""}. One-off paid products with a file, a link or a course with lessons can go in.`}
        </p>
        {pickError ? <p className="notice notice-error mt-2" role="alert">{pickError}</p> : null}
        <ul className="mt-3 divide-y divide-line">
          {found.map((p) => {
            const inIt = chosen.has(p.id);
            return (
              <li key={p.id} className="flex min-h-[52px] items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{p.title}</span>
                  <span className="block text-xs text-ink-soft">
                    {p.why ?? [formatMoney(p.priceCents, currency), p.what, p.hidden ? "Draft" : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {p.why ? null : (
                  <button
                    type="button"
                    disabled={inIt || full}
                    onClick={() => setItems((current) => [...current, p])}
                    className="btn btn-secondary btn-sm shrink-0"
                    aria-label={inIt ? `${p.title} is in the bundle` : `Add ${p.title}`}
                  >
                    {inIt ? (
                      <>
                        <Icon name="check" size={14} /> Added
                      </>
                    ) : (
                      <>
                        <Icon name="plus" size={14} /> Add
                      </>
                    )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {more ? (
          <button type="button" className="btn btn-ghost btn-sm mt-2" disabled={searching} onClick={() => setPage((n) => n + 1)}>
            {searching ? "Loading…" : "Show more"}
          </button>
        ) : null}
        {full ? <p className="mt-2 text-xs text-ink-soft">{`${MAX_BUNDLE_ITEMS} products is the most one bundle holds.`}</p> : null}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-ink-soft">
        A buyer gets each product in the bundle exactly as if they had bought it on its own: its download or link on the
        thank-you page and in their purchases, its course, its license key and its stamped PDF, and they may review each one.
        A refund of the bundle closes all of them. Products kept as drafts can go in, so something can be sold only as part
        of a bundle. The value shown on your store is worked out from each product&apos;s price today, and is only shown when
        the products cost more on their own.
      </p>

      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} aria-busy={busy} disabled={busy || !dirty} className="btn btn-primary">
          {busy ? "Saving…" : mode === "create" ? "Add the bundle" : "Save the bundle"}
        </button>
        {mode === "edit" && owner ? (
          confirmClear ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              Make it an ordinary product again?
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={clear}>
                Yes, stop the bundle
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(true)}>
              Stop being a bundle
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}
