/**
 * 793 [IV3] unit 2, item 2 (b): a sale's own lines in the studio's list of sales when the Solrenning LLC collected
 * its VAT (lib/sale-vat-line.ts). Nothing is drawn for a sale without VAT collected. Plain text in the sale's entry,
 * no color or icon carrying meaning; an amount Stripe has not given is said in words, never shown as 0.
 */
import { formatMoney } from "@/lib/money";
import type { SaleVatLine } from "@/lib/sale-vat-line";

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-US"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function percent(basisPoints: number): string {
  const whole = basisPoints / 100;
  return Number.isInteger(whole) ? String(whole) : whole.toFixed(2).replace(/0$/, "");
}

export function SaleVatLines({ vat, currency }: { vat: SaleVatLine | "unreadable" | null | undefined; currency: string }) {
  if (!vat) return null;
  if (vat === "unreadable") {
    return <p className="mt-1 text-sm text-ink-soft">The VAT on this sale could not be read here. You can see it in Stripe.</p>;
  }
  return (
    <>
      <p className="mt-1 text-sm text-ink-soft">
        VAT for {countryName(vat.country)} ({percent(vat.basisPoints)}%), collected by Marktmorgen for the tax office: {formatMoney(vat.vatCents, vat.currency || currency)}
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        {vat.stripeFeeOnVat === "unknown"
          ? "Stripe's fee on that VAT, which you pay: not known yet."
          : `Stripe's fee on that VAT, which you pay: ${formatMoney(vat.stripeFeeOnVat.cents, vat.stripeFeeOnVat.currency)}`}
      </p>
    </>
  );
}
