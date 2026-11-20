import type { Store } from "@/lib/store";
import { PENDING_GIVE_UP_SECONDS, paypalOrdersWaiting } from "@/lib/paypal-sales";

const DAYS = Math.round(PENDING_GIVE_UP_SECONDS / 86_400);

/**
 * The studio's notice, in the PayPal card, while PayPal is disconnected and some of the store's PayPal orders still
 * wait on PayPal to confirm the payment (lib/paypal-sales.ts, paypalOrdersWaiting). It says how many, what happens to
 * them, and asks the creator to reconnect PayPal, whose button is just below it. Pure: nothing for a count of none.
 * A named region with its own heading, announced politely (role="status") when it appears.
 */
export function PayPalWaitingNotice({ count }: { count: number }) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const orders = count === 1 ? "1 PayPal order is" : `${count} PayPal orders are`;
  return (
    <section role="status" aria-labelledby="paypal-waiting-title" className="mt-5 rounded-3xl border-2 border-ink bg-white p-5 text-ink">
      <h3 id="paypal-waiting-title" className="text-base font-bold">
        Reconnect PayPal: {orders} still waiting
      </h3>
      <p className="mt-2">
        {count === 1 ? "A buyer paid with PayPal, and PayPal has not confirmed the payment yet." : "Buyers paid with PayPal, and PayPal has not confirmed these payments yet."}{" "}
        We keep checking with PayPal and send each buyer what they bought as soon as PayPal confirms it.
      </p>
      <p className="mt-2">
        If you also removed Marktmorgen from your PayPal settings, we cannot check. Connect your PayPal account again
        below so these orders can be finished.
      </p>
      <p className="mt-2">
        {`An order PayPal does not confirm within ${DAYS} days is canceled. We email you and the buyer when that happens.`}
      </p>
    </section>
  );
}

/** Reads the count for the notice (one ZCARD, only while PayPal is disconnected and its orders are still asked about). */
export async function PayPalWaiting({ store }: { store: Pick<Store, "statsId" | "paypalSeller" | "paypalPast"> }) {
  const count = await paypalOrdersWaiting(store).catch(() => null);
  return count === null ? null : <PayPalWaitingNotice count={count} />;
}
