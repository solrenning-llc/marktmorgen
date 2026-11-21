"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { Product } from "@/lib/store";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { euVatCollectOn, ukVatCollectOn } from "@/lib/vat-registrations";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  signed_out: "Your session ended. Log in again.",
  unknown: "This product was not found. It may have been deleted; reload the page.",
  none: "This account has no store yet.",
  invalid: "That answer could not be saved. Pick one of the three choices.",
  server_error: "We could not confirm whether your answer was saved. Reload this page to check before trying again.",
};

export type PublicationAnswer = "yes" | "no" | "unset";

/** The product's stored answer as one of the three choices (lib/catalog.ts, Product.publication). */
export function answerOf(publication: boolean | undefined): PublicationAnswer {
  return publication === true ? "yes" : publication === false ? "no" : "unset";
}

const VALUE: Record<PublicationAnswer, boolean | null> = { yes: true, no: false, unset: null };

const CHOICES: readonly { answer: PublicationAnswer; title: string; detail: string }[] = [
  { answer: "yes", title: "Yes, it is", detail: "An e-book, an e-magazine or an e-newspaper that buyers read on a screen." },
  { answer: "no", title: "No, it is not", detail: "For example a course, a template, software, music or a video." },
  { answer: "unset", title: "Not answered yet", detail: "Buyers in the EU and the UK cannot buy it until you answer." },
];

/**
 * The creator's answer to whether a product is an electronically supplied publication, for VAT (789 [IV1] step 3,
 * unit 5b; lib/catalog.ts Product.publication). Shown only while EU or UK VAT can be collected (the reviewed switch
 * in lib/vat-registrations.ts): before that the answer changes nothing a buyer sees, and the studio never shows a
 * control that does nothing (rule VR, item 2).
 */
export function PublicationChoice({ product, open = euVatCollectOn() || ukVatCollectOn() }: { product: Product; open?: boolean }) {
  return open ? <PublicationChoiceLive product={product} /> : null;
}

/** The choice once shown: saves each answer at once and says so, or says why it could not. */
function PublicationChoiceLive({ product }: { product: Product }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: PublicationAnswer) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/publication", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, publication: VALUE[next] }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (!response.ok || data.ok !== true || data.id !== product.id || data.publication !== VALUE[next]) {
        const reason = typeof data.error === "string" ? data.error : "";
        setError(data.ok === false && !response.ok && Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : MESSAGES.server_error);
        return;
      }
      toast("Your answer is saved.");
      router.refresh();
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return <PublicationChoiceView id={product.id} answer={answerOf(product.publication)} busy={busy} error={error} onChange={change} />;
}

/** The choice itself, without the network: three radios in a fieldset, the help said once, the error read out. */
export function PublicationChoiceView({ id, answer, busy, error, onChange }: { id: string; answer: PublicationAnswer; busy: boolean; error: string | null; onChange: (next: PublicationAnswer) => void }) {
  const name = `publication-${id}`;
  return (
    <div aria-busy={busy} className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
      <fieldset aria-describedby={`${name}-hint`}>
        <legend className="field-label">Is this product an e-book, an e-magazine or an e-newspaper?</legend>
        <p id={`${name}-hint`} className="mt-1 text-sm text-ink-soft">
          We use your answer to add the right VAT for buyers in the EU and the UK. Some countries tax these at a lower rate,
          so we never guess.
        </p>
        <div className="mt-2 grid gap-2">
          {CHOICES.map((choice) => (
            <label
              key={choice.answer}
              className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 text-sm transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand"
            >
              <input
                type="radio"
                name={name}
                value={choice.answer}
                checked={answer === choice.answer}
                disabled={busy}
                onChange={() => onChange(choice.answer)}
                className="mt-0.5 h-4 w-4 accent-violet-brand"
              />
              <span>
                <span className="block font-semibold text-ink">{choice.title}</span>
                <span className="block text-ink-soft">{choice.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p role="alert" className="notice notice-error mt-3 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
