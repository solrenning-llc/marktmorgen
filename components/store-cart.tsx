"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cartWords } from "@/lib/buyer-words/cart";
import { MAX_CART } from "@/lib/cart-rules";
import type { LanguageCode } from "@/lib/store-language";
import { AssistReminderBox } from "@/components/assistant-reminder-box";
import { DigitalConsentBox } from "@/components/digital-consent-box";

/**
 * A store's cart (lib/cart-rules.ts), kept in the visitor's own browser and
 * nowhere else: which products, by id, for this store. Prices are never kept
 * here; the cart asks the store for them when it is opened, and the checkout
 * reads them again. A browser that keeps nothing simply has no cart.
 */
const key = (handle: string) => `mm-cart:${handle}`;
const CHANGED = "mm-cart-changed";

function read(handle: string): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(handle)) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string").slice(0, MAX_CART) : [];
  } catch {
    return [];
  }
}

function write(handle: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key(handle), JSON.stringify(ids.slice(0, MAX_CART)));
  } catch {
    // Nothing kept: the cart is only as long as this page.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(change: () => void): () => void {
  window.addEventListener("storage", change);
  window.addEventListener(CHANGED, change);
  return () => {
    window.removeEventListener("storage", change);
    window.removeEventListener(CHANGED, change);
  };
}

/** The ids in this store's cart, the same in every part of the page. */
function useCart(handle: string): string[] {
  const raw = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(read(handle)),
    () => "[]",
  );
  return JSON.parse(raw) as string[];
}

/** "Add to cart" under a product's buy button. */
export function AddToCart({
  handle,
  productId,
  lang,
  deal = null,
}: {
  handle: string;
  productId: string;
  lang: LanguageCode;
  /** The store's deal for buying more, said before the buyer chooses (lib/cart-rules.ts). */
  deal?: { min: number; percent: number } | null;
}) {
  const c = cartWords(lang);
  const ids = useCart(handle);
  const inCart = ids.includes(productId);
  const full = !inCart && ids.length >= MAX_CART;
  return (
    <div className="mt-2">
      <button
        type="button"
        className="btn st-btn-ghost btn-block"
        aria-pressed={inCart}
        disabled={full}
        onClick={() => {
          // Read again at the press, never from the last drawing: two quick presses on two cards both count.
          const now = read(handle);
          write(handle, now.includes(productId) ? now.filter((id) => id !== productId) : now.length < MAX_CART ? [...now, productId] : now);
        }}
      >
        {inCart ? c.added : c.add}
      </button>
      {full ? <p className="st-muted mt-1 text-center text-xs">{c.full(MAX_CART)}</p> : deal ? <p className="st-muted mt-1 text-center text-xs">{c.dealHint(deal.min, deal.percent)}</p> : null}
    </div>
  );
}

/** `ships`: for a product the creator ships, its line about shipping, as its own page says it (lib/shipping.ts). */
/** `heldMinutes`: a limited product whose units left are all in other buyers' checkouts, and at most how long they stay there. */
type Line = { id: string; title: string; href: string; price: string; ok: boolean; ships?: string | null; soldOut?: boolean; heldMinutes?: number | null };
/** What shipping comes to and where it can go, said before paying (lib/cart-shipping.ts). */
type ShippingRow = { amount: string | null; label: string; where: string; notTo: string | null };
/** Products that cannot ship with the rest: the cart cannot be paid for until they are taken out. */
type Apart = { ids: string[]; why: string };
/**
 * Something that could go in the cart too, with why it is shown: the
 * creator's own pick (lib/store-collections.ts) or something the buyers of
 * what is in it also bought (lib/also-bought.ts). Each under its own heading,
 * so a pick is never read as a count of buyers.
 */
type Suggestion = { id: string; title: string; href: string; price: string; why: string; kind?: "pick" | "bought" };
/**
 * The creator's own bundle that holds what is in the cart and makes it cost
 * less (lib/cart-bundle.ts): the swap takes out what it holds and puts it in.
 */
type BundleSwap = { id: string; title: string; href: string; price: string; holds: string; save: string; replaces: string[] };

/**
 * The cart's button, at the top of the page once something is in it, and
 * what it opens: each product with its price as the store charges it now,
 * the total, and the button that pays for them all.
 */
export function CartButton({
  handle,
  lang,
  notice,
  restore = [],
  remind = "",
}: {
  handle: string;
  lang: LanguageCode;
  notice: "changed" | "error" | "consent" | null;
  /** The store's name when its checkout offers the Store assistant's box for one reminder (lib/assistant-reminder.ts); "" when not. */
  remind?: string;
  /** A cart put back as it was, from a reminder's link or the way back from its checkout (lib/checkout-recovery.ts, cartLink). */
  restore?: string[];
}) {
  const c = cartWords(lang);
  const ids = useCart(handle);
  const [open, setOpen] = useState(notice !== null || restore.length > 0);
  const restoring = restore.join(",");
  useEffect(() => {
    if (!restoring) return;
    write(handle, restoring.split(","));
    // Put back once: a reload or a shared address does not put it back again over what was changed since.
    const url = new URL(window.location.href);
    url.searchParams.delete("restore");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [handle, restoring]);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [total, setTotal] = useState("");
  const [deal, setDeal] = useState<{ percent: number; saved: string } | null>(null);
  const [next, setNext] = useState<{ more: number; percent: number } | null>(null);
  const [suggest, setSuggest] = useState<Suggestion[]>([]);
  const [bundle, setBundle] = useState<BundleSwap | null>(null);
  const [shipping, setShipping] = useState<ShippingRow | null>(null);
  const [apart, setApart] = useState<Apart | null>(null);
  // Whether anything is handed over digitally: only then is the box to start at once asked for (lib/digital-consent.ts).
  const [digital, setDigital] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const wanted = ids.join(",");

  useEffect(() => {
    if (!open || !wanted) return;
    let live = true;
    fetch(`/api/store/cart?${new URLSearchParams({ handle, ids: wanted })}`)
      .then((r) => r.json())
      .then((data: { ok?: boolean; items?: Line[]; total?: string; deal?: { percent: number; saved: string } | null; next?: { more: number; percent: number } | null; suggest?: Suggestion[]; bundle?: BundleSwap | null; shipping?: ShippingRow | null; apart?: Apart | null; digital?: boolean }) => {
        if (!live || !data.ok) return;
        setLines(data.items ?? []);
        setTotal(data.total ?? "");
        setDeal(data.deal ?? null);
        setNext(data.next ?? null);
        setSuggest(data.suggest ?? []);
        setBundle(data.bundle ?? null);
        setShipping(data.shipping ?? null);
        setApart(data.apart ?? null);
        // Unknown is asked: a cart that does not say is treated as holding something digital.
        setDigital(data.digital !== false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, wanted, handle]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  if (ids.length === 0 && notice === null && !restoring) return null;
  const shown = (lines ?? []).filter((line) => ids.includes(line.id));
  const payable = shown.filter((line) => line.ok);
  const held = apart !== null && apart.ids.some((id) => ids.includes(id));

  return (
    <div id="cart" className="st-cart">
      <button type="button" className="btn st-btn st-cart-open" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="10" cy="20" r="1.4" fill="currentColor" />
          <circle cx="17" cy="20" r="1.4" fill="currentColor" />
        </svg>
        {c.open(ids.length)}
      </button>
      {open ? (
        <div ref={panel} tabIndex={-1} role="region" aria-label={c.title} className="st-card st-cart-panel p-5 text-left">
          <div className="flex items-center justify-between gap-3">
            <p className="font-display text-lg font-semibold">{c.title}</p>
            <button type="button" className="st-footer-link text-sm font-semibold" onClick={() => setOpen(false)}>
              {c.close}
            </button>
          </div>
          {notice && notice !== "consent" ? (
            <p className="st-note mt-3 text-sm" role="alert">{notice === "changed" ? c.changed : c.error}</p>
          ) : null}
          {ids.length === 0 ? (
            <p className="st-muted mt-3 text-sm">{c.empty}</p>
          ) : lines === null ? (
            <p className="st-muted mt-3 text-sm" role="status">{c.loading}</p>
          ) : (
            <>
              <ul className="mt-3 divide-y" style={{ borderColor: "var(--st-line)" }}>
                {shown.map((line) => (
                  <li key={line.id} className="flex items-start justify-between gap-3 py-3" style={{ borderColor: "var(--st-line)" }}>
                    <span className="min-w-0">
                      <a href={line.href} className="st-title-link block font-semibold">{line.title}</a>
                      {line.ok ? null : <span className="st-muted block text-xs">{line.soldOut ? c.soldOut : line.heldMinutes ? c.held(line.heldMinutes) : c.gone}</span>}
                      {line.ok && line.ships ? <span className="st-muted block text-xs">{line.ships}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {line.ok ? <span className="st-price text-sm tabular-nums">{line.price}</span> : null}
                      <button
                        type="button"
                        aria-label={c.remove(line.title)}
                        className="grid h-11 w-11 place-items-center rounded-full"
                        onClick={() => write(handle, read(handle).filter((id) => id !== line.id))}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {bundle && !ids.includes(bundle.id) && bundle.replaces.every((id) => ids.includes(id)) ? (
                <div className="mt-2 rounded-2xl p-3" style={{ background: "var(--st-accent-soft)" }} data-cart-bundle="">
                  <p className="text-sm font-semibold">{c.bundleHead}</p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <a href={bundle.href} className="st-title-link block text-sm font-semibold">{bundle.title}</a>
                      <span className="st-muted block text-xs">{bundle.holds}</span>
                      <span className="block text-xs font-semibold" style={{ color: "var(--st-accent-text)" }}>{bundle.save}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="st-price text-sm tabular-nums">{bundle.price}</span>
                      <button
                        type="button"
                        className="btn st-btn-ghost btn-sm"
                        aria-label={c.swapFor(bundle.title)}
                        onClick={() => {
                          // Read again at the press: another tab may have changed the cart.
                          const now = read(handle);
                          if (!bundle.replaces.every((id) => now.includes(id))) return;
                          write(handle, [...now.filter((id) => !bundle.replaces.includes(id) && id !== bundle.id), bundle.id]);
                        }}
                      >
                        {c.swap}
                      </button>
                    </span>
                  </div>
                </div>
              ) : null}
              {ids.length < MAX_CART
                ? (["pick", "bought"] as const).map((kind) => {
                    const offered = suggest.filter((item) => (item.kind ?? "bought") === kind && !ids.includes(item.id));
                    if (offered.length === 0) return null;
                    return (
                      <div key={kind} className="mt-2 rounded-2xl p-3" style={{ background: "var(--st-accent-soft)" }}>
                        <p className="text-sm font-semibold">{kind === "pick" ? c.pickHead : c.suggestHead}</p>
                        <ul className="mt-2 space-y-2">
                          {offered.map((item) => (
                            <li key={item.id} className="flex items-center justify-between gap-3">
                              <span className="min-w-0">
                                <a href={item.href} className="st-title-link block text-sm font-semibold">{item.title}</a>
                                <span className="st-muted block text-xs">{item.why}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                <span className="st-price text-sm tabular-nums">{item.price}</span>
                                <button
                                  type="button"
                                  className="btn st-btn-ghost btn-sm"
                                  aria-label={`${c.add}: ${item.title}`}
                                  onClick={() => {
                                    const now = read(handle);
                                    if (!now.includes(item.id) && now.length < MAX_CART) write(handle, [...now, item.id]);
                                  }}
                                >
                                  {c.add}
                                </button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })
                : null}
              {/* Always there, so a screen reader hears the sentence when it appears: nothing can be paid for until what cannot go together is taken out (lib/cart-shipping.ts). */}
              <p className={held ? "st-note mt-3 text-sm" : "sr-only"} role="status" data-cart-apart="">{held ? apart.why : ""}</p>
              {held ? null : payable.length > 0 ? (
                <form action="/api/store/cart" method="post" target="_top" className="mt-3 space-y-3" data-checkout="">
                  <input type="hidden" name="handle" value={handle} />
                  {payable.map((line) => (
                    <input key={line.id} type="hidden" name="id" value={line.id} />
                  ))}
                  {deal ? (
                    <p className="flex justify-between text-sm font-semibold" style={{ color: "var(--st-accent-text)" }}>
                      <span>{c.dealRow(deal.percent)}</span>
                      <span className="tabular-nums">{`−${deal.saved}`}</span>
                    </p>
                  ) : next ? (
                    <p className="st-muted text-sm font-semibold">{c.dealNext(next.more, next.percent)}</p>
                  ) : null}
                  {shipping ? (
                    <div className="text-sm" data-cart-shipping="">
                      <p className="flex justify-between font-semibold">
                        <span>{shipping.label}</span>
                        {shipping.amount ? <span className="tabular-nums">{shipping.amount}</span> : null}
                      </p>
                      <p className="st-muted text-xs">{shipping.notTo ? `${shipping.where}. ${shipping.notTo}` : shipping.where}</p>
                    </div>
                  ) : null}
                  <p className="flex justify-between text-sm font-semibold">
                    <span>{c.total}</span>
                    <span className="tabular-nums">{total}</span>
                  </p>
                  {remind ? <AssistReminderBox id={`r-cart-${handle}`} lang={lang} store={remind} /> : null}
                  {/* Asked when anything in the cart is handed over digitally; a cart of shipped products only has nothing to start at once. */}
                  {digital ? <DigitalConsentBox id={`dc-cart-${handle}`} lang={lang} refused={notice === "consent"} /> : null}
                  <button type="submit" className="btn st-btn btn-block">{c.checkout(total)}</button>
                  <p className="st-muted text-xs">{c.note}</p>
                </form>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Add all N to cart" on a collection's page (lib/store-collections.ts): the
 * products of it that can go in a cart, added at one press, when they all
 * fit. Never more than the cart holds: when they do not fit, it says so and
 * each card's own button stays.
 */
export function AddAllToCart({ handle, productIds, lang }: { handle: string; productIds: string[]; lang: LanguageCode }) {
  const c = cartWords(lang);
  const ids = useCart(handle);
  const missing = productIds.filter((id) => !ids.includes(id));
  if (productIds.length < 2) return null;
  if (missing.length === 0) return <p className="st-muted mt-4 text-center text-sm">{c.allIn}</p>;
  const fits = ids.length + missing.length <= MAX_CART;
  return (
    <div className="mt-4">
      <button
        type="button"
        className="btn st-btn btn-block"
        disabled={!fits}
        onClick={() => {
          // Read again at the press: another tab may have changed the cart.
          const now = read(handle);
          const add = productIds.filter((id) => !now.includes(id));
          if (now.length + add.length <= MAX_CART) write(handle, [...now, ...add]);
        }}
      >
        {c.addAll(productIds.length)}
      </button>
      {fits ? null : <p className="st-muted mt-1 text-center text-xs">{c.noRoom(MAX_CART)}</p>}
    </div>
  );
}

/** Empties this store's cart once what was in it has been paid for. */
export function ClearCart({ handle }: { handle: string }) {
  useEffect(() => {
    write(handle, []);
  }, [handle]);
  return null;
}
