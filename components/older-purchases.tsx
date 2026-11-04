"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { PurchaseCard, type PurchaseCardModel } from "@/components/purchase-card";
import { useOrdersShared } from "@/components/orders-shared";

/** What app/api/store/orders/older/route.ts answers: the purchases checked, where the next batch starts, what is still not checked, and what to say. */
export type OlderAnswer =
  | { ok: true; cards: PurchaseCardModel[]; older: string | null; left: string; said: string }
  | { ok: false; message: string };

/**
 * The purchases an opening could not check inside its calls to Stripe
 * (lib/buyer-orders.ts, ORDERS_STRIPE_CALLS), under the list: how many are not
 * checked yet, and a button that checks the next batch, ORDERS_OLDER_MOST at
 * the most, read by a request that pays for itself before it reads
 * (app/api/store/orders/older). What it finds is added below, drawn as the
 * list draws a purchase. Focus stays on the button while there are more;
 * after the last batch it moves to the first purchase that batch added or,
 * when it added none, to what the status says, so it is never lost. The
 * status region is always on the page; an alert says what failed.
 *
 * Without JavaScript the same button sends its form: the list's page draws
 * the batch on a page of its own (`older`), paid for the same way
 * (app/[handle]/orders/page.tsx).
 */
export function OlderPurchases({ older, left: initialLeft }: { older: string; left: string }) {
  const shared = useOrdersShared();
  const { words } = shared;
  const leftId = useId();
  const [cursor, setCursor] = useState<string | null>(older);
  const [left, setLeft] = useState(initialLeft);
  const [cards, setCards] = useState<PurchaseCardModel[]>([]);
  const [firstNew, setFirstNew] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const focusTo = useRef<HTMLParagraphElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const moveFocus = useRef<"card" | "status" | null>(null);

  useEffect(() => {
    const target = moveFocus.current === "card" ? focusTo.current : moveFocus.current === "status" ? statusRef.current : null;
    target?.focus();
    moveFocus.current = null;
  }, [cards, cursor]);

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!cursor || busy) return;
    setBusy(true);
    setProblem("");
    setStatus(words.checking);
    let said = words.olderFailed;
    try {
      const address = `/api/store/orders/older?${new URLSearchParams({ handle: shared.handle, token: shared.token, older: cursor })}`;
      const response = await fetch(address, { cache: "no-store", headers: { Accept: "application/json" } });
      const answer = (await response.json().catch(() => null)) as OlderAnswer | null;
      if (answer?.ok) {
        // The button leaves with the last batch: focus goes to its first purchase, or to what the status says.
        moveFocus.current = answer.older ? null : answer.cards.length > 0 ? "card" : "status";
        setFirstNew(cards.length);
        setCards([...cards, ...answer.cards]);
        setCursor(answer.older);
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
            <PurchaseCard key={card.reference} card={card} language={shared.language} titleRef={i === firstNew ? (node) => void (focusTo.current = node) : undefined} />
          ))}
        </ul>
      ) : null}
      <div className="mt-6">
        {cursor ? (
          <form method="get" action={`/@${shared.handle}/orders`} onSubmit={check}>
            <p id={leftId} className="st-muted">
              {left}
            </p>
            <input type="hidden" name="token" value={shared.token} />
            <input type="hidden" name="older" value={cursor} />
            <button type="submit" className="btn btn-secondary btn-block btn-wrap mt-3 min-h-11" aria-describedby={leftId} aria-disabled={busy || undefined}>
              {words.check}
            </button>
          </form>
        ) : null}
        <p role="status" ref={statusRef} tabIndex={-1} className={status ? "st-muted mt-3 text-sm" : "sr-only"}>
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
