export * from "../lib/stripe-account";
export const stripe = { calls: 0 };
export function platformKey() { return "synthetic-configured-no-credential"; }
export async function onAccount(): Promise<never> { stripe.calls++; throw new Error("no Stripe call is permitted in this fixture"); }
