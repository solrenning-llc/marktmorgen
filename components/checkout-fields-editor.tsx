"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import {
  type CheckoutField,
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  type FieldType,
  MAX_CHECKOUT_FIELDS,
  MAX_DROPDOWN_OPTIONS,
  MAX_DROPDOWN_OPTION_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MIN_DROPDOWN_OPTIONS,
} from "@/lib/checkout-fields";

type Row = { label: string; type: FieldType; optional: boolean; options: string };

const toRow = (field: CheckoutField): Row => ({
  label: field.label,
  type: field.type,
  optional: field.optional,
  options: field.options.join("\n"),
});

const BLANK: Row = { label: "", type: "text", optional: false, options: "" };

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

function problemText(reason: string, at: number | undefined): string {
  const which = at === undefined ? "" : `Question ${at + 1}: `;
  const text: Record<string, string> = {
    label: "give it a label the buyer will read.",
    label_long: `keep the label to ${MAX_FIELD_LABEL_LENGTH} characters, which is what Stripe shows.`,
    type: "pick what kind of answer it takes.",
    options_few: `a list needs at least ${MIN_DROPDOWN_OPTIONS} choices, one per line.`,
    options_many: `Stripe allows up to ${MAX_DROPDOWN_OPTIONS} choices in a list.`,
    option_long: `each choice can be up to ${MAX_DROPDOWN_OPTION_LENGTH} characters.`,
    options_same: "two choices say the same thing. Make each one different.",
    phone_twice: "the phone number is already asked for once. Remove this one.",
    too_many: `Stripe's checkout asks up to ${MAX_CHECKOUT_FIELDS} questions.`,
    free: "something free never reaches the checkout, so it cannot ask questions.",
    store_full: "your store has reached the most it can hold. Shorten a long list of choices, or remove something.",
    signed_out: "your session ended. Log in again.",
    unknown: "that product is no longer in your store. Reload the page.",
    role: "your role on this store does not include this. The store's owner can change your role.",
    store_gone: "this store was deleted, or you are no longer on its team. Reload the page to see your stores.",
  };
  const said = text[reason] ?? "something went wrong on our side. Try again in a moment.";
  return which ? `${which}${said}` : said.charAt(0).toUpperCase() + said.slice(1);
}

/** The questions a product asks on Stripe's checkout, in the studio. */
export function CheckoutFieldsEditor({ product }: { product: Product }) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => product.fields.map(toRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = "text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";

  // Something free is given for an email address and never meets a checkout.
  if (product.priceCents === 0) return null;

  async function save(next: Row[], confirmation: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, fields: next }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; at?: number };
      if (response.ok && data.ok === true) {
        setOpen(false);
        toast(confirmation);
        router.refresh();
        return;
      }
      setError(problemText(data.error ?? "", data.at));
    } catch {
      setError(problemText("", undefined));
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, change: Partial<Row>) =>
    setRows((current) => current.map((row, j) => (j === i ? { ...row, ...change } : row)));

  if (!open) {
    return (
      <div className="text-sm text-ink-soft">
        {product.fields.length > 0 ? (
          <p>
            <span className="font-semibold text-ink">
              {`Asks at checkout: ${product.fields.map((field) => `“${field.label}”`).join(", ")}`}
            </span>
            {" · "}
            <button
              type="button"
              className={link}
              aria-disabled={ready ? undefined : true}
              disabled={!ready}
              onClick={() => {
                if (!ready) return;
                setRows(product.fields.map(toRow));
                setOpen(true);
              }}
            >
              {ready ? "Change" : "Change — Loading…"}
            </button>
          </p>
        ) : (
          <button
            type="button"
            className={`block ${link}`}
            aria-disabled={ready ? undefined : true}
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              setRows([{ ...BLANK }]);
              setOpen(true);
            }}
          >
            {ready ? "Ask the buyer something at checkout" : "Ask the buyer something at checkout — Loading…"}
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      noValidate
      className="rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) save(rows, rows.length ? "Checkout questions saved." : "Checkout questions removed.");
      }}
    >
      <p className="text-sm font-bold text-ink">Questions at checkout</p>
      <p className="mt-1 text-xs text-ink-soft">
        {`Asked on Stripe's payment page, before the buyer pays. Up to ${MAX_CHECKOUT_FIELDS}. The answers are shown on each sale under What you have sold, and in your Stripe dashboard.`}
      </p>

      <ol className="mt-3 space-y-3">
        {rows.map((row, i) => {
          const id = `q-${product.id}-${i}`;
          return (
            <li key={i} className="rounded-xl border border-line bg-paper p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                {row.type === "phone" ? (
                  <div>
                    <p className="field-label">{`Question ${i + 1}`}</p>
                    <p className="mt-1 text-sm text-ink">
                      Stripe&apos;s own phone box, in the buyer&apos;s language: they pick their country and type the number, and Stripe checks it is a
                      real one. It is always required. The number is shown on the sale, and for a call in your booking email.
                    </p>
                  </div>
                ) : (
                <label className="block" htmlFor={`${id}-l`}>
                  <span className="field-label">{`Question ${i + 1}`}</span>
                  <input
                    id={`${id}-l`}
                    type="text"
                    maxLength={MAX_FIELD_LABEL_LENGTH}
                    value={row.label}
                    placeholder={row.type === "dropdown" ? "Your size" : row.type === "numeric" ? "How many people will join" : "Name to print on it"}
                    onChange={(event) => update(i, { label: event.target.value })}
                    className="field mt-1"
                  />
                  <span className="mt-1 block text-xs text-ink-soft">
                    {`${MAX_FIELD_LABEL_LENGTH - row.label.length} characters left`}
                  </span>
                </label>
                )}
                <label className="block" htmlFor={`${id}-t`}>
                  <span className="field-label">Answer</span>
                  <select
                    id={`${id}-t`}
                    value={row.type}
                    onChange={(event) => update(i, { type: event.target.value as FieldType })}
                    className="field mt-1"
                  >
                    {FIELD_TYPES.filter((type) => type !== "phone" || row.type === "phone" || !rows.some((other) => other.type === "phone")).map((type) => (
                      <option key={type} value={type}>
                        {FIELD_TYPE_NAMES[type]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {row.type === "dropdown" ? (
                <label className="mt-3 block" htmlFor={`${id}-o`}>
                  <span className="field-label">Choices, one per line</span>
                  <textarea
                    id={`${id}-o`}
                    rows={4}
                    value={row.options}
                    placeholder={"Small\nMedium\nLarge"}
                    onChange={(event) => update(i, { options: event.target.value })}
                    className="field mt-1"
                  />
                  <span className="mt-1 block text-xs text-ink-soft">
                    {`${row.options.split(/\n/).filter((line) => line.trim()).length} of up to ${MAX_DROPDOWN_OPTIONS}`}
                  </span>
                </label>
              ) : row.type === "phone" ? null : (
                <p className="mt-2 text-xs text-ink-soft">
                  {row.type === "numeric" ? "Digits only, up to 255 of them." : "Up to 255 characters."}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                {row.type === "phone" ? (
                  <span className="text-sm text-ink-soft">Always required by Stripe</span>
                ) : (
                <label htmlFor={`${id}-r`} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    id={`${id}-r`}
                    type="checkbox"
                    checked={!row.optional}
                    onChange={(event) => update(i, { optional: !event.target.checked })}
                    className="h-4 w-4 accent-[var(--violet)]"
                  />
                  Required before paying
                </label>
                )}
                <button
                  type="button"
                  className="text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-danger"
                  onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
                >
                  Remove this question
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {rows.length < MAX_CHECKOUT_FIELDS ? (
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setRows((current) => [...current, { ...BLANK }])}>
          {rows.length === 0 ? "Add a question" : "Add another question"}
        </button>
      ) : null}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Saving…" : "Save the questions"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
