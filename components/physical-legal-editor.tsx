"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { SHIP_COUNTRIES } from "@/lib/shipping";
import { GPSR_AREA, MAX_ELECTRONIC, MAX_IDENTIFIER, MAX_NAME, MAX_POSTAL, MAX_PROP65, MAX_TYPE, MAX_WARNINGS, QUANTITY_UNITS, type QuantityUnit, readSafetyInfo } from "@/lib/physical-legal";
import { type LegalFieldProblem, type PhysicalLegal, LEGAL_LABELS, checkLegalWrite, confirmsLegal, legalProblemMessage, safetySummary } from "@/lib/physical-legal-record";

const NOT_CONFIRMED = "Saving was not confirmed. Reload the page to check what was saved before trying again.";

const REFUSALS: Record<string, string> = {
  ship_first: "Set up shipping for this product first: these fields are for a product you ship.",
  quantity_price: "Net quantity: one of these prices is no longer on this product. Reload the page and try again.",
  store_full: "Your store is full. Remove something before adding more.",
  signed_out: "Your session ended. Log in again.",
};

const UNIT_WORDS: Record<QuantityUnit, string> = {
  g: "grams (g)",
  kg: "kilograms (kg)",
  ml: "milliliters (mL)",
  cl: "centiliters (cL)",
  l: "liters (L)",
  mm: "millimeters (mm)",
  cm: "centimeters (cm)",
  m: "meters (m)",
  cm2: "square centimeters (cm²)",
  m2: "square meters (m²)",
  cm3: "cubic centimeters (cm³)",
  m3: "cubic meters (m³)",
};

function countryList(): { code: string; name: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en-US"], { type: "region" });
  } catch {
    names = null;
  }
  return SHIP_COUNTRIES.map((code) => {
    let name = code;
    try {
      name = names?.of(code) ?? code;
    } catch {
      name = code;
    }
    return { code, name };
  }).sort((a, b) => a.name.localeCompare(b.name, "en-US"));
}

type Contact = { name: string; postal: string; electronic: string; country: string };
const EMPTY: Contact = { name: "", postal: "", electronic: "", country: "" };

/**
 * The legal information on a product the creator ships (618 [SZ2];
 * lib/physical-legal-record.ts): EU product safety and its manufacturer, the
 * net quantity of each price and an optional California Proposition 65
 * warning, with what is still missing for EU/EEA shipping. Information fields
 * the creator fills; nothing here writes a warning or makes a legal claim.
 */
export function PhysicalLegalEditor({ product }: { product: Product }) {
  const router = useRouter();
  const saved = product.legal ?? null;
  const hasPicture = Boolean(product.image);
  const [open, setOpen] = useState(false);
  const [maker, setMaker] = useState<Contact>(saved?.safety?.manufacturer ?? EMPTY);
  const [rep, setRep] = useState<Contact>(saved?.safety?.responsible ?? EMPTY);
  const [productType, setProductType] = useState(saved?.safety?.productType ?? "");
  const [identifier, setIdentifier] = useState(saved?.safety?.identifier ?? "");
  const [warnings, setWarnings] = useState(saved?.safety?.warnings ?? "");
  const [noWarnings, setNoWarnings] = useState(saved?.safety?.noWarnings ?? false);
  const [prop65, setProp65] = useState(saved?.prop65 ?? "");
  const prices = [{ id: "", label: product.options.length ? "Main price" : "" }, ...product.options.map((option) => ({ id: option.id, label: option.label }))];
  const [amounts, setAmounts] = useState<Record<string, { amount: string; unit: QuantityUnit }>>(() =>
    Object.fromEntries(prices.map((price) => {
      const known = saved?.quantities.find((quantity) => quantity.price === price.id);
      return [price.id, { amount: known?.amount ?? "", unit: known?.unit ?? "g" }];
    })),
  );
  const [problems, setProblems] = useState<LegalFieldProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  if (!product.shipping) return null;

  const id = `legal-${product.id}`;
  const countries = countryList();
  const savedSummary = safetySummary(product.shipping.countries, saved?.safety ?? null, hasPicture);
  const repNeeded = maker.country !== "" && !GPSR_AREA.includes(maker.country);
  const showRep = repNeeded || rep.name !== "" || rep.postal !== "" || rep.electronic !== "" || rep.country !== "";
  const link = "min-h-11 text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep";

  const fieldId = (field: string) => `${id}-${field.replace(/[^a-z0-9]+/gi, "-")}`;
  const problemOf = (field: string) => problems.find((problem) => problem.field === field) ?? null;
  const errorId = (field: string) => `${fieldId(field)}-error`;
  const described = (field: string, help?: string) => [help, problemOf(field) ? errorId(field) : null].filter(Boolean).join(" ") || undefined;
  const fieldError = (field: string) => {
    const problem = problemOf(field);
    return problem ? <span id={errorId(field)} className="mt-1 block text-sm font-semibold text-red-800">{legalProblemMessage(problem)}</span> : null;
  };

  function draft(): Record<string, unknown> {
    return {
      safety: { manufacturer: maker, responsible: showRep ? rep : null, productType, identifier, warnings, noWarnings },
      prop65,
      quantities: prices.map((price) => ({ price: price.id, amount: amounts[price.id]?.amount ?? "", unit: amounts[price.id]?.unit ?? "g" })),
    };
  }

  function focusFirst(found: LegalFieldProblem[]) {
    const first = found[0];
    if (!first) return;
    const target = formRef.current?.ownerDocument.getElementById(fieldId(first.field === "quantity" ? "quantity:" : first.field));
    target?.focus();
  }

  async function send(body: Record<string, unknown> | null, said: string) {
    setError(null);
    let expected: PhysicalLegal | null = null;
    if (body !== null) {
      const checked = checkLegalWrite(body);
      if (!checked.ok) {
        setProblems(checked.problems);
        focusFirst(checked.problems);
        return;
      }
      expected = checked.legal;
    }
    setProblems([]);
    setBusy(true);
    try {
      const response = await fetch("/api/store/physical-legal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, legal: body }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (confirmsLegal(data, response.ok, product.id, expected)) {
        setOpen(false);
        toast(said);
        router.refresh();
        return;
      }
      const answer = data && typeof data === "object" ? (data as { ok?: unknown; error?: unknown; problems?: unknown }) : null;
      if (answer?.ok === false && answer.error === "invalid" && Array.isArray(answer.problems)) {
        const found = answer.problems.filter((p): p is LegalFieldProblem => Boolean(p) && typeof p === "object" && typeof (p as LegalFieldProblem).field === "string" && typeof (p as LegalFieldProblem).problem === "string");
        if (found.length) {
          setProblems(found);
          focusFirst(found);
          return;
        }
      }
      setError(answer?.ok === false && typeof answer.error === "string" && Object.hasOwn(REFUSALS, answer.error) ? REFUSALS[answer.error] : NOT_CONFIRMED);
    } catch {
      setError(NOT_CONFIRMED);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-3 text-sm text-ink-soft">
        <p>
          <span className="font-semibold text-ink">Legal information for shipping: </span>
          {savedSummary}
          {" "}
          <button type="button" className={link} onClick={() => setOpen(true)}>Edit legal information</button>
        </p>
        {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
      </div>
    );
  }

  const textField = (field: string, value: string, set: (value: string) => void, max: number, more: { optional?: boolean; help?: string; area?: boolean; type?: string; autoComplete?: string } = {}) => {
    const inputId = fieldId(field);
    const helpId = more.help ? `${inputId}-help` : undefined;
    const common = {
      id: inputId,
      className: "field mt-1",
      value,
      maxLength: max,
      "aria-invalid": problemOf(field) ? true : undefined,
      "aria-describedby": described(field, helpId),
      onChange: (event: { target: { value: string } }) => set(event.target.value),
    };
    return (
      <label className="mt-3 block" htmlFor={inputId}>
        <span className="field-label">{`${LEGAL_LABELS[field]}${more.optional ? " (optional)" : ""}`}</span>
        {more.area ? <textarea {...common} rows={3} /> : <input {...common} type={more.type ?? "text"} autoComplete={more.autoComplete ?? "off"} />}
        {more.help ? <span id={helpId} className="mt-1 block text-xs text-ink-soft">{more.help}</span> : null}
        {fieldError(field)}
      </label>
    );
  };

  const countryField = (field: string, value: string, set: (value: string) => void) => {
    const inputId = fieldId(field);
    return (
      <label className="mt-3 block" htmlFor={inputId}>
        <span className="field-label">{LEGAL_LABELS[field]}</span>
        <select id={inputId} className="field mt-1" value={value} aria-invalid={problemOf(field) ? true : undefined} aria-describedby={described(field)} onChange={(event) => set(event.target.value)}>
          <option value="">Pick a country</option>
          {countries.map((country) => (
            <option key={country.code} value={country.code}>{country.name}</option>
          ))}
        </select>
        {fieldError(field)}
      </label>
    );
  };

  const contactFields = (prefix: "manufacturer" | "responsible", value: Contact, set: (value: Contact) => void) => (
    <>
      {textField(`${prefix}.name`, value.name, (name) => set({ ...value, name }), MAX_NAME, { help: prefix === "manufacturer" ? "The company that makes it, or you if you make it: a name, registered trade name or trademark." : undefined })}
      {textField(`${prefix}.postal`, value.postal, (postal) => set({ ...value, postal }), MAX_POSTAL, { area: true })}
      {textField(`${prefix}.electronic`, value.electronic, (electronic) => set({ ...value, electronic }), MAX_ELECTRONIC, { help: "An email address, or a contact page that starts with https://." })}
      {countryField(`${prefix}.country`, value.country, (country) => set({ ...value, country }))}
    </>
  );

  // Read leniently for the live summary: a value that would be refused counts as not filled.
  const liveSummary = safetySummary(product.shipping.countries, readSafetyInfo(draft().safety), hasPicture);

  return (
    <form
      ref={formRef}
      aria-busy={busy}
      noValidate
      className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        send(draft(), "Legal information saved.");
      }}
    >
      <fieldset disabled={busy}>
        <legend className="text-sm font-bold text-ink">Legal information for shipping</legend>
        <p className="mt-1 text-xs text-ink-soft">
          Fill in what your manufacturer or supplier gave you. You can save part of it now and the rest later. These are information fields: they do not tell you whether a law applies to your product.
        </p>
        <p id={`${id}-gaps`} className="mt-2 text-sm font-semibold text-ink" aria-live="polite">
          {liveSummary}
        </p>
        {problems.length ? (
          <div className="notice notice-error mt-3" role="alert">
            <p className="font-semibold">{problems.length === 1 ? "Fix 1 field before saving:" : `Fix ${problems.length} fields before saving:`}</p>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((problem) => (
                <li key={`${problem.field}-${problem.problem}`}>{legalProblemMessage(problem)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <fieldset className="mt-4">
          <legend className="text-sm font-bold text-ink">Product safety and manufacturer</legend>
          <p className="mt-1 text-xs text-ink-soft">Asked for by the EU General Product Safety Regulation before a product is sold online to buyers in the EU, Iceland, Liechtenstein and Norway.</p>
          {contactFields("manufacturer", maker, setMaker)}
          {showRep ? (
            <fieldset className="mt-4">
              <legend className="text-sm font-bold text-ink">EU responsible person</legend>
              <p className="mt-1 text-xs text-ink-soft">Needed when the manufacturer is outside the EU/EEA: the company in the EU/EEA that answers for this product there, often its importer or an authorized representative.</p>
              {contactFields("responsible", rep, setRep)}
            </fieldset>
          ) : null}
          {textField("productType", productType, setProductType, MAX_TYPE, { help: "What a buyer sees to recognize it: a type or model, like “Hardcover cookbook, 120 pages”." })}
          {textField("identifier", identifier, setIdentifier, MAX_IDENTIFIER, { optional: true, help: "A batch, lot or serial number, if the product has one." })}
          {textField("warnings", warnings, setWarnings, MAX_WARNINGS, { area: true, help: "As printed on the product or its label, in the words you were given." })}
          <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-ink" htmlFor={fieldId("noWarnings")}>
            <input id={fieldId("noWarnings")} type="checkbox" className="h-5 w-5" checked={noWarnings} aria-describedby={described("warnings")} onChange={(event) => setNoWarnings(event.target.checked)} />
            {LEGAL_LABELS.noWarnings}
          </label>
          {hasPicture ? null : <p className="mt-2 text-xs text-ink-soft">Add a picture of the product above, under its image: the EU rules ask for one.</p>}
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-sm font-bold text-ink">Net quantity</legend>
          <p className="mt-1 text-xs text-ink-soft">The amount in the package, like 250 g or 1.5 L. The price per kilogram, liter, meter, square meter or cubic meter is worked out from it. Leave it empty for things not sold by weight, volume, length or area.</p>
          {prices.map((price) => {
            const field = `quantity:${price.id}`;
            const amountId = fieldId(field);
            const unitId = `${amountId}-unit`;
            const value = amounts[price.id] ?? { amount: "", unit: "g" as QuantityUnit };
            const set = (next: Partial<{ amount: string; unit: QuantityUnit }>) => setAmounts({ ...amounts, [price.id]: { ...value, ...next } });
            return (
              <div key={price.id || "main"} className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block" htmlFor={amountId}>
                  <span className="field-label">{price.label ? `Net quantity: ${price.label}` : "Net quantity (optional)"}</span>
                  <input id={amountId} type="text" inputMode="decimal" className="field mt-1" value={value.amount} maxLength={13} aria-invalid={problemOf(field) ? true : undefined} aria-describedby={described(field)} onChange={(event) => set({ amount: event.target.value })} />
                  {fieldError(field)}
                </label>
                <label className="block" htmlFor={unitId}>
                  <span className="field-label">{price.label ? `Unit: ${price.label}` : "Unit"}</span>
                  <select id={unitId} className="field mt-1" value={value.unit} onChange={(event) => set({ unit: event.target.value as QuantityUnit })}>
                    {QUANTITY_UNITS.map((unit) => (
                      <option key={unit} value={unit}>{UNIT_WORDS[unit]}</option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-sm font-bold text-ink">California Proposition 65 warning (optional)</legend>
          {textField("prop65", prop65, setProp65, MAX_PROP65, {
            area: true,
            help: "Only if your manufacturer or supplier gave you one: paste it word for word. It starts with a signal word such as WARNING and names the website www.P65Warnings.ca.gov. We never write or change it.",
          })}
        </fieldset>

        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm inline-flex min-h-11 items-center justify-center">{busy ? "Saving…" : "Save legal information"}</button>
          <button type="button" className="btn btn-ghost btn-sm inline-flex min-h-11 items-center justify-center" onClick={() => { setOpen(false); setError(null); setProblems([]); }}>Cancel</button>
        </div>
      </fieldset>
    </form>
  );
}
