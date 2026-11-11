"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { fieldPrefix, formatMoney, moneyField, readMoney } from "@/lib/money";
import { useStoreCurrency } from "@/components/store-currency";
import { MAX_SHIP_NOTE, MAX_SHIPPING_SKU, SHIP_REGIONS, type ShipRegion, readCountries, shipProblem, parseShipping } from "@/lib/shipping";

import { confirmsShipping } from "@/lib/shipping-confirmation";

const UNKNOWN_SAVE = "Shipping was not confirmed. Reload to check its status before trying again.";

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const MESSAGES: Record<string, string> = {
  ship_sku: "Use up to 64 characters for the inventory reference, without line breaks or control characters.",
  ship_price: "Type a shipping cost of 0 for free shipping, or at least the least your currency can charge.",
  ship_countries: "Pick where it ships, or type the two-letter codes of the countries, like US, CA, GB.",
  ship_free: "A product you ship needs a price.",
  ship_membership: "A product you ship is sold once, not as a membership.",
  ship_call: "A call delivers a time, so it cannot be shipped.",
  ship_options: "A product you ship has one price. Take its options off first.",
  ship_pwyw: "A product you ship has a set price, so buyers cannot choose it.",
  ship_plan: "A product you ship is paid in full. Stop its payment plan first.",
  ship_delivery: "This product already hands over a file, a link, a course, a podcast or a bundle. Take that off first, or make a new product to ship.",
  store_full: "Your store is full. Remove something before adding more.",
  signed_out: "Your session ended. Log in again.",
};

const REGIONS: { id: ShipRegion; label: string }[] = [
  ...(Object.entries(SHIP_REGIONS) as [Exclude<ShipRegion, "custom">, { label: string }][]).map(([id, r]) => ({ id, label: r.label })),
  { id: "custom", label: "Only the countries I list" },
];

/**
 * A physical product the creator ships (lib/shipping.ts): what shipping
 * costs, where it goes and when it ships. Offered on a product that hands
 * over nothing else yet, sold once at one price.
 */
export function ShippingEditor({ product }: { product: Product }) {
  const router = useRouter();
  const currency = useStoreCurrency();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const current = product.shipping ?? null;
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(current ? (current.cents ? moneyField(current.cents, currency) : "0") : "");
  const [region, setRegion] = useState<ShipRegion>(current?.region ?? "us");
  const [codes, setCodes] = useState(current?.region === "custom" ? current.countries.join(", ") : "");
  const [sku, setSku] = useState(current?.sku ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!current && shipProblem(product) !== null) return null;
  const link = "inline-flex min-h-11 items-center text-left text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";
  // The opener stands on a line of its own: the same look, as a full-width row.
  const opener = "flex min-h-11 items-center text-left text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";
  const id = `ship-${product.id}`;

  async function send(shipping: Record<string, unknown> | null, said: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, shipping }),
      });
      const data: unknown = await response.json().catch(() => null);
      const expected = shipping === null ? null : parseShipping({ ...shipping, cents: readMoney(String(shipping.price), currency) });
      if ((shipping === null || expected !== null) && confirmsShipping(data, response.ok, product.id, expected)) {
        setOpen(false);
        toast(said);
        router.refresh();
        return;
      }
      const refusal = data && typeof data === "object" && Object.hasOwn(data, "ok") && (data as {ok?:unknown}).ok === false && Object.hasOwn(data,"error") ? (data as {error?:unknown}).error : null;
      setError(typeof refusal === "string" && Object.hasOwn(MESSAGES,refusal) ? MESSAGES[refusal] : UNKNOWN_SAVE);
    } catch {
      setError(UNKNOWN_SAVE);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-3 text-sm text-ink-soft">
        {current ? (
          <p>
            <span className="font-semibold text-ink">
              {`Shipped by you: ${current.cents ? `${formatMoney(current.cents, currency)} shipping` : "free shipping"} · ${current.region === "custom" ? current.countries.join(", ") : SHIP_REGIONS[current.region].label}`}
            </span>
            {current.sku ? <span className="ml-2 break-all">{`SKU: ${current.sku}`}</span> : null}
            {" · "}
            <button
              type="button"
              className={link}
              aria-disabled={ready ? undefined : true}
              disabled={!ready || busy}
              onClick={() => {
                if (!ready) return;
                setOpen(true);
              }}
            >
              {ready ? "Change" : "Change — Loading…"}
            </button>
            {" · "}
            <button
              type="button"
              className={link}
              aria-busy={busy}
              aria-disabled={ready ? undefined : true}
              disabled={!ready || busy}
              onClick={() => {
                if (!ready) return;
                send(null, "It is no longer shipped.");
              }}
            >
              {ready ? "Stop shipping it" : "Stop shipping it — Loading…"}
            </button>
          </p>
        ) : (
          <button
            type="button"
            className={opener}
            aria-disabled={ready ? undefined : true}
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              setOpen(true);
            }}
          >
            {ready ? "Ship it: a physical product, sent by you" : "Ship it: a physical product, sent by you — Loading…"}
          </button>
        )}
        {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <form
      aria-busy={busy}
      className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        send({ price: price.trim(), region, countries: region === "custom" ? readCountries(codes) : [], note: note.trim(), sku }, "Shipping saved.");
      }}
    >
      <fieldset disabled={busy}>
      <legend className="text-sm font-bold text-ink">Shipping</legend>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block" htmlFor={`${id}-p`}>
          <span className="field-label">{currency === "usd" ? "Shipping cost per order, in dollars" : `Shipping cost per order, ${fieldPrefix(currency)}`}</span>
          <input id={`${id}-p`} type="text" inputMode="decimal" className="field mt-1" value={price} placeholder="0 for free shipping" onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="block" htmlFor={`${id}-r`}>
          <span className="field-label">Ships to</span>
          <select id={`${id}-r`} className="field mt-1" value={region} onChange={(e) => setRegion(e.target.value as ShipRegion)}>
            {REGIONS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </label>
      </div>
      {region === "custom" ? (
        <label className="mt-3 block" htmlFor={`${id}-c`}>
          <span className="field-label">Countries, by their two-letter codes</span>
          <input id={`${id}-c`} type="text" className="field mt-1" value={codes} placeholder="US, CA, GB, AU" onChange={(e) => setCodes(e.target.value)} />
          <span className="mt-1 block text-xs text-ink-soft">{`${readCountries(codes).length} recognized`}</span>
        </label>
      ) : null}
      <label className="mt-3 block" htmlFor={`${id}-sku`}>
        <span className="field-label">Inventory reference (SKU, optional)</span>
        <input id={`${id}-sku`} type="text" maxLength={MAX_SHIPPING_SKU} className="field mt-1" value={sku} onChange={(event) => setSku(event.target.value)} aria-describedby={`${id}-sku-help`} />
        <span id={`${id}-sku-help`} className="mt-1 block text-xs text-ink-soft">Your code for this physical product. Its product and price IDs stay the same.</span>
      </label>
      <label className="mt-3 block" htmlFor={`${id}-n`}>
        <span className="field-label">When it ships (optional)</span>
        <input id={`${id}-n`} type="text" maxLength={MAX_SHIP_NOTE} className="field mt-1" value={note} placeholder="Ships within 3 business days" onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="mt-2 text-xs text-ink-soft">
        Stripe asks the buyer for an address in a country it ships to and adds the shipping before they pay. You send it yourself: the
        address is on the sale under What you have sold, where &ldquo;Mark as shipped&rdquo; emails the buyer, with a tracking link if you have one.
        Sold once: at one price, or at several for sizes or versions, added under Prices. No gifts or carts.
      </p>
      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">{busy ? "Saving…" : "Save shipping"}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
      </fieldset>
    </form>
  );
}
