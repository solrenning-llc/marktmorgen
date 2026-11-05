"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Listing, Product } from "@/lib/store";
import type { BumpChoice } from "@/lib/catalog";
import { useStudioHref } from "@/components/studio-store-pin";
import { type Currency, currencyRule, fieldPrefix, formatMoney, moneyField, readMoney } from "@/lib/money";
import { useStoreCurrency } from "@/components/store-currency";
import {
  type Bump,
  MAX_BUMPS,
  MAX_PITCH_LENGTH,
  MAX_PLAN_PAYMENTS,
  MAX_STOCK,
  MIN_PLAN_PAYMENTS,
  canBeBumped,
  isOneOff,
  planWords,
} from "@/lib/product-extras";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import type { ExtraNotes } from "@/lib/extras-notes";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  stock: `Type a whole number from 1 to ${MAX_STOCK.toLocaleString("en-US")}.`,
  target: "Pick another product with one price, no limit on how many can be sold, and a file, a link or a bundle behind it.",
  kind: "This works on one-off paid products only.",
  twice: "That product is already offered in another box here. Pick a different one.",
  full: `A product can offer ${MAX_BUMPS} products at checkout at most.`,
  slot: "The offers here changed in another tab. Reload the page.",
  sold_with: "This product is also sold in a bundle, a checkout box or an offer after paying. Take it out of those first: only its own checkout counts sales against the number.",
  unknown: "That product is no longer in your store. Reload the page.",
  store_full: "Your store is full. Remove something before adding more.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** The two sentences about the smallest charge, in the store's currency (lib/money.ts). */
const amountMessages = (currency: Currency): Record<string, string> => {
  const least = formatMoney(currencyRule(currency).minCharge, currency);
  return {
    price: `Type an amount of at least ${least}. An offer at checkout costs no more than that product on its own, and a payment plan's payments add up to at least the full price.`,
    plan: `Pick how many payments, how often, and an amount of at least ${least} for each.`,
    plan_price: `Set a payment for every price, of at least ${least}, so that the payments add up to at least that price.`,
  };
};

/** A product's limited quantity and its order bump, in the studio. */

/** The choices from a list of products at hand: those with one price and one delivery. */
export function bumpChoices(products: Listing[]): BumpChoice[] {
  return products.filter((p) => canBeBumped(p)).map((p) => ({ id: p.id, title: p.title, priceCents: p.priceCents }));
}

/**
 * An extra that is set up but not being shown, said plainly where it is set up.
 *
 * The studio used to print "Offers Templates for $9 at checkout" whether or not
 * a buyer ever saw the box. Every reason it can be quiet comes from a change to
 * some *other* product — a price cut, a limit, an option — so a creator had no
 * way of connecting the two, and the first sign was the takings.
 */
function Quiet({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  // One line is the reason itself and reads as a sentence. Several means the
  // first is a heading over the rest — a funnel with some offers dark — and
  // only that one is bold. Rendering these showed a whole amber paragraph in
  // bold, which is a shout where a sentence was wanted.
  const heading = lines.length > 1;
  return (
    <p className="notice notice-warn mt-1" role="status">
      {lines.map((line, i) => (
        <span key={line} className={i === 0 ? (heading ? "font-semibold" : "") : "mt-1 block"}>{line}</span>
      ))}
    </p>
  );
}

export function CheckoutExtras({
  product,
  choices,
  named,
  notes,
}: {
  product: Product;
  /** Every product of the store that can be offered in the box, read by the page. */
  choices: BumpChoice[];
  /** The name of the product this one offers now, whether or not it is still a choice. */
  named: Record<string, string>;
  /** Whichever of this product's extras buyers are not being shown (lib/extras-notes.ts). */
  notes?: ExtraNotes;
}) {
  const studioHref = useStudioHref();
  const router = useRouter();
  const currency = useStoreCurrency();
  // "bump-0" to "bump-2": the box at that place; one past the last adds one.
  const [open, setOpen] = useState<"stock" | "plan" | `bump-${number}` | null>(null);
  const [stock, setStock] = useState(product.stock ? String(product.stock) : "");
  const candidates = choices.filter((p) => p.id !== product.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A product that is no longer a plain one-off has none of these controls —
  // they do not apply to it. What it may still have is extras stored from when
  // it was one, and those are exactly the ones a creator cannot see going
  // quiet, because the panel that would have told them is not drawn. So the
  // reason is said on its own, and nothing else is.
  if (!isOneOff(product)) {
    const orphans = [...(notes?.bumps ?? []), notes?.plan, ...(notes?.funnel ?? [])].filter((line): line is string => Boolean(line));
    return orphans.length ? <div className="mt-3"><Quiet lines={orphans} /></div> : null;
  }

  async function send(payload: Record<string, unknown>, confirmation: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, ...payload }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        setOpen(null);
        toast(confirmation);
        router.refresh();
        return;
      }
      setError(amountMessages(currency)[data.error ?? ""] ?? MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const link = "text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";

  return (
    <div className="mt-3 space-y-2">
      {open === "stock" ? (
        <form
          className="rounded-[var(--r-sm)] border border-line bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            send({ stock: stock.trim() }, "Limit saved.");
          }}
        >
          <label className="block">
            <span className="field-label">How many can be sold, in total</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_STOCK}
              step={1}
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className="field w-40"
              required
            />
          </label>
          <p className="mt-2 text-xs text-ink-soft">
            Your page shows how many are left, counted from real payments, and stops selling at zero. Someone paying right
            now holds one for about half an hour.
          </p>
          {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
              {busy ? "Saving…" : "Save the limit"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      ) : product.stock !== null ? (
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">{`Limited to ${product.stock.toLocaleString("en-US")}`}</span>
          {" · "}
          <button type="button" className={link} onClick={() => setOpen("stock")}>Change</button>
          {" · "}
          <button type="button" className={link} aria-busy={busy} disabled={busy} onClick={() => send({ stock: null }, "Limit removed.")}>No limit</button>
        </p>
      ) : (
        <button type="button" className={link} onClick={() => setOpen("stock")}>
          Limit how many can be sold
        </button>
      )}

      {/* A chosen amount has to be the only thing in its checkout. */}
      {product.pwyw ? (
        // The box does not go on a product whose buyers name the price, so
        // there is no control here — only the reason, when one is stored.
        <Quiet lines={(notes?.bumps ?? []).filter((line): line is string => Boolean(line))} />
      ) : (
        // One line per box, in the order buyers see them, and one more to add
        // a box while there is room for it (MAX_BUMPS).
        [...product.bumps, ...(product.bumps.length < MAX_BUMPS ? [null] : [])].map((current, slot) => {
          const key = `bump-${slot}` as const;
          const reason = notes?.bumps?.[slot] ?? null;
          // A product already offered in another box is not offered in this one.
          const others = new Set(product.bumps.filter((_, at) => at !== slot).map((bump) => bump.productId));
          return (
            <div key={current?.productId ?? "new"}>
              <OfferBlock
                owner={product.id}
                slot={slot}
                current={current}
                named={named}
                candidates={candidates.filter((p) => !others.has(p.id))}
                paused={Boolean(reason)}
                busy={busy}
                open={open === key}
                onOpen={() => setOpen(key)}
                onClose={() => { setOpen(null); setError(null); }}
                onSend={send}
                error={open === key ? error : null}
              />
              {open === key || !reason ? null : <Quiet lines={[reason]} />}
            </div>
          );
        })
      )}
      {product.funnel ? (
        <div>
          <p className="text-sm text-ink-soft">
            <span className={`font-semibold ${notes?.funnelOff ? "text-ink-soft" : "text-ink"}`}>
              {`${product.funnel.steps.length === 1 ? "One offer" : `${product.funnel.steps.length} offers`} after paying`}
            </span>
            {" \u00b7 "}
            <Link href={studioHref(`/studio/funnels?product=${product.id}`)} className={link}>Edit the funnel</Link>
          </p>
          <Quiet lines={notes?.funnel ?? []} />
        </div>
      ) : (
        <Link href={studioHref(`/studio/funnels?product=${product.id}`)} className={`block ${link}`}>
          Offer more after they pay
        </Link>
      )}
      {product.pwyw ? (
        <Quiet lines={notes?.plan ? [notes.plan] : []} />
      ) : (
        <div>
          <PlanBlock product={product} paused={Boolean(notes?.plan)} busy={busy} open={open === "plan"} onOpen={() => setOpen("plan")} onClose={() => { setOpen(null); setError(null); }} onSend={send} error={open === "plan" ? error : null} />
          {open === "plan" || !notes?.plan ? null : <Quiet lines={[notes.plan]} />}
        </div>
      )}
      {error && open === null ? <p className="notice notice-error" role="alert">{error}</p> : null}
    </div>
  );
}

const OFFER_TEXT = {
  bump: {
    add: "Offer another product at checkout",
    more: (slot: number) => `Offer one more at checkout (${slot + 1} of ${MAX_BUMPS})`,
    on: (title: string, price: string) => `Offers ${title} for ${price} at checkout`,
    // The same line for a box that is set up and not being shown. "Offers
    // Templates for $29.00 at checkout" is simply false then, and printing it
    // in bold above the reason it is false is the defect this whole change is
    // about, in miniature.
    paused: (title: string, price: string) => `Paused: ${title} for ${price} at checkout`,
    stop: "Stop offering it",
    save: "Save the offer",
    saved: "Checkout offer saved.",
    stopped: "Checkout offer stopped.",
    note: "Buyers see a box above the buy button and check it themselves; it is never checked for them. Everything checked is paid in one checkout and delivered on the thank-you page. With several boxes, each is checked on its own, in the order set here.",
  },
} as const;

function OfferBlock({
  owner,
  slot,
  current,
  named,
  candidates,
  paused,
  busy,
  open,
  onOpen,
  onClose,
  onSend,
  error,
}: {
  /** The product the box is on, so its fields keep ids of their own. */
  owner: string;
  /** Which box: 0 for the first. One past the last is a new box. */
  slot: number;
  /** What that box offers now, or null for a new one. */
  current: Bump | null;
  named: Record<string, string>;
  candidates: BumpChoice[];
  /** Whether this box is set up but not being shown (lib/extras-notes.ts). */
  paused: boolean;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSend: (payload: Record<string, unknown>, confirmation: string) => void;
  error: string | null;
}) {
  const currency = useStoreCurrency();
  const text = OFFER_TEXT.bump;
  const [target, setTarget] = useState(current?.productId ?? candidates[0]?.id ?? "");
  const [price, setPrice] = useState(current ? moneyField(current.priceCents, currency) : "");
  const [pitch, setPitch] = useState(current?.pitch ?? "");
  const currentTarget = current
    ? { title: named[current.productId] ?? candidates.find((p) => p.id === current.productId)?.title ?? "" }
    : null;
  const link = "text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";
  const id = `bump-${owner}-${slot}`;

  if (open) {
    return (
      <form
        className="rounded-[var(--r-sm)] border border-line bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend({ bump: { productId: target, price: price.trim(), pitch }, slot }, text.saved);
        }}
      >
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Add another product with one price and a file, a link or a bundle behind it, and it can be offered here.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block" htmlFor={`${id}-t`}>
              <span className="field-label">Offer this</span>
              <select id={`${id}-t`} value={target} onChange={(e) => setTarget(e.target.value)} className="field">
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>{`${p.title} (${formatMoney(p.priceCents, currency)})`}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor={`${id}-p`}>
              <span className="field-label">{currency === "usd" ? "For, in dollars" : `For, ${fieldPrefix(currency)}`}</span>
              <input
                id={`${id}-p`}
                type="text"
                inputMode={currency === "jpy" ? "numeric" : "decimal"}
                value={price}
                placeholder={currency === "jpy" ? "900" : "9"}
                onChange={(e) => setPrice(e.target.value)}
                className="field"
                required
              />
            </label>
            <label className="block sm:col-span-2" htmlFor={`${id}-w`}>
              <span className="field-label">One line to say why (optional)</span>
              <input
                id={`${id}-w`}
                type="text"
                maxLength={MAX_PITCH_LENGTH}
                value={pitch}
                placeholder="The templates that go with it, at a third of the price."
                onChange={(e) => setPitch(e.target.value)}
                className="field"
              />
            </label>
          </div>
        )}
        <p className="mt-2 text-xs text-ink-soft">{text.note}</p>
        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
        <div className="mt-3 flex flex-wrap gap-3">
          {candidates.length ? (
            <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
              {busy ? "Saving\u2026" : text.save}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  if (current && currentTarget?.title) {
    return (
      <p className="text-sm text-ink-soft">
        <span className={`font-semibold ${paused ? "text-ink-soft" : "text-ink"}`}>
          {(paused ? text.paused : text.on)(currentTarget.title, formatMoney(current.priceCents, currency))}
        </span>
        {" \u00b7 "}
        <button type="button" className={link} onClick={onOpen}>Change</button>
        {" \u00b7 "}
        <button type="button" className={link} aria-busy={busy} disabled={busy} onClick={() => onSend({ bump: null, slot }, text.stopped)}>{text.stop}</button>
      </p>
    );
  }
  return (
    <button type="button" className={`block ${link}`} onClick={onOpen}>
      {slot === 0 ? text.add : text.more(slot)}
    </button>
  );
}

function PlanBlock({
  product,
  paused,
  busy,
  open,
  onOpen,
  onClose,
  onSend,
  error,
}: {
  product: Product;
  /** Whether the plan is set up but not being offered (lib/extras-notes.ts). */
  paused: boolean;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSend: (payload: Record<string, unknown>, confirmation: string) => void;
  error: string | null;
}) {
  const current = product.plan;
  const currency = useStoreCurrency();
  const [payments, setPayments] = useState(current?.payments ?? 3);
  const [interval, setEvery] = useState<"week" | "month">(current?.interval ?? "month");
  // Each payment rounded up to a whole unit (a whole dollar, a hundred yen).
  const suggested = (n: number) => moneyField(Math.ceil(product.priceCents / n / 100) * 100, currency);
  const [price, setPrice] = useState(current ? moneyField(current.amountCents, currency) : suggested(3));
  // Several prices: one payment for each, suggested from that price the same way.
  const several = product.options.length > 0;
  const suggestedFor = (cents: number, n: number) => moneyField(Math.ceil(cents / n / 100) * 100, currency);
  const [each, setEach] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      product.options.map((option) => {
        const saved = current?.options?.[option.id];
        return [option.id, saved ? moneyField(saved, currency) : suggestedFor(option.priceCents, current?.payments ?? 3)];
      }),
    ),
  );
  const link = "text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";
  const id = `plan-${product.id}`;

  if (open) {
    return (
      <form
        className="rounded-[var(--r-sm)] border border-line bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(
            several
              ? {
                  plan: {
                    payments,
                    interval,
                    // A price off sale needs no payment (642 [WG2]); one left empty is not sent.
                    options: Object.fromEntries(
                      product.options
                        .filter((option) => !option.offSale || (each[option.id] ?? "").trim())
                        .map((option) => [option.id, (each[option.id] ?? "").trim()]),
                    ),
                  },
                }
              : { plan: { payments, interval, price: price.trim() } },
            "Payment plan saved.",
          );
        }}
      >
        <div className={`grid gap-3 ${several ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
          <label className="block" htmlFor={`${id}-n`}>
            <span className="field-label">Payments</span>
            <select
              id={`${id}-n`}
              value={payments}
              onChange={(e) => {
                const n = Number(e.target.value);
                setPayments(n);
                if (!current) {
                  setPrice(suggested(n));
                  setEach(Object.fromEntries(product.options.map((option) => [option.id, suggestedFor(option.priceCents, n)])));
                }
              }}
              className="field"
            >
              {Array.from({ length: MAX_PLAN_PAYMENTS - MIN_PLAN_PAYMENTS + 1 }, (_, i) => i + MIN_PLAN_PAYMENTS).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={`${id}-i`}>
            <span className="field-label">How often</span>
            <select id={`${id}-i`} value={interval} onChange={(e) => setEvery(e.target.value === "week" ? "week" : "month")} className="field">
              <option value="month">Every month</option>
              <option value="week">Every week</option>
            </select>
          </label>
          {several ? null : (
            <label className="block" htmlFor={`${id}-p`}>
              <span className="field-label">{currency === "usd" ? "Each payment, in dollars" : `Each payment, ${fieldPrefix(currency)}`}</span>
              <input
                id={`${id}-p`}
                type="text"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="field"
                required
              />
            </label>
          )}
        </div>
        {several ? (
          <fieldset className="mt-3">
            <legend className="field-label">{currency === "usd" ? "Each payment, in dollars, for each price" : `Each payment for each price, ${fieldPrefix(currency)}`}</legend>
            <div className="mt-1 space-y-2">
              {product.options.map((option) => {
                const typed = readMoney(each[option.id] ?? "", currency);
                const short = typed !== null && typed > 0 && typed * payments < option.priceCents;
                return (
                  <div key={option.id} className="grid items-center gap-2 sm:grid-cols-[1fr_10rem]">
                    <label htmlFor={`${id}-o-${option.id}`} className="text-sm text-ink">
                      <span className="font-semibold">{option.label}</span>
                      <span className="text-ink-soft">{` \u00b7 ${formatMoney(option.priceCents, currency)}`}</span>
                      {option.offSale ? <span className="block text-xs text-ink-soft">Off sale, so no payment is needed. Fill it in to have one ready if you put it back on sale.</span> : null}
                      {short ? <span className="block text-xs text-ink-soft">{`${payments} of these come to less than ${formatMoney(option.priceCents, currency)}.`}</span> : null}
                    </label>
                    <input
                      id={`${id}-o-${option.id}`}
                      type="text"
                      inputMode="decimal"
                      value={each[option.id] ?? ""}
                      onChange={(e) => setEach((was) => ({ ...was, [option.id]: e.target.value }))}
                      className="field"
                      aria-invalid={short || undefined}
                      required={!option.offSale}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <p className="mt-2 text-xs text-ink-soft">
          Buyers choose between paying in full and the plan. They get the product after the first payment; the rest are
          charged to the same card on your own Stripe account, and the plan stops by itself after the last one. The
          payments add up to at least the full price{several ? ", for each price, and buyers see each price\u2019s payments beside it" : ""}.
        </p>
        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
            {busy ? "Saving\u2026" : "Save the plan"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  if (current) {
    return (
      <p className="text-sm text-ink-soft">
        <span className={`font-semibold ${paused ? "text-ink-soft" : "text-ink"}`}>
          {`${paused ? "Payment plan, paused" : "Payment plan"}: ${planWords(current, currency)}${current.options && several ? `, from ${formatMoney(current.amountCents, currency)} each` : ""}`}
        </span>
        {" \u00b7 "}
        <button type="button" className={link} onClick={onOpen}>Change</button>
        {" \u00b7 "}
        <button type="button" className={link} aria-busy={busy} disabled={busy} onClick={() => onSend({ plan: null }, "Payment plan stopped.")}>Stop offering it</button>
      </p>
    );
  }
  return (
    <button type="button" className={`block ${link}`} onClick={onOpen}>
      Offer a payment plan
    </button>
  );
}
