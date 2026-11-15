"use client";

/**
 * 244 [SP1]: what is left of one sale, worked out in the visitor's browser
 * from what they type (lib/free-tools.ts). Nothing is sent or kept: there is
 * no form submission, no request and no storage. The site types no fee and
 * assumes no tax: the visitor's own figures, or nothing.
 */
import { useId, useState } from "react";
import { readAmount, readPercent, takeHome } from "@/lib/free-tools";

const money = (cents: number) => `${cents < 0 ? "−" : ""}${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TakeHomeTool() {
  const [price, setPrice] = useState("");
  const [percent, setPercent] = useState("");
  const [fixed, setFixed] = useState("");
  const [other, setOther] = useState("");
  const help = useId();

  const p = readAmount(price);
  const pct = percent.trim() === "" ? 0 : readPercent(percent);
  const fx = fixed.trim() === "" ? 0 : readAmount(fixed);
  const ot = other.trim() === "" ? 0 : readAmount(other);
  const problems = [
    price.trim() !== "" && p === null ? "The price is not a number we can read. Type it like 49 or 49.99." : "",
    pct === null ? "The percentage fee is not a number from 0 to 100. Type it like 2.9." : "",
    fx === null ? "The fixed fee is not a number we can read. Type it like 0.30." : "",
    ot === null ? "The other cost is not a number we can read. Type it like 5 or 5.50." : "",
  ].filter(Boolean);
  const result = p !== null && pct !== null && fx !== null && ot !== null ? takeHome({ priceCents: p, percentBps: pct, fixedCents: fx, otherCents: ot }) : null;

  const field = "field mt-2 w-full max-w-xs";
  return (
    <div className="space-y-6">
      <p id={help} className="max-w-[70ch]">
        Type amounts in your own currency. This tool does not add or assume any tax, and nothing you type leaves this page.
      </p>
      <form className="grid max-w-xl gap-5" onSubmit={(e) => e.preventDefault()} aria-describedby={help} noValidate>
        <div>
          <label htmlFor="take-home-price" className="field-label">Price of one sale</label>
          <input id="take-home-price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="take-home-percent" className="field-label">Your payment fee, as a percentage (optional)</label>
          <input id="take-home-percent" inputMode="decimal" autoComplete="off" value={percent} onChange={(e) => setPercent(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="take-home-fixed" className="field-label">Your fixed fee per sale (optional)</label>
          <input id="take-home-fixed" inputMode="decimal" autoComplete="off" value={fixed} onChange={(e) => setFixed(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="take-home-other" className="field-label">Any other cost per sale (optional)</label>
          <input id="take-home-other" inputMode="decimal" autoComplete="off" value={other} onChange={(e) => setOther(e.target.value)} className={field} />
        </div>
      </form>
      {problems.length ? (
        <ul className="notice notice-warn max-w-xl list-disc pl-6 text-ink" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <output aria-live="polite" htmlFor="take-home-price take-home-percent take-home-fixed take-home-other" className="block max-w-xl rounded-2xl bg-paper p-5 ring-1 ring-line">
        {result ? (
          <>
            <span className="block">{`Fees: ${money(result.feeCents)}. Other costs: ${money(result.otherCents)}.`}</span>
            <span className="mt-1 block text-lg font-semibold">
              {result.belowZero ? `This sale costs you ${money(-result.leftCents)} more than its price.` : `Left from this sale, before taxes: ${money(result.leftCents)}.`}
            </span>
          </>
        ) : (
          <span>Type a price to see what is left.</span>
        )}
      </output>
    </div>
  );
}
