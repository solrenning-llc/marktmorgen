"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { StoreCurrency, useStoreCurrency } from "@/components/store-currency";
import { type Currency, currencyRule, fieldPrefix, formatMoney, moneyField, readMoney } from "@/lib/money";
import {
  type Funnel,
  MAX_FUNNEL_STEPS,
  MAX_HEADLINE_LENGTH,
  MAX_STEP_TEXT_LENGTH,
} from "@/lib/funnel";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { useLeaveGuard } from "@/components/leave-guard";
import { commonPath, commonPathWords } from "@/lib/funnel-starter";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  target: "Pick a product for every offer: another product of yours with one price, no limit on how many can be sold, and a file, a link or a bundle behind it.",
  repeat: "An offer that follows a yes cannot offer the same product again: the buyer already has it.",
  shape: `Keep between 1 and ${MAX_FUNNEL_STEPS} offers, each leading only to an offer further down the list.`,
  kind: "Offers follow one-off paid products only.",
  unknown: "That product is no longer in your store. Reload the page.",
  store_full: "Your store is full. Remove something before adding more.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Offerable = { id: string; title: string; priceCents: number; bundle?: boolean; draft?: boolean };
type Picture = { id: string; title: string; src: string };

type Draft = {
  id: string;
  productId: string;
  price: string;
  headline: string;
  text: string;
  imageFrom: string;
  yes: string;
  no: string;
};

/** The price sentence, in the store's currency: its smallest charge is its own (lib/money.ts). */
const priceMessage = (currency: Currency) =>
  `Each offer needs a price of at least ${formatMoney(currencyRule(currency).minCharge, currency)}, and no more than that product costs on its own.`;

/** A typed price as the page will write it, or as typed while it is not one yet. */
const typedPrice = (price: string, currency: Currency) => {
  const amount = readMoney(price, currency);
  return amount === null ? `${fieldPrefix(currency)} ${price || "\u2026"}` : formatMoney(amount, currency);
};

function newId(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += letters[b % letters.length];
  return out;
}

function toDrafts(funnel: Funnel | null, currency: Currency): Draft[] {
  return (funnel?.steps ?? []).map((s) => ({
    id: s.id,
    productId: s.productId,
    price: moneyField(s.priceCents, currency),
    headline: s.headline,
    text: s.text,
    imageFrom: s.imageFrom ?? "",
    yes: s.yes ?? "",
    no: s.no ?? "",
  }));
}

/** Offers nothing leads to, as the drafts stand. */
function unreached(steps: Draft[]): Set<string> {
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (!id || seen.has(id)) return;
    const step = steps.find((s) => s.id === id);
    if (!step) return;
    seen.add(id);
    walk(step.yes);
    walk(step.no);
  };
  walk(steps[0]?.id ?? "");
  return new Set(steps.filter((s) => !seen.has(s.id)).map((s) => s.id));
}

/**
 * The studio's funnel editor for one product: a map of where each answer
 * leads, and the offers themselves, in order. An answer can only lead to an
 * offer further down, so what the map shows is always what a buyer can meet.
 */
export function FunnelEditor({
  owner,
  initial,
  offerable,
  pictures,
  ownerPrice,
  currency = "usd",
}: {
  owner: { id: string; title: string; priceCents: number };
  initial: Funnel | null;
  offerable: Offerable[];
  pictures: Picture[];
  ownerPrice: string;
  /** What the store charges in; every price here is typed in it. */
  currency?: Currency;
}) {
  const router = useRouter();
  const [steps, setSteps] = useState<Draft[]>(() => toDrafts(initial, currency));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const saved = JSON.stringify(toDrafts(initial, currency));
  const dirty = JSON.stringify(steps) !== saved;
  useLeaveGuard(dirty && !busy);
  const lost = useMemo(() => unreached(steps), [steps]);

  const product = (id: string) => offerable.find((p) => p.id === id) ?? null;
  const numberOf = (id: string) => steps.findIndex((s) => s.id === id) + 1;

  function change(index: number, patch: Partial<Draft>) {
    setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function add() {
    if (steps.length >= MAX_FUNNEL_STEPS || offerable.length === 0) return;
    const used = new Set(steps.map((s) => s.productId));
    const pick = offerable.find((p) => !used.has(p.id)) ?? offerable[0];
    const id = newId();
    setSteps((all) => [
      ...all,
      { id, productId: pick.id, price: moneyField(pick.priceCents, currency), headline: "", text: "", imageFrom: "", yes: "", no: "" },
    ]);
  }

  // A ready path (487 [IT4], item 5): an offer and, after "no thanks", one that costs less, from the creator's own products.
  const starter = steps.length === 0 ? commonPath(offerable) : null;
  function startCommon() {
    if (!starter || steps.length) return;
    const first = newId();
    const second = newId();
    setSteps([
      { id: first, productId: starter.first.id, price: moneyField(starter.first.priceCents, currency), headline: "", text: "", imageFrom: "", yes: "", no: second },
      { id: second, productId: starter.second.id, price: moneyField(starter.second.priceCents, currency), headline: "", text: "", imageFrom: "", yes: "", no: "" },
    ]);
    toast("Two offers added. Not saved yet.");
    // The button goes once there are offers: the focus moves to the first offer's product.
    requestAnimationFrame(() => document.getElementById(`step-${first}-p`)?.focus());
  }

  function remove(index: number) {
    setSteps((all) => {
      const gone = all[index].id;
      return all
        .filter((_, i) => i !== index)
        .map((s) => ({ ...s, yes: s.yes === gone ? "" : s.yes, no: s.no === gone ? "" : s.no }));
    });
  }

  async function send(funnel: unknown, confirmation: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/funnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: owner.id, funnel }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        toast(confirmation);
        setConfirmRemove(false);
        router.refresh();
        return;
      }
      setError(data.error === "price" ? priceMessage(currency) : MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (steps.length === 0) {
      send(null, "Funnel removed.");
      return;
    }
    send(
      {
        steps: steps.map((s) => ({
          id: s.id,
          productId: s.productId,
          price: s.price.trim(),
          headline: s.headline,
          text: s.text,
          imageFrom: s.imageFrom || null,
          yes: s.yes || null,
          no: s.no || null,
        })),
      },
      "Funnel saved.",
    );
  }

  return (
    <StoreCurrency value={currency}>
    <section aria-labelledby="funnel-title" className="card min-w-0 p-5 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="funnel-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            {`After someone buys ${owner.title}`}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {initial
              ? `${initial.steps.length === 1 ? "One offer" : `${initial.steps.length} offers`} saved. Buyers meet them on the thank-you page, one at a time.`
              : "No offers yet: buyers see their thank-you page and nothing else."}
          </p>
        </div>
        <span className={`tag ${initial ? "tag-live" : ""}`}>{initial ? "On" : "Off"}</span>
      </div>

      {/* The map: where each answer leads, as a buyer walks it. */}
      <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">The path</p>
        <div className="mt-3 flex items-center gap-2 text-sm">
          {/* A badge, not a button: the 44px floor is for things a thumb presses. */}
          <span className="inline-flex min-h-8 items-center gap-2 rounded-full bg-white px-3 font-semibold text-ink ring-1 ring-line">
            <Icon name="card" size={16} />
            <span className="max-w-[12rem] truncate">{owner.title}</span>
            <span className="text-ink-mute">{ownerPrice}</span>
          </span>
          <span className="text-ink-mute">paid</span>
        </div>
        {steps.length ? (
          <FlowNode steps={steps} id={steps[0].id} product={product} numberOf={numberOf} depth={0} />
        ) : (
          <p className="mt-3 text-sm text-ink-soft">Add an offer below and its path appears here.</p>
        )}
      </div>

      {offerable.length === 0 ? (
        <p className="notice notice-warn mt-6 text-sm">
          To offer something, add another product with one price and a file, a link or a bundle behind it.
        </p>
      ) : null}

      <ol className="mt-6 space-y-4">
        {steps.map((step, index) => {
          const chosen = product(step.productId);
          const cents = readMoney(step.price, currency);
          const tooHigh = chosen !== null && cents !== null && cents > chosen.priceCents;
          const later = steps.slice(index + 1);
          const base = `step-${step.id}`;
          return (
            <li key={step.id} className="rounded-2xl border border-line bg-white p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2.5 font-semibold text-ink">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-violet-brand text-[0.8125rem] text-white">
                    {index + 1}
                  </span>
                  {`Offer ${index + 1}`}
                  {lost.has(step.id) ? (
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-bold text-ink">Nothing leads here yet</span>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remove offer ${index + 1}`}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <label className="block" htmlFor={`${base}-p`}>
                  <span className="field-label">Offer this</span>
                  <select
                    id={`${base}-p`}
                    value={step.productId}
                    onChange={(e) => {
                      const next = product(e.target.value);
                      change(index, { productId: e.target.value, ...(next ? { price: moneyField(next.priceCents, currency) } : {}) });
                    }}
                    className="field"
                  >
                    {chosen ? null : <option value={step.productId}>A product that is no longer offerable</option>}
                    {offerable.map((p) => (
                      <option key={p.id} value={p.id}>{`${p.title} (${formatMoney(p.priceCents, currency)})`}</option>
                    ))}
                  </select>
                </label>
                <label className="block" htmlFor={`${base}-c`}>
                  <span className="field-label">{currency === "usd" ? "For, in dollars" : `For, ${fieldPrefix(currency)}`}</span>
                  <input
                    id={`${base}-c`}
                    type="text"
                    inputMode="decimal"
                    value={step.price}
                    onChange={(e) => change(index, { price: e.target.value })}
                    className="field"
                    aria-describedby={tooHigh ? `${base}-ch` : undefined}
                    required
                  />
                </label>
                {tooHigh && chosen ? (
                  <p id={`${base}-ch`} className="text-sm font-semibold text-danger sm:col-span-2">
                    {`No more than ${formatMoney(chosen.priceCents, currency)}, what it costs on its own.`}
                  </p>
                ) : null}
                <label className="block sm:col-span-2" htmlFor={`${base}-h`}>
                  <span className="field-label">Headline (optional)</span>
                  <input
                    id={`${base}-h`}
                    type="text"
                    maxLength={MAX_HEADLINE_LENGTH}
                    value={step.headline}
                    placeholder={chosen ? `${chosen.title} for ${typedPrice(step.price, currency)}` : ""}
                    onChange={(e) => change(index, { headline: e.target.value })}
                    className="field"
                  />
                </label>
                <label className="block sm:col-span-2" htmlFor={`${base}-t`}>
                  <span className="field-label">A few words (optional)</span>
                  <textarea
                    id={`${base}-t`}
                    rows={3}
                    maxLength={MAX_STEP_TEXT_LENGTH}
                    value={step.text}
                    placeholder="What it adds to what they just bought, in a sentence or two."
                    onChange={(e) => change(index, { text: e.target.value })}
                    className="field"
                  />
                </label>
                <div className="sm:col-span-2">
                  <label className="block" htmlFor={`${base}-i`}>
                    <span className="field-label">Picture</span>
                    <div className="flex items-center gap-3">
                      <select
                        id={`${base}-i`}
                        value={step.imageFrom}
                        onChange={(e) => change(index, { imageFrom: e.target.value })}
                        className="field"
                      >
                        <option value="">No picture</option>
                        {pictures.map((p) => (
                          <option key={p.id} value={p.id}>{`The picture of ${p.title}`}</option>
                        ))}
                      </select>
                      {step.imageFrom && pictures.find((p) => p.id === step.imageFrom) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={pictures.find((p) => p.id === step.imageFrom)!.src}
                          alt=""
                          width={64}
                          height={40}
                          className="h-10 w-16 shrink-0 rounded-[8px] object-cover ring-1 ring-line"
                        />
                      ) : null}
                    </div>
                  </label>
                  {pictures.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-soft">Give a product a picture and it can be used here.</p>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                <Branch
                  id={`${base}-y`}
                  kind="yes"
                  value={step.yes}
                  later={later}
                  numberOf={numberOf}
                  onChange={(value) => change(index, { yes: value })}
                />
                <Branch
                  id={`${base}-n`}
                  kind="no"
                  value={step.no}
                  later={later}
                  numberOf={numberOf}
                  onChange={(value) => change(index, { no: value })}
                />
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4">
        {steps.length < MAX_FUNNEL_STEPS ? (
          <button
            type="button"
            onClick={add}
            disabled={offerable.length === 0}
            className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong text-sm font-bold text-ink-soft transition-colors hover:border-violet-brand hover:text-violet-deep disabled:opacity-50"
          >
            <Icon name="plus" size={18} />
            {steps.length === 0 ? "Add the first offer" : `Add an offer (${steps.length} of ${MAX_FUNNEL_STEPS})`}
          </button>
        ) : (
          <p className="text-center text-sm text-ink-soft">{`${MAX_FUNNEL_STEPS} offers is the most one product can have.`}</p>
        )}
      </div>

      {starter ? (
        <div className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5" data-funnel-starter="">
          <h3 id="funnel-starter-title" className="font-semibold text-ink">Or start from a common path</h3>
          <p id="funnel-starter-words" className="mt-1 text-sm text-ink-soft">{commonPathWords(starter, (cents) => formatMoney(cents, currency))}</p>
          <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={startCommon} aria-describedby="funnel-starter-words">
            Use this path
          </button>
        </div>
      ) : null}

      <p className="mt-5 text-xs leading-relaxed text-ink-soft">
        Only the browser that paid sees these offers, for one hour after paying, and each is answered once. An offer of
        something the buyer already has in this order is skipped as if they said no. Nothing more is offered after a card
        turns one down, while your store charges sales tax, or when the buyer chose a payment plan. Each offer is its own
        charge on your Stripe account and is delivered on the same thank-you page.
      </p>

      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} aria-busy={busy} disabled={busy || !dirty} className="btn btn-primary">
          {busy ? "Saving…" : "Save the funnel"}
        </button>
        {dirty ? (
          <button type="button" className="btn btn-ghost" onClick={() => { setSteps(toDrafts(initial, currency)); setError(null); }}>
            Undo changes
          </button>
        ) : null}
        {initial && !dirty ? (
          confirmRemove ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              {`Remove ${initial.steps.length === 1 ? "the offer" : `all ${initial.steps.length} offers`}?`}
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => send(null, "Funnel removed.")}>
                Yes, remove
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(true)}>
              Remove the funnel
            </button>
          )
        ) : null}
      </div>
    </section>
    </StoreCurrency>
  );
}

function Branch({
  id,
  kind,
  value,
  later,
  numberOf,
  onChange,
}: {
  id: string;
  kind: "yes" | "no";
  value: string;
  later: Draft[];
  numberOf: (id: string) => number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="field-label flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
            kind === "yes" ? "bg-mint-soft text-mint-deep" : "bg-sand text-ink-soft"
          }`}
        >
          {kind === "yes" ? "Yes" : "No thanks"}
          <Icon name="arrow-right" size={12} />
        </span>
        then show
      </span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="field">
        <option value="">Nothing more: the thank-you page</option>
        {later.map((s) => (
          <option key={s.id} value={s.id}>{`Offer ${numberOf(s.id)}`}</option>
        ))}
      </select>
    </label>
  );
}

function FlowNode({
  steps,
  id,
  product,
  numberOf,
  depth,
}: {
  steps: Draft[];
  id: string;
  product: (id: string) => Offerable | null;
  numberOf: (id: string) => number;
  depth: number;
}) {
  const currency = useStoreCurrency();
  const step = steps.find((s) => s.id === id);
  if (!step || depth > MAX_FUNNEL_STEPS) return null;
  const chosen = product(step.productId);
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Icon name="arrow-right" size={14} className="shrink-0 rotate-90 text-ink-mute" />
        <div className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm shadow-[var(--shadow-xs)] ring-1 ring-violet-brand/30">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-brand text-[0.75rem] font-semibold text-white">
            {numberOf(step.id)}
          </span>
          <span className="min-w-0 truncate font-semibold text-ink">{chosen?.title ?? "A product that is no longer offerable"}</span>
          <span className="shrink-0 text-ink-soft">{typedPrice(step.price, currency)}</span>
        </div>
      </div>
      <div className="ml-3 mt-1 space-y-1 border-l-2 border-line pl-3 sm:ml-4 sm:pl-4">
        {(["yes", "no"] as const).map((kind) => {
          const next = step[kind];
          return (
            <div key={kind}>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold ${
                    kind === "yes" ? "bg-mint-soft text-mint-deep" : "bg-sand text-ink-soft"
                  }`}
                >
                  {kind === "yes" ? "Yes" : "No thanks"}
                </span>
                {next ? null : <span className="text-ink-mute">then the thank-you page</span>}
              </p>
              {next ? <FlowNode steps={steps} id={next} product={product} numberOf={numberOf} depth={depth + 1} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
