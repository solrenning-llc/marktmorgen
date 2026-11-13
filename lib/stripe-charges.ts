/**
 * Whether a store's Stripe account can take card payments, kept up to date
 * from the reads the code already makes (audit R39, finding 4).
 *
 * canSell (lib/store-checkout.ts) trusts store.stripeChargesEnabled, written
 * when the creator comes back from Stripe or presses "Ask Stripe again". But
 * Stripe can switch card payments off later, and back on. So the two other
 * places that read the account write what they read:
 *
 *   - the studio's checkup (lib/checkup.ts), which reads it every time;
 *   - a checkout Stripe refused on purpose (a 4xx other than 429, isRefusal in
 *     lib/checkout-trouble.ts): the account is read once, so a store over an
 *     account that cannot charge stops offering "Buy", and the buyer is told
 *     the store cannot take card payments rather than to try again.
 *
 * Only a card_payments status of the pinned API version is written (rule 24);
 * any other shape, or a read that fails, leaves the record as it was.
 */
import { type Store, noteStripeCharges, storeRef } from "@/lib/store";
import { type AccountState, readAccount } from "@/lib/stripe-connect";
import { isRefusal } from "@/lib/checkout-trouble";

type ChargesStore = Pick<Store, "email" | "sid" | "extra" | "stripeAccountId" | "stripeChargesEnabled">;

/**
 * Writes down what was read about card payments, when it differs from the
 * record. Whether they are on as now written; null when nothing could be
 * written (an unknown status, no account, or the store moved to another one).
 */
export async function keepChargesState(store: ChargesStore, state: AccountState): Promise<boolean | null> {
  if (!store.stripeAccountId || state.cardPayments === null) return null;
  const on = state.cardPayments === "active";
  if (on === store.stripeChargesEnabled) return on;
  const saved = await noteStripeCharges(storeRef(store), store.stripeAccountId, on);
  return saved ? saved.stripeChargesEnabled : null;
}

/**
 * After a checkout Stripe would not open: true only when Stripe refused on
 * purpose and then said, in a status it knows, that the account cannot take
 * card payments. That is written down; anything else is false and writes
 * nothing, so the buyer keeps the plain error.
 */
export async function chargesOffAfterRefusal(store: ChargesStore, error: unknown): Promise<boolean> {
  if (!isRefusal(error) || !store.stripeAccountId) return false;
  let state: AccountState;
  try {
    state = await readAccount(store.stripeAccountId);
  } catch {
    return false;
  }
  if (state.cardPayments === null || state.cardPayments === "active") return false;
  // What Stripe said is true whether or not the record took it; a record that
  // could not be written is written by the next read.
  await keepChargesState(store, state).catch(() => null);
  return true;
}
