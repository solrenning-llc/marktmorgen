/**
 * The Store assistant's third function: one reminder after a checkout left
 * unpaid, only to a buyer who checked its box at checkout
 * (lib/assistant-reminder.ts, lib/assistant-reminder-rules.ts, added 17
 * October 2026). Stripe, the model and the sender are played by a stand-in
 * for `fetch`. What is checked:
 *
 *   - off until the creator switches it on, the add-on is paid for and a
 *     postal address is given; no box, no yes kept, nothing sent;
 *   - the yes is kept only with the box checked, a valid address and the
 *     sentence's current version, word for word, with when; never an address
 *     in the queue; gone by itself in three days, and at once with the person;
 *   - no email without the box (Stripe's own consent path leaves a checked
 *     checkout to this one), after the checkout was paid, after the address
 *     paid elsewhere, twice for one checkout, after "stop", or with no
 *     postal address;
 *   - the email: the creator's name, postal address, the sentence checked and
 *     the day, a stop link and one-click header, an honest subject, and the
 *     AI's line under its label only when it holds; the fixed reminder when
 *     the line does not hold, the model fails or the month's replies are used;
 *   - one reply of the month's pool, at no more than a chat reply's worst,
 *     settled at what was billed; the store's email figure checked before the
 *     model is asked; the add-on still keeps the owner's floor;
 *   - the pages, the policies and the registry say so.
 */


import { addProduct, claimHandle, ensureListId, ensureStatsId, setAssistReminder, setAssistantPlan, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";







import { assistantWindow } from "@/lib/store-assistant-rules";



import { ASSIST_REMIND_VERSION } from "@/lib/assistant-reminder-rules";
import { assistReminderOffered, assistReminderShown, keepAssistReminder, remindFromConsent } from "@/lib/assistant-reminder";

import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_assist_reminder_only";
process.env.RESEND_API_KEY = "re_test_assist_reminder_only";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const OWNER = "remind@example.com";
const ACCOUNT = "acct_fixture002";
const ADDRESS = "12 Oven Lane, Portland, OR 97201";
type Mail = { to: string; subject: string; text: string; headers?: Record<string, string> };
type Sent = { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
const emails: Mail[] = [];
const asked: Sent[] = [];
/** Checkouts as Stripe has them, by id, and the completed ones it lists by address. */
const sessions: Record<string, Record<string, unknown>> = {};
const paidList: Record<string, unknown>[] = [];
let model: { line: string; usage?: unknown } | { status: number } = { line: "" };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; headers?: Record<string, string> };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, headers: body.headers });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api.anthropic.com") {
    asked.push(JSON.parse(String(init?.body)) as Sent);
    if ("status" in model) return new Response("overloaded", { status: model.status });
    return answer({ content: [{ type: "text", text: JSON.stringify({ line: model.line }) }], usage: model.usage ?? { input_tokens: 600, output_tokens: 30 } });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one && method === "GET") return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "No such checkout.session" } }, 404);
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: paidList, has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
const sessionId = () => `cs_test_assistremind${String((n += 1)).padStart(6, "0")}`;
async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  /** When a reminder is due: an hour for the checkout to close, an hour more. */
  const later = now + 2 * 3_600_000 + 60_000;

  await claimHandle(OWNER, "ovenshop", "Oven Shop", "Recipes for busy weeknights.");
  await setSubscription(OWNER, { customerId: "cus_OvenShop001", subscriptionId: "sub_OvenPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const make = async (title: string, summary: string, price: string) => {
    const made = await addProduct(OWNER, title, summary, price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const planner = await make("Meal Planner", "A week of dinners, planned for busy evenings.", "27");
  const grocery = await make("Grocery Lists", "Printable lists for every week of the planner.", "9");
  await make("Batch Cooking Course", "Cook the dinners in two hours on Sunday.", "49");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, planner))!;
  const keep = (session: string, email: unknown = "ana@example.com", version: unknown = ASSIST_REMIND_VERSION) => keepAssistReminder({ store, session, email, version, now });
  is("switched off: no box, nothing kept", [assistReminderShown(store, now), await keep(sessionId())], [false, "closed"]);
  await setAssistReminder(OWNER, { on: true });
  store = (await storeForEmail(OWNER))!;
  is("switched on, the add-on not paid for: still no box", [assistReminderShown(store, now), assistReminderOffered(store, product, now)], [false, false]);
  const plan = { subscriptionId: "sub_AssistRem002", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" };
  await setAssistantPlan(OWNER, plan);
  store = (await storeForEmail(OWNER))!;
  is("paid for, but no postal address: no box, and nothing kept (the studio says why)", [assistReminderShown(store, now), await keep(sessionId())], [false, "closed"]);
  await setRecovery(OWNER, { enabled: false, address: ADDRESS, asks: true });
  store = (await storeForEmail(OWNER))!;
  is("with the address: the box is offered on a product's checkout", [assistReminderShown(store, now), assistReminderOffered(store, product, now)], [true, true]);
  assistantWindow(plan, now / 1000)!;

  const left = (id: string, over: Record<string, unknown> = {}) => {
    sessions[id] = { id, object: "checkout.session", status: "expired", payment_status: "unpaid", created: nowS, expires_at: nowS + 3_600, consent: null, customer_details: null, metadata: { store: "ovenshop", product: planner }, ...over };
  };


  model = { line: "Printable lists for every week of the planner." };
  for (const [label, reply, expected] of [
    ["a word", ["many"], ["failed", 0, 0]],
    ["empty string", [""], ["failed", 0, 0]],
    ["whitespace", [" "], ["failed", 0, 0]],
    ["hex zero", ["0x0"], ["failed", 0, 0]],
    ["canonical zero", ["0"], ["sent", 1, 1]],
    ["confirmed absent", [null], ["sent", 1, 1]],
  ] as [string, unknown[], unknown[]][]) {
    const unread = sessionId();
    await keep(unread, `counter${unread.slice(-2)}@example.com`);
    left(unread, { metadata: { store: "ovenshop", product: grocery } });
    const original = redis.pipeline;
    redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:allow:email:") ? [...reply] : original(commands);
    const before = [emails.length, asked.length];
    let outcome: unknown;
    try { outcome = await remindFromConsent(store, unread, later); }
    finally { redis.pipeline = original; }
    const observed = [outcome, emails.length-before[0], asked.length-before[1]];
    console.log(JSON.stringify({label, reply, observed, expected, modelJsonBytes: asked.length>before[1]?Buffer.byteLength(JSON.stringify(asked.at(-1))):0, mailViewJsonBytes: emails.length>before[0]?Buffer.byteLength(JSON.stringify(emails.at(-1))):0}));
    is(`unread count boundary: ${label}`, observed, expected);
  }
}
main().then(done).catch(error=>{console.error(error);process.exitCode=1});
