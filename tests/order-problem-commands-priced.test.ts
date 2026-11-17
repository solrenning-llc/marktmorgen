/**
 * A report of a problem with an order pays for its own Redis commands (Claude 7's MEDIUM on #3837): beyond the
 * inbox message (BURST("inbox"), UNIT_COST.inbox, already used by the message itself), a filing sends the per-buyer
 * counter (SET NX, INCR), the order's mark (GET, SET NX), the data room's EVAL, and after the write the mark kept (SET
 * XX) or given back (DEL), and the case's own record read when the filing threw (GET). No line priced them. They are
 * now ORDER_PROBLEM_COMMANDS, taken from the lookup's own meter (found.meter, as the withdrawal takes its reads) before
 * the counter is read, so a filing never sends a command that no request paid for.
 * Against the real route, an in-memory Redis, a stand-in Stripe and a stand-in email service; nothing real is reached.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as orderProblem from "@/lib/order-problem";
import { ORDERS_UNIT_COMMANDS } from "@/lib/buyer-orders-rules";
import { readFileSync } from "node:fs";
import { POST as problemRoute } from "@/app/api/store/order-problem/route";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const DAY = 86_400;

process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";

let sessions: Record<string, unknown>[] = [];
const mails: { to: string; subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    mails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  const one = path.match(/^\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = sessions.find((row) => row.id === one[1]);
    return found ? answer(found) : answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  sessions = [];
  mails.length = 0;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_order_problem_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Butter Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/butter");
  const store = (await storeForEmail(OWNER)) as Store;
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!;
  return { store, product: made.product.id, token: new URL(link).searchParams.get("token")! };
}

const paid = (id: string, product: string, created: number) => ({
  id: `cs_test_${id.padEnd(24, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  metadata: { store: "mara", product },
  customer_details: { email: BUYER },
  payment_intent: { id: `pi_test${id.padEnd(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
});

const post = (fields: Record<string, string>) =>
  problemRoute(new NextRequest(`${ORIGIN}/api/store/order-problem`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
const stateOf = (answer: Response) => new URL(answer.headers.get("location") ?? "https://x").searchParams.get("problem");


type Command = (string | number)[];
/** The inbox message's own unit (tests/plan-cost-registry.ts UNIT_COST.inbox): what BURST("inbox") prices, used by the message. */
const INBOX_UNIT_COMMANDS = 16;

async function filing(): Promise<{ state: string | null; sent: Command[] }> {
  const { product, token } = await shop();
  sessions = [paid("butter", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  const real = redis.pipeline.bind(redis);
  const sent: Command[] = [];
  redis.pipeline = (async (batch: Command[]) => {
    sent.push(...batch);
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    return { state: stateOf(await post({ handle: "mara", token, ref, reason: "cannot_access", note: "The link says the page is gone." })), sent };
  } finally {
    redis.pipeline = real;
  }
}

test("the filing's own commands are a named figure, at least what its worst path sends", async () => {
  const figure = (orderProblem as Record<string, unknown>).ORDER_PROBLEM_COMMANDS;
  assert.ok(typeof figure === "number" && Number.isSafeInteger(figure) && figure > 0, "ORDER_PROBLEM_COMMANDS is a whole number of commands");
  const { state, sent } = await filing();
  assert.equal(state, "filed");
  // The filing's own: the per-buyer counter and every command on the order's mark, plus the room's EVAL taken for it.
  const own = sent.filter((c) => String(c[1]).startsWith("nl:rl:order-problem:") || String(c[1]).startsWith("nl:oprob:")).length + 1;
  // The worst path adds the case's own record read once when the filing threw after its write (lib/inbox.ts keptExactly).
  assert.ok(own + 1 <= (figure as number), `the filing sends ${own} commands of its own (${own + 1} at its worst), more than ${String(figure)}`);
});

test("every command a filing sends is paid: the buyer's requests it took, and the inbox message's own unit", async () => {
  const { state, sent } = await filing();
  assert.equal(state, "filed");
  const units = sent.filter((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")).reduce((sum, c) => sum + Number(c[2]), 0);
  assert.ok(sent.length <= units * ORDERS_UNIT_COMMANDS + INBOX_UNIT_COMMANDS, `${sent.length} commands sent, ${units} requests taken`);
});

test("the route takes the filing's commands from the lookup's meter before the counter is read", () => {
  const route = readFileSync("app/api/store/order-problem/route.ts", "utf8");
  const take = route.indexOf("found.meter.take(ORDER_PROBLEM_COMMANDS)");
  const counter = route.indexOf('withinLimit("order-problem"');
  assert.ok(take > 0 && counter > 0 && take < counter, "found.meter.take(ORDER_PROBLEM_COMMANDS) comes before the per-buyer counter");
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  assert.ok(/"order-problem":[^\n]*\n?[^\n]*/.test(registry) && registry.includes("ORDER_PROBLEM_COMMANDS"), "the registry names where the filing's commands are paid");
});
