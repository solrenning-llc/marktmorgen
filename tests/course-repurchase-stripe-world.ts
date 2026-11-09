// Synthetic world: the real lib/stripe-account, with onAccount answering from a fixed list of checkout sessions
// and nothing else (no provider is called).
export * from "../lib/stripe-account";

export const stripe: { sessions: Record<string, unknown>[]; asked: string[]; fail?: boolean } = { sessions: [], asked: [] };

export async function onAccount(_method: string, _account: string, path: string): Promise<Record<string, unknown>> {
  stripe.asked.push(path);
  // A call that does not answer (a timeout, an outage), when a check asks for one.
  if (stripe.fail) throw new Error("synthetic: Stripe did not answer");
  if (path.startsWith("/checkout/sessions?")) return { object: "list", data: stripe.sessions, has_more: false };
  return { object: "list", data: [], has_more: false };
}
