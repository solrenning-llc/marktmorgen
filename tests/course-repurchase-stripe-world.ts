// Synthetic world: the real lib/stripe-account, with onAccount answering from a fixed list of checkout sessions
// and nothing else (no provider is called).
export * from "../lib/stripe-account";

export const stripe: { sessions: Record<string, unknown>[]; asked: string[]; fail?: boolean; byEmail?: Record<string, Record<string, unknown>[]> } = { sessions: [], asked: [] };

export async function onAccount(_method: string, _account: string, path: string): Promise<Record<string, unknown>> {
  stripe.asked.push(path);
  // A call that does not answer (a timeout, an outage), when a check asks for one.
  if (stripe.fail) throw new Error("synthetic: Stripe did not answer");
  if (path.startsWith("/checkout/sessions?")) {
    // One address's own sessions, where a test gives them; every other address the shared list.
    const who = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("customer_details[email]") ?? "";
    return { object: "list", data: stripe.byEmail?.[who] ?? stripe.sessions, has_more: false };
  }
  return { object: "list", data: [], has_more: false };
}
