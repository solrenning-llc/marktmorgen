"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PurchaseCard, type PurchaseCardModel } from "@/components/purchase-card";

/** What app/api/store/orders/older/route.ts answers: the purchases checked, what is still not checked, and what to say. */
export type OlderAnswer =
  | { ok: true; cards: PurchaseCardModel[]; from: string | null; left: string; said: string }
  | { ok: false; message: string };

/**
 * The purchases an opening could not check inside its calls to Stripe
 * (lib/buyer-orders.ts, ORDERS_STRIPE_CALLS), under the list: how many are not
 * checked yet, and a button that checks the next batch, read by a request
 * that pays for itself before it reads (app/api/store/orders/older). What it
 * finds is added below, drawn as the list draws a purchase. Focus stays on the
 * button while there are more; after the last batch it moves to the first
 * purchase that batch added, so it is never lost. A status region says what
 * happened, an alert what failed.
 */
export function OlderPurchases({
  address,
  from,
  left: initialLeft,
  storeName,
  language,
  words,
}: {
  address: string;
  from: string;
  left: string;
  storeName: string;
  language: unknown;
  words: { check: string; checking: string; failed: string };
}) {
  const leftId = useId();
  const [cursor, setCursor] = useState<string | null>(from);
  const [left, setLeft] = useState(initialLeft);
  const [cards, setCards] = useState<PurchaseCardModel[]>([]);
  const [firstNew, setFirstNew] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const focusTo = useRef<HTMLParagraphElement | null>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (moveFocus.current && focusTo.current) focusTo.current.focus();
    moveFocus.current = false;
  }, [cards]);

  async function check() {
    if (!cursor || busy) return;
    setBusy(true);
    setProblem("");
    setStatus(words.checking);
    let said = words.failed;
    try {
      const response = await fetch(`${address}&${new URLSearchParams({ from: cursor })}`, { cache: "no-store", headers: { Accept: "application/json" } });
      const answer = (await response.json().catch(() => null)) as OlderAnswer | null;
      if (answer?.ok) {
        moveFocus.current = !answer.from && answer.cards.length > 0;
        setFirstNew(cards.length);
        setCards([...cards, ...answer.cards]);
        setCursor(answer.from);
        setLeft(answer.left);
        setStatus(answer.said);
        setBusy(false);
        return;
      }
      if (answer && !answer.ok && answer.message) said = answer.message;
    } catch {
      // The connection failed: said, and the button stays to try again.
    }
    setBusy(false);
    setStatus("");
    setProblem(said);
  }

  return (
    <>
      {cards.length ? (
        <ul className="mt-4 space-y-4">
          {cards.map((card, i) => (
            <PurchaseCard
              key={card.reference}
              card={card}
              storeName={storeName}
              language={language}
              titleRef={i === firstNew ? (node) => void (focusTo.current = node) : undefined}
            />
          ))}
        </ul>
      ) : null}
      <div className="mt-6">
        {cursor ? (
          <>
            <p id={leftId} className="st-muted">
              {left}
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-block btn-wrap mt-3 min-h-11"
              aria-describedby={leftId}
              aria-disabled={busy || undefined}
              onClick={check}
            >
              {words.check}
            </button>
          </>
        ) : null}
        <p role="status" className="st-muted mt-3 text-sm empty:hidden">
          {status}
        </p>
        {problem ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: "var(--st-text)" }}>
            {problem}
          </p>
        ) : null}
      </div>
    </>
  );
}
