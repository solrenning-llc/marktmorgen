import type { Listing } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import type { PhysicalLegal } from "@/lib/physical-legal-record";
import { type Contact, GPSR_AREA, unitPrice } from "@/lib/physical-legal";
import { sellableOptions } from "@/lib/product-option";
import { fairOff } from "@/lib/fair-price";
import { saleClock, saleOff, salePrice } from "@/lib/store-sale";
import { speech } from "@/lib/buyer-words";
import { productSafetyWords } from "@/lib/buyer-words/product-safety";

const SIGNAL = /^(WARNING|CA WARNING|CALIFORNIA WARNING):/;

/**
 * What the creator filled on a physical product they ship (618 [SZ2] unit 3;
 * lib/physical-legal-record.ts), on its page before the buy button: the unit
 * price of each price sold, from the price charged now, and, under a heading
 * of its own, the manufacturer, the EU responsible person when the
 * manufacturer is outside the EU/EEA, the type or model, the batch or serial
 * number, the warnings or the creator's statement that there are none, and
 * the creator's Proposition 65 text. Only what was filled is shown, as text,
 * in a definition list (AX274: 2.4.10, 1.3.1, 1.4.9); a unit is always
 * written out (3.1.4). These are the creator's information fields: nothing
 * here says that the product complies with anything. Nothing when there is
 * no record.
 */
export function ProductSafetyFacts({ store, product, legal }: { store: Store; product: Listing; legal: PhysicalLegal | null }) {
  if (!legal) return null;
  const words = productSafetyWords(store.language);
  const { money, country } = speech(store);
  // The price charged now: a store sale or a fair price for the visitor's country, as the price tag shows it.
  const off = Math.max(store.sale ? saleOff(store.sale, product, saleClock()) : 0, fairOff(store.fair, product, store.visitorCountry ?? ""));
  const options = sellableOptions(product);
  const prices = options.length > 0 ? options.map((option) => ({ id: option.id, label: option.label, cents: option.priceCents })) : [{ id: "", label: "", cents: product.priceCents }];
  const units = prices.flatMap((price) => {
    const quantity = legal.quantities.find((q) => q.price === price.id) ?? null;
    const unit = unitPrice(salePrice(price.cents, off), quantity);
    if (!unit) return [];
    const per = words.per[unit.unit];
    return [price.label ? words.optionUnit(price.label, money(unit.cents), per) : words.unitPrice(money(unit.cents), per)];
  });

  const safety = legal.safety;
  const lines = (contact: Contact) => [contact.name, contact.postal, contact.electronic, contact.country ? country(contact.country) : ""].filter(Boolean);
  const maker = safety ? lines(safety.manufacturer) : [];
  const outside = Boolean(safety?.manufacturer.country) && !GPSR_AREA.includes(safety!.manufacturer.country);
  const responsible = safety?.responsible && outside ? lines(safety.responsible) : [];
  const rows: { term: string; values: string[] }[] = [
    { term: words.manufacturer, values: maker },
    { term: words.responsible, values: responsible },
    { term: words.type, values: safety?.productType ? [safety.productType] : [] },
    { term: words.identifier, values: safety?.identifier ? [safety.identifier] : [] },
    { term: words.warnings, values: safety?.warnings ? [safety.warnings] : safety?.noWarnings ? [words.noWarnings(store.name)] : [] },
  ].filter((row) => row.values.length > 0);
  const signal = SIGNAL.exec(legal.prop65)?.[0] ?? "";

  return (
    <>
      {units.length > 0 ? (
        <div className="mb-4 text-sm" data-unit-price="">
          {units.map((line) => (
            <p key={line} className="st-muted">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {rows.length > 0 || legal.prop65 ? (
        <section className="mb-6 text-sm" aria-labelledby="product-safety-title">
          <h2 id="product-safety-title" className="st-label">
            {words.heading}
          </h2>
          <dl className="mt-2 space-y-2">
            {rows.map((row) => (
              <div key={row.term}>
                <dt className="font-semibold">{row.term}</dt>
                {row.values.map((value, i) => (
                  <dd key={i} className="break-words">
                    {value}
                  </dd>
                ))}
              </div>
            ))}
            {legal.prop65 ? (
              <div>
                <dt className="font-semibold">{words.prop65}</dt>
                <dd className="whitespace-pre-line break-words">
                  {signal ? <strong>{signal}</strong> : null}
                  {legal.prop65.slice(signal.length)}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}
    </>
  );
}
