/**
 * A withdrawal's acknowledgement whose send is not known (audit "envio incerto", 9 November 2026; rule 30):
 * sendEmail answers false also when the sender may have taken it (a server error, a timeout).
 *
 *   lib/withdrawal.ts:251 (an order, art. 11a(4)): an uncertain acknowledgement is never tried again (the next
 *     statement used to send it again, up to WITHDRAWAL_ACK_SENDS times, a copy each), and the buyer is told the
 *     truth: recorded, passed to the store, the confirmation not confirmed and not sent again.
 *   lib/plan-withdrawal.ts:185 (a creator's own plan): the same for the receipt, on the page and in the studio.
 *
 * A certain refusal (422) keeps what was there: the next statement tries it again.
 *
 * Synthetic store, in-memory Redis, Stripe and the email provider stood in by fetch. No network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { withdrawalKey } from "@/lib/withdrawal";
import { WITHDRAWAL_WORDS } from "@/lib/buyer-words/withdrawal";
import { POST as withdrawRoute } from "@/app/api/store/withdraw/route";
import WithdrawPage from "@/app/[handle]/orders/withdraw/page";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let sessions: Record<string, unknown>[] = [];
/** Every acknowledgement the provider was asked for, taken or not. */
let acks = 0;
let sender: "ok" | "uncertain" | "refused" = "ok";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { subject: string };
    if (body.subject.includes("withdrawal")) acks += 1;
    if (sender === "uncertain") return answer({ message: "internal" }, 500);
    if (sender === "refused") return answer({ message: "invalid" }, 422);
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
  acks = 0;
  sender = "ok";
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_withdrawal_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "creator", period: paidPeriod() });
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
  withdrawRoute(new NextRequest(`${ORIGIN}/api/store/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
const stateOf = (answer: Response) => new URL(answer.headers.get("location") ?? "https://x").searchParams.get("w");
const render = async (query: Record<string, string>) => renderToStaticMarkup(await WithdrawPage({ params: Promise.resolve({ handle: "@mara" }), searchParams: Promise.resolve(query) }));

test("an acknowledgement that may have gone is not sent again, and the buyer is told the truth", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("unsure", product, NOW - 2 * DAY)];
  const ref = sessions[0].id as string;
  const fields = { handle: "mara", token, ref, name: "Ana Souza", email: BUYER };
  sender = "uncertain";
  const first = await post(fields);
  sender = "ok";
  assert.equal(stateOf(first), "unsure", "said as not confirmed, never as not sent");
  assert.equal(acks, 1);
  const again = await post(fields);
  assert.equal(stateOf(again), "already", "a second statement sends nothing again");
  assert.equal(acks, 1, "never a second copy of the acknowledgement");
  const after = await render({ token, ref });
  assert.ok(!after.includes("Confirm withdrawal"), "the page offers no second statement");
  const shown = await render({ token, ref, w: "unsure" });
  assert.ok(shown.includes(WITHDRAWAL_WORDS.en.notices.unsure.title), "the page has words for it");
  const fieldsKept = (await redis.pipeline([["HMGET", withdrawalKey(store.sid!, ref), "sent"]]))[0];
  assert.deepEqual(fieldsKept, [null], "never marked as sent");
});

test("every language says the confirmation is not confirmed and is not sent again", () => {
  for (const [language, words] of Object.entries(WITHDRAWAL_WORDS)) {
    const notice = words.notices.unsure;
    assert.ok(notice && notice.title && notice.body, `${language}: the notice exists`);
    assert.notEqual(notice.body, words.notices.unsent.body, `${language}: not the words of a known failure`);
  }
  assert.ok(WITHDRAWAL_WORDS.en.notices.unsure.body.includes("We do not send it again, so you do not get two copies"));
  assert.ok(readFileSync("lib/withdrawal.ts", "utf8").includes("sendEmailOutcome"));
});

test("control: a certain refusal is tried again on the next statement", async () => {
  const { product, token } = await shop();
  sessions = [paid("refused", product, NOW - 2 * DAY)];
  const ref = sessions[0].id as string;
  const fields = { handle: "mara", token, ref, name: "Ana Souza", email: BUYER };
  sender = "refused";
  const first = await post(fields);
  sender = "ok";
  assert.equal(stateOf(first), "unsent");
  const second = await post(fields);
  assert.equal(stateOf(second), "done");
  assert.equal(acks, 2);
});
