/**
 * A stand-in for Stripe's GET /v1/checkout/sessions, shared by the tests of the
 * jobs that list a store's Checkout Sessions (tests/checkout-sweep-complete.test.ts,
 * tests/quiet-sales-complete.test.ts). It answers as Stripe does: newest first,
 * `limit` (at most 100), `created[gte]`, `status` and `starting_after` honored,
 * and an unknown `starting_after` refused.
 */
export type StandInSession = Record<string, unknown> & { id: string; created: number; status: string };

/** Stripe's answer to one list request over `sessions`, the whole account's Checkout Sessions. */
export function listCheckoutSessions(sessions: readonly StandInSession[], url: URL): Response {
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 10));
  const status = url.searchParams.get("status");
  const since = Number(url.searchParams.get("created[gte]") ?? 0);
  const after = url.searchParams.get("starting_after");
  const order = (a: StandInSession, b: StandInSession) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const all = [...sessions].sort(order);
  let rows = all.filter((row) => row.created >= since && (!status || row.status === status));
  if (after) {
    const anchor = all.find((row) => row.id === after);
    if (!anchor) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `No such checkout.session: '${after}'` } }), { status: 400 });
    rows = rows.filter((row) => order(anchor, row) < 0);
  }
  return new Response(JSON.stringify({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit }));
}
