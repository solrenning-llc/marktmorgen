/**
 * A synthetic Stripe for the refund reserve's readings (306 [SY2] units 2b
 * and 3a): our platform account's charges, their refunds and disputes, and
 * the events Stripe would list for each change, newest first, paginated with
 * starting_after and ending_before as Stripe does. GET only: any other method
 * throws. Nothing here reaches Stripe.
 */
const DAY = 86_400;

type Refund = { id: string; status: string; amount: number };
type Dispute = { id: string; status: string; amount: number };
export type Kind = "plan" | "assistant" | "captions" | "none" | "foreign";
export type ChargeSpec = { kind: Kind; cycle?: "month" | "year"; amount: number; paidAt: number; status?: string; billing?: string };

type Charge = { json: Record<string, unknown>; refunds: Refund[]; dispute: Dispute | null };
type Event = { id: string; type: string; created: number; object: Record<string, unknown> };

export const world = {
  charges: new Map<string, Charge>(),
  events: [] as Event[],
  requests: [] as { method: string; path: string; query: URLSearchParams; version: string | null }[],
  /** The clock Stripe stamps events with. */
  clock: 0,
  /** Ids Stripe no longer keeps (an event past its retention). */
  forgotten: new Set<string>(),
  fail: null as null | ((path: string, query: URLSearchParams) => unknown),
};
let sequence = 0;
const pad = () => String(++sequence).padStart(9, "0");

export function resetWorld(clock: number): void {
  world.charges.clear();
  world.events.length = 0;
  world.requests.length = 0;
  world.forgotten.clear();
  world.fail = null;
  world.clock = clock;
}

function view(charge: Charge): Record<string, unknown> {
  const refunded = charge.refunds.filter((r) => ["succeeded", "pending", "requires_action"].includes(r.status)).reduce((sum, r) => sum + r.amount, 0);
  return {
    ...charge.json,
    amount_refunded: refunded,
    disputed: charge.dispute !== null,
    refunds: { object: "list", has_more: false, data: charge.refunds.map((r) => ({ object: "refund", charge: charge.json.id, ...r })) },
  };
}

function emit(type: string, object: Record<string, unknown>): void {
  world.clock += 1;
  world.events.push({ id: `evt_Reserve${pad()}`, type, created: world.clock, object });
}

/** A charge, as Stripe's 2024-06-20 version shows it with invoice, subscription, fee and refunds expanded. */
export function addCharge(spec: ChargeSpec): string {
  const n = pad(), id = `ch_Reserve${n}`;
  const status = spec.status ?? "succeeded", cycle = spec.cycle ?? "month";
  const length = (cycle === "year" ? 365 : 30) * DAY;
  const subscription = spec.kind === "plan" ? { id: `sub_Reserve${n}`, object: "subscription", metadata: { store: "harbor" } } : spec.kind === "assistant" ? { id: `sub_Reserve${n}`, object: "subscription", metadata: { addon: "assistant" } } : null;
  const line = { id: `il_Reserve${n}`, object: "line_item", type: subscription ? "subscription" : "invoiceitem", period: { start: spec.paidAt, end: subscription ? spec.paidAt + length : spec.paidAt }, price: { id: `price_Reserve${n}`, unit_amount: spec.amount, currency: "usd", recurring: subscription ? { interval: cycle, interval_count: 1 } : null } };
  const invoice = spec.kind === "none" ? null : {
    id: `in_Reserve${n}`, object: "invoice", total: spec.amount, tax: 0,
    billing_reason: spec.billing ?? (subscription ? "subscription_create" : "manual"),
    status_transitions: { paid_at: spec.paidAt }, metadata: spec.kind === "captions" ? { mark: `captions:vid${n}:1` } : {}, subscription,
    lines: { object: "list", has_more: false, data: [line] },
  };
  const json = {
    id, object: "charge", status, paid: status === "succeeded", amount: spec.amount, amount_captured: status === "succeeded" ? spec.amount : 0, currency: "usd", created: spec.paidAt,
    balance_transaction: status === "succeeded" ? { id: `txn_Reserve${n}`, object: "balance_transaction", fee: Math.round(spec.amount * 0.066) + 30, currency: "usd" } : null,
    invoice,
  };
  const charge: Charge = { json, refunds: [], dispute: null };
  world.charges.set(id, charge);
  emit(status === "succeeded" ? "charge.succeeded" : status === "failed" ? "charge.failed" : "charge.pending", view(charge));
  return id;
}

export function settle(id: string, status: "succeeded" | "failed"): void {
  const charge = world.charges.get(id)!;
  charge.json = { ...charge.json, status, paid: status === "succeeded", amount_captured: status === "succeeded" ? charge.json.amount : 0,
    balance_transaction: status === "succeeded" ? { id: `txn_Settled${pad()}`, object: "balance_transaction", fee: 40, currency: "usd" } : null };
  emit(`charge.${status}`, view(charge));
}

export function refund(id: string, amount: number, status = "succeeded"): string {
  const charge = world.charges.get(id)!;
  const refundId = `re_Reserve${pad()}`;
  charge.refunds.push({ id: refundId, status, amount });
  emit("charge.refunded", view(charge));
  return refundId;
}

export function refundStatus(id: string, refundId: string, status: string): void {
  const charge = world.charges.get(id)!;
  charge.refunds = charge.refunds.map((r) => (r.id === refundId ? { ...r, status } : r));
  emit("charge.refund.updated", { id: refundId, object: "refund", charge: id, status });
}

export function dispute(id: string, status: string): void {
  const charge = world.charges.get(id)!;
  const opened = charge.dispute === null;
  charge.dispute = { id: charge.dispute?.id ?? `dp_Reserve${pad()}`, status, amount: Number(charge.json.amount) };
  emit(opened ? "charge.dispute.created" : ["won", "lost"].includes(status) ? "charge.dispute.closed" : "charge.dispute.updated", { id: charge.dispute.id, object: "dispute", charge: id, status, amount: charge.dispute.amount });
}

/** Newest first, then by id descending, as Stripe lists. */
function page<T extends { id: string; created: number }>(all: T[], query: URLSearchParams): { data: T[]; has_more: boolean } {
  const sorted = [...all].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  const gte = query.get("created[gte]");
  const filtered = gte === null ? sorted : sorted.filter((row) => row.created >= Number(gte));
  const limit = Number(query.get("limit") ?? 10);
  const after = query.get("starting_after"), before = query.get("ending_before");
  if (after) {
    const at = filtered.findIndex((row) => row.id === after);
    if (at < 0) throw Object.assign(new Error("No such object: " + after), { missing: true });
    const rest = filtered.slice(at + 1);
    return { data: rest.slice(0, limit), has_more: rest.length > limit };
  }
  if (before) {
    const at = filtered.findIndex((row) => row.id === before);
    if (at < 0) throw Object.assign(new Error("No such object: " + before), { missing: true });
    // The `limit` rows just newer than `before`, still newest first; has_more when newer ones remain.
    const newer = filtered.slice(0, at);
    return { data: newer.slice(Math.max(0, newer.length - limit)), has_more: newer.length > limit };
  }
  return { data: filtered.slice(0, limit), has_more: filtered.length > limit };
}

export async function stripeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  world.requests.push({ method, path: url.pathname, query: url.searchParams, version: new Headers(init?.headers).get("Stripe-Version") });
  if (method !== "GET") throw Error("the refund reserve never writes to Stripe");
  if (world.fail) {
    const answer = world.fail(url.pathname, url.searchParams);
    if (answer !== undefined) return answer instanceof Response ? answer : Response.json(answer);
  }
  try {
    if (url.pathname === "/v1/charges") {
      const rows = [...world.charges.values()].map((c) => ({ id: String(c.json.id), created: Number(c.json.created), charge: c }));
      const { data, has_more } = page(rows, url.searchParams);
      return Response.json({ object: "list", url: "/v1/charges", has_more, data: data.map((row) => view(row.charge)) });
    }
    const one = url.pathname.match(/^\/v1\/charges\/([A-Za-z0-9_]+)$/);
    if (one) {
      const charge = world.charges.get(one[1]);
      return charge ? Response.json(view(charge)) : Response.json({ error: { message: "No such charge" } }, { status: 404 });
    }
    if (url.pathname === "/v1/events") {
      const types = url.searchParams.getAll("types[]");
      const live = world.events.filter((e) => !world.forgotten.has(e.id) && (!types.length || types.includes(e.type)));
      const before = url.searchParams.get("ending_before");
      if (before && world.forgotten.has(before)) return Response.json({ error: { message: "No such event" } }, { status: 404 });
      const { data, has_more } = page(live, url.searchParams);
      return Response.json({ object: "list", url: "/v1/events", has_more, data: data.map((e) => ({ id: e.id, object: "event", type: e.type, created: e.created, data: { object: e.object } })) });
    }
    if (url.pathname === "/v1/disputes") {
      const charge = world.charges.get(url.searchParams.get("charge") ?? "");
      return Response.json({ object: "list", has_more: false, data: charge?.dispute ? [{ object: "dispute", charge: charge.json.id, ...charge.dispute }] : [] });
    }
  } catch (error) {
    if ((error as { missing?: boolean }).missing) return Response.json({ error: { message: String((error as Error).message) } }, { status: 404 });
    throw error;
  }
  throw Error("unexpected Stripe path " + url.pathname);
}
