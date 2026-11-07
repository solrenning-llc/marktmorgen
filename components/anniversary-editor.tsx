"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_ANNIVERSARY_ADDRESS, MAX_ANNIVERSARY_MESSAGE, MAX_ANNIVERSARY_PRODUCTS, anniversaryEmail, parseAnniversary, type Anniversary } from "@/lib/anniversary-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
  products: "Choose at least one product, or choose every product. If you deleted a product a moment ago, reload this page and choose again.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm whether your anniversary email settings were saved. Reload this page to check before trying again.",
};

/** The same list, in the same order: what the server saved is what was asked for. */
const sameChoice = (a: unknown, b: Anniversary["products"]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The email on the anniversary of a purchase (lib/anniversary-rules.ts, lib/anniversary-send.ts; 283 [HG2]).
 * `choices` are the products a buyer pays for once, in the store's order, or null when they could not be read.
 */
export function AnniversaryEditor({
  setting,
  storeName,
  suggestedAddress,
  sent,
  choices,
  connected,
}: {
  setting: Anniversary;
  storeName: string;
  suggestedAddress: string;
  sent: number;
  choices: { id: string; title: string }[] | null;
  connected: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(setting.on);
  const [message, setMessage] = useState(setting.message);
  const [address, setAddress] = useState(setting.address || suggestedAddress);
  // A saved choice that could not be read is never shown as "every product": the creator chooses again.
  const [which, setWhich] = useState<"all" | "some">(setting.products === "all" ? "all" : "some");
  const [picked, setPicked] = useState<string[]>(Array.isArray(setting.products) ? setting.products : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    // In the store's order, and only products still offered here; read again from the saved list when the products could not be read.
    const products = which === "all" ? "all" : choices ? choices.map((p) => p.id).filter((id) => picked.includes(id)) : picked;
    if (on && products !== "all" && products.length === 0) {
      setError(MESSAGES.products);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/anniversary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, message, address, products }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const expected = parseAnniversary({ on, message, address, products });
      const saved = data.anniversary && typeof data.anniversary === "object" && !Array.isArray(data.anniversary) ? (data.anniversary as Record<string, unknown>) : {};
      if (
        response.ok &&
        data.ok === true &&
        data.error === undefined &&
        saved.on === expected.on &&
        saved.message === expected.message &&
        saved.address === expected.address &&
        sameChoice(saved.products, expected.products)
      ) {
        toast("Anniversary email settings saved.");
        router.refresh();
        return;
      }
      const reason = typeof data.error === "string" ? data.error : "";
      setError(!response.ok && data.ok === false && Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const bullets = [
    "A year after somebody buys a product from your store, they get one email from you that says when they bought it and what, with your few words below and a link to your store.",
    "It is sent for every product you sell for a one-time price, or only for the products you choose below.",
    "Only to buyers who checked the box to hear from you when they paid, and who are still on your list. Never to somebody who left your list, whose email bounced, or whose purchase was refunded or disputed.",
    "At most once per person for each date. Each email counts toward your store's emails for the month, and none is sent when they are used up.",
    "It carries the reason they get it, a one-click way off your list and your postal address. We never ask a buyer for a birth date: the only date used is the day they bought.",
  ];
  // What a buyer reads, with this store's name and the words typed now (an example product and date).
  const example = anniversaryEmail({ storeName: storeName || "Your store", title: "Your product", boughtOn: "November 6, 2025", message, link: "Your store's link" });

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="anniversary-title" data-anniversary-editor aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="anniversary-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Email buyers a year after they buy
        </h2>
        <span className={`tag ${setting.on ? "tag-live" : ""}`}>{setting.on ? "On" : "Off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {!connected ? (
        <p className="notice mt-3" role="note">
          Connect your Stripe account first. The date of each purchase is read from your sales there.
        </p>
      ) : null}
      {setting.on ? <p className="mt-3 text-sm text-ink">{`Sent this month: ${sent}`}</p> : null}
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="anniversary-on">
          <input id="anniversary-on" disabled={busy} type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Email buyers a year after they buy</span>
        </label>
        <fieldset className="space-y-1" aria-describedby="anniversary-which-help">
          <legend className="field-label">Which purchases get this email</legend>
          <span id="anniversary-which-help" className="block text-sm text-ink-soft">
            Memberships and calls never get it.
          </span>
          {setting.products === "unknown" ? (
            <p className="notice" role="note">
              We could not read which products you chose before. Choose them again, then save. Until you do, no anniversary email is sent.
            </p>
          ) : null}
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor="anniversary-which-all">
            <input id="anniversary-which-all" type="radio" name="anniversary-which" className="h-5 w-5" disabled={busy} checked={which === "all"} onChange={() => setWhich("all")} />
            <span>Every product</span>
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor="anniversary-which-some">
            <input id="anniversary-which-some" type="radio" name="anniversary-which" className="h-5 w-5" disabled={busy} checked={which === "some"} onChange={() => setWhich("some")} />
            <span>Only the products I choose</span>
          </label>
        </fieldset>
        {which === "some" ? (
          <fieldset className="space-y-1 rounded-xl border border-line p-4" aria-describedby="anniversary-products-help">
            <legend className="field-label px-1">Products that get this email</legend>
            <span id="anniversary-products-help" className="block text-sm text-ink-soft">
              {`Choose at least one, up to ${MAX_ANNIVERSARY_PRODUCTS}. If you delete a product from your store, it is taken off this list by itself.`}
            </span>
            {choices === null ? (
              <p className="notice" role="note">
                We could not load your products. Reload this page to choose them.
              </p>
            ) : choices.length === 0 ? (
              <p className="text-sm text-ink">Your store has no product with a one-time price yet.</p>
            ) : (
              choices.map((product) => (
                <label key={product.id} className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor={`anniversary-product-${product.id}`}>
                  <input
                    id={`anniversary-product-${product.id}`}
                    type="checkbox"
                    className="h-5 w-5"
                    disabled={busy || (!picked.includes(product.id) && picked.length >= MAX_ANNIVERSARY_PRODUCTS)}
                    checked={picked.includes(product.id)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPicked((now) => (checked ? [...now.filter((id) => id !== product.id), product.id] : now.filter((id) => id !== product.id)));
                    }}
                  />
                  <span>{product.title}</span>
                </label>
              ))
            )}
            {choices && choices.length > 0 ? <p className="text-sm text-ink-soft" aria-live="polite">{`Chosen: ${choices.filter((p) => picked.includes(p.id)).length}`}</p> : null}
          </fieldset>
        ) : null}
        <label className="block" htmlFor="anniversary-message">
          <span className="field-label">Your words, below the date (optional)</span>
          <span id="anniversary-message-help" className="mt-1 block text-sm text-ink-soft">
            {`For example: "The second edition is out, with two new chapters." Up to ${MAX_ANNIVERSARY_MESSAGE} characters. Shown exactly as you write it.`}
          </span>
          <textarea
            id="anniversary-message"
            aria-describedby="anniversary-message-help"
            disabled={busy}
            className="field mt-2"
            rows={4}
            maxLength={MAX_ANNIVERSARY_MESSAGE}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <label className="block" htmlFor="anniversary-address">
          <span className="field-label">Your postal address, printed at the bottom</span>
          <input id="anniversary-address" disabled={busy} className="field mt-2" maxLength={MAX_ANNIVERSARY_ADDRESS} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <div className="rounded-xl border border-line p-4" aria-labelledby="anniversary-example-title" role="group">
          <h3 id="anniversary-example-title" className="text-sm font-semibold text-ink">
            Example of what a buyer reads
          </h3>
          <p className="mt-2 text-sm text-ink">{`Subject: ${example.subject}`}</p>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{example.body}</p>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
