"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cartWords } from "@/lib/buyer-words/cart";
import { MAX_CART } from "@/lib/cart-rules";
import type { LanguageCode } from "@/lib/store-language";
import { AssistReminderBox } from "@/components/assistant-reminder-box";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { WithdrawalWhere } from "@/components/withdrawal-where";

/**
 * A store's cart (lib/cart-rules.ts), kept in the visitor's own browser and
 * nowhere else: which products, by id, for this store. Prices are never kept
 * here; the cart asks the store for them when it is opened, and the checkout
 * reads them again. A browser that keeps nothing simply has no cart.
 */
const key = (handle: string) => `mm-cart:${handle}`;
const CHANGED = "mm-cart-changed";
/** How long the cart waits for its read before it says the prices could not be checked (a stalled connection never answers). */
const CART_READ_MS = 8_000;

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
type Line = { id: string; title: string; href: string; price: string; ok: boolean; ships?: string | null; soldOut?: boolean };
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
  // The ids the last read that answered was for; the ids a read failed or ran out of time for (a failure about another
  // cart is not said); whether a read "Try again" started is still running; and the count that "Try again" raises to
  // read the cart once more (with the focus put back on the panel when that read answers, and only then).
  const [checked, setChecked] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The store the cart belongs to answered that it does not exist (404, "unknown"): nothing can be paid for here, and
  // "Try again" would only fail again, so the panel says so instead of offering either.
  const [closed, setClosed] = useState(false);
  const [tries, setTries] = useState(0);
  const retried = useRef(false);
  // Whether anything is handed over digitally: only then is the box to start at once asked for (lib/digital-consent.ts).
  const [digital, setDigital] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Once opened, the button stays until the page is left, even with the cart emptied, so the focus always has it to go back to (2.4.3).
  const [kept, setKept] = useState(false);
  // Which product's button the focus moves to once one is removed: the next one, or the panel when none is left (2.4.3).
  const refocus = useRef<number | null>(null);
  const wanted = ids.join(",");

  useEffect(() => {
    if (!open || !wanted) return;
    let live = true;
    // The combined figures (the total, the deal, the "add more" row and shipping) are shown only for the cart the last
    // read that answered was for (`current` below): from the moment the cart changes, the button carries no amount and
    // the panel says the prices are being checked. A read that fails, or does not answer within CART_READ_MS, also clears
    // them and the panel says the prices could not be checked (Stripe's page shows the exact total before anything is
    // paid). Each line's own price, and the bundle and suggestion prices, stay from the last read that answered. A
    // product that read never covered is not offered for payment at all until a read covers it (`unchecked` below).
    const stop = new AbortController();
    const fail = () => {
      if (!live) return;
      setFailedFor(wanted);
      setBusy(false);
      // A "Try again" that failed is over: a later read the buyer did not ask for never moves the focus.
      retried.current = false;
      setTotal("");
      setDeal(null);
      setNext(null);
      setShipping(null);
    };
    const timer = window.setTimeout(() => {
      fail();
      stop.abort();
    }, CART_READ_MS);
    fetch(`/api/store/cart?${new URLSearchParams({ handle, ids: wanted })}`, { signal: stop.signal })
      .then(async (r) => {
        const data = await r.json();
        // Only the cart's own answer for a store that does not exist; any other 404 (a page in front of it) is an
        // ordinary failure, with "Try again".
        return r.status === 404 && data?.error === "unknown" ? { ...data, closed: true } : data;
      })
      .then((data: { ok?: boolean; closed?: boolean; items?: Line[]; total?: string; deal?: { percent: number; saved: string } | null; next?: { more: number; percent: number } | null; suggest?: Suggestion[]; bundle?: BundleSwap | null; shipping?: ShippingRow | null; apart?: Apart | null; digital?: boolean }) => {
        if (!live) return;
        if (data.closed) {
          setClosed(true);
          return fail();
        }
        if (!data.ok) return fail();
        setClosed(false);
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
        setChecked(wanted);
        setFailedFor(null);
        setBusy(false);
        if (retried.current) {
          // "Try again" goes once the read answers: the focus goes to the panel, not to the page.
          retried.current = false;
          panel.current?.focus();
        }
      })
      .catch(fail)
      .finally(() => window.clearTimeout(timer));
    return () => {
      live = false;
      window.clearTimeout(timer);
      stop.abort();
    };
  }, [open, wanted, handle, tries]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  // Escape shuts it from anywhere on the page; from inside it, the focus goes back to its button (2.1.1, 2.4.3). The panel lies
  // over the page: wherever the focus lands outside the cart, however it got there, it shuts, so it never covers what has the
  // focus (2.4.11, 2.4.12).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = Boolean(panel.current?.contains(document.activeElement));
      setOpen(false);
      if (inside) opener.current?.focus();
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  useEffect(() => {
    if (refocus.current === null) return;
    const buttons = panel.current?.querySelectorAll<HTMLButtonElement>("button[data-remove]");
    const at = refocus.current;
    refocus.current = null;
    (buttons && buttons.length > 0 ? buttons[Math.min(at, buttons.length - 1)] : panel.current)?.focus();
  }, [wanted]);

  if (ids.length === 0 && notice === null && !restoring && !kept) return null;
  const shown = (lines ?? []).filter((line) => ids.includes(line.id));
  const payable = shown.filter((line) => line.ok);
  const held = apart !== null && apart.ids.some((id) => ids.includes(id));
  // Products no read has answered for yet (the first read, or one just added): never offered for payment until a read
  // covers them, so the form never posts fewer products than the cart's button counts. Until then the panel says the
  // prices are being checked or, once the read failed or ran out of time, how many could not be checked, beside a button
  // that reads the cart again.
  const covered = checked === null ? [] : checked.split(",");
  const unchecked = ids.filter((id) => !covered.includes(id));
  // The combined figures belong to the cart the last read that answered was for, never to the one before a change.
  const current = checked === wanted;
  // A failure is said only for this cart and not while "Try again" is checking it; when that read fails too, the alert
  // comes back as a new one, so it is announced again.
  const failed = failedFor === wanted && !busy;
  // "Try again" stays where it is while its read runs (so the focus is not lost), says it is busy, and starts no second read.
  const retry = (
    <button
      type="button"
      className="btn st-btn-ghost btn-sm inline-flex min-h-11 min-w-11 items-center justify-center"
      aria-disabled={busy}
      aria-busy={busy}
      onClick={() => {
        if (busy) return;
        retried.current = true;
        setBusy(true);
        setTries((n) => n + 1);
      }}
    >
      {c.retry}
    </button>
  );
  // What could not be checked, a status line that says when it is being checked again (kept in place, so the change is
  // heard), and the button that checks again.
  const trouble = (sentence: string, mark: "data-cart-unchecked" | "data-cart-unpriced") => (
    <div className="space-y-2">
      {failed ? <p className="st-note text-sm" role="alert" {...{ [mark]: "" }}>{sentence}</p> : null}
      <p className={busy ? "st-muted text-sm" : "sr-only"} role="status">{busy ? c.loading : ""}</p>
      {retry}
    </div>
  );
  const waiting =
    failed || busy ? (
      <div className="mt-3">{trouble(c.uncheckedSome(unchecked.length), "data-cart-unchecked")}</div>
    ) : (
      <p className="st-muted mt-3 text-sm" role="status">{c.loading}</p>
    );

  return (
    <div ref={root} id="cart" className="st-cart">
      <button
        ref={opener}
        type="button"
        className="btn st-btn st-cart-open"
        aria-expanded={open}
        onClick={() => {
          // Opening the panel reads the cart again: until that read answers, it says the prices are being checked, not
          // what the read before it said.
          if (!open) {
            setFailedFor(null);
            if (closed) {
              // After "not taking orders", nothing read before it is shown again: no old lines and no checkout form
              // until a read answers (each product counts as not checked yet).
              setLines(null);
              setChecked(null);
            }
            setClosed(false);
          }
          setOpen(!open);
          setKept(true);
        }}
      >
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
            <button
              type="button"
              className="st-footer-link inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-semibold"
              onClick={() => {
                setOpen(false);
                opener.current?.focus();
              }}
            >
              {c.close}
            </button>
          </div>
          {notice && notice !== "consent" ? (
            <p className="st-note mt-3 text-sm" role="alert">{notice === "changed" ? c.changed : c.error}</p>
          ) : null}
          {ids.length === 0 ? (
            <p className="st-muted mt-3 text-sm">{c.empty}</p>
          ) : closed ? (
            <p className="st-note mt-3 text-sm" role="alert" data-cart-closed="">{c.storeClosed}</p>
          ) : lines === null ? (
            waiting
          ) : (
            <>
              <ul className="mt-3 divide-y" style={{ borderColor: "var(--st-line)" }}>
                {shown.map((line, at) => (
                  <li key={line.id} className="flex items-start justify-between gap-3 py-3" style={{ borderColor: "var(--st-line)" }}>
                    <span className="min-w-0">
                      <a href={line.href} className="st-title-link flex min-h-11 items-center font-semibold">{line.title}</a>
                      {line.ok ? null : <span className="st-muted block text-xs">{line.soldOut ? c.soldOut : c.gone}</span>}
                      {line.ok && line.ships ? <span className="st-muted block text-xs">{line.ships}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {line.ok ? <span className="st-price text-sm tabular-nums">{line.price}</span> : null}
                      <button
                        type="button"
                        aria-label={c.remove(line.title)}
                        data-remove=""
                        className="grid h-11 w-11 place-items-center rounded-full"
                        onClick={() => {
                          refocus.current = at;
                          write(handle, read(handle).filter((id) => id !== line.id));
                          // Nothing came out (the browser refused to keep it): the focus stays here, and nothing stays armed to move
                          // it later, on a change the person did not make (3.2.1).
                          if (read(handle).includes(line.id)) refocus.current = null;
                        }}
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
                      <a href={bundle.href} className="st-title-link flex min-h-11 items-center text-sm font-semibold">{bundle.title}</a>
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
                                <a href={item.href} className="st-title-link flex min-h-11 items-center text-sm font-semibold">{item.title}</a>
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
              {held ? null : unchecked.length > 0 ? waiting : payable.length > 0 ? (
                <form action="/api/store/cart" method="post" target="_top" className="mt-3 space-y-3" data-checkout="">
                  <input type="hidden" name="handle" value={handle} />
                  {payable.map((line) => (
                    <input key={line.id} type="hidden" name="id" value={line.id} />
                  ))}
                  {current && deal ? (
                    <p className="flex justify-between text-sm font-semibold" style={{ color: "var(--st-accent-text)" }}>
                      <span>{c.dealRow(deal.percent)}</span>
                      <span className="tabular-nums">{`−${deal.saved}`}</span>
                    </p>
                  ) : current && next ? (
                    <p className="st-muted text-sm font-semibold">{c.dealNext(next.more, next.percent)}</p>
                  ) : null}
                  {current && shipping ? (
                    <div className="text-sm" data-cart-shipping="">
                      <p className="flex justify-between font-semibold">
                        <span>{shipping.label}</span>
                        {shipping.amount ? <span className="tabular-nums">{shipping.amount}</span> : null}
                      </p>
                      <p className="st-muted text-xs">{shipping.notTo ? `${shipping.where}. ${shipping.notTo}` : shipping.where}</p>
                    </div>
                  ) : null}
                  {current && total ? (
                    <p className="flex justify-between text-sm font-semibold">
                      <span>{c.total}</span>
                      <span className="tabular-nums">{total}</span>
                    </p>
                  ) : failed || busy ? (
                    trouble(c.unchecked, "data-cart-unpriced")
                  ) : !current ? (
                    <p className="st-muted text-sm" role="status">{c.loading}</p>
                  ) : (
                    <p className="st-note text-sm" role="alert" data-cart-unpriced="">{c.unchecked}</p>
                  )}
                  {remind ? <AssistReminderBox id={`r-cart-${handle}`} lang={lang} store={remind} /> : null}
                  {/* Asked when anything in the cart is handed over digitally; a cart of shipped products only has nothing to start at once, and is told in its place where the withdrawal function is (art. 6(1)(h)). */}
                  {digital ? <DigitalConsentBox id={`dc-cart-${handle}`} lang={lang} refused={notice === "consent"} /> : <WithdrawalWhere lang={lang} />}
                  <button type="submit" className="btn st-btn btn-block">{current && total ? c.checkout(total) : c.checkoutUnpriced}</button>
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
