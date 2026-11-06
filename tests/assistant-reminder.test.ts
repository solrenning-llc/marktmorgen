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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setAssistReminder, setAssistantPlan, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { takeAllowance } from "@/lib/store-allowance";
import { remindAbandoned, stopReminders } from "@/lib/checkout-recovery";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { HELP_SECTIONS } from "@/lib/help-content";
import { PERSON_DATA } from "@/lib/person-data";
import { pool } from "@/lib/store-assistant";
import {
  ADD_ON_ROOM_CENTS,
  ASSISTANT_MESSAGE_COMMANDS,
  ASSISTANT_MESSAGES_MONTHLY,
  ASSISTANT_MODEL,
  ASSISTANT_PRICE_CENTS,
  assistantMeetsFloor,
  assistantMessageExtraMicroUsd,
  assistantMessageWorstMicroUsd,
  assistantMonthWorst,
  assistantPoolMicroUsd,
  assistantSettledMicroUsd,
  assistantWindow,
} from "@/lib/store-assistant-rules";
import { receivingOf } from "@/lib/receiving-costs";
import { assistantTaxFixture, ASSISTANT_TAX_TEST_NOW } from "./store-assistant-tax-fixture";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { ASSIST_REMIND_KEEP_SECONDS, ASSIST_REMIND_OUTPUT_TOKENS, ASSIST_REMIND_VERSION, neutralLine, parseAssistReminder, withinReminderReply } from "@/lib/assistant-reminder-rules";
import { ASSIST_REMIND_SYSTEM, assistReminderOffered, forgetAssistReminderPerson, assistReminderShown, keepAssistReminder, remindFromConsent, sendAssistReminders } from "@/lib/assistant-reminder";
import { ASSIST_REMINDER_WORDS } from "@/lib/buyer-words/assistant-reminder";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
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
let paidList: Record<string, unknown>[] = [];
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
const poolOf = async (statsId: string, id: string) => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:assist:pool:${statsId}:${id}`]]);
  const flat = (Array.isArray(raw) ? raw : []).map(String);
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
};

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  /** When a reminder is due: an hour for the checkout to close, an hour more. */
  const later = now + 2 * 3_600_000 + 60_000;

  part("The rules");
  is("off on a store written before it existed", [parseAssistReminder(undefined), parseAssistReminder({ on: "yes" }), parseAssistReminder({ on: true })], [{ on: false }, { on: false }, { on: true }]);
  const facts = "- Meal Planner\nHow it is delivered: a file\nWhat it is: A week of dinners, planned for busy evenings.";
  is(
    "a neutral line from the products passes; a number, a link, an exclamation, a deal or pressure never",
    [
      neutralLine("A week of dinners, planned for busy evenings.", facts),
      neutralLine("Only 3 left at this price.", facts),
      neutralLine("See https://example.com for more.", facts),
      neutralLine("Your dinners, planned!", facts),
      neutralLine("Use the code and get a discount.", facts),
      neutralLine("Hurry, before it's gone.", facts),
      neutralLine("Plan dinners now, while it lasts.", facts),
      neutralLine("x".repeat(400), facts),
      neutralLine(7, facts),
    ],
    ["A week of dinners, planned for busy evenings.", "", "", "", "", "", "", "", ""],
  );
  is("inside what one chat reply is priced at: products read, answer length, commands", withinReminderReply(ASSISTANT_MESSAGE_COMMANDS), true);
  is(
    "its model request at every cap holds no more than a chat message's worst",
    aiRequestHoldMicroUsd(ASSISTANT_MODEL, { inputBytes: 24_576, blocks: 1, media: null, maxTokens: ASSIST_REMIND_OUTPUT_TOKENS })! + assistantMessageExtraMicroUsd() <= assistantMessageWorstMicroUsd(),
    true,
  );
  const month = assistantMonthWorst();
  const taxInput=assistantTaxFixture(),reviewed=assistantMonthWorst(700,taxInput,ASSISTANT_TAX_TEST_NOW);
  is("unknown tax evidence does not fabricate tax, room or an approval", [month.review.taxesCeilingCents,month.allowedCents,month.roomCents,assistantMeetsFloor()], [null,null,null,false]);
  is("the add-on's non-tax month and rights stay unchanged", month.totalCents, receivingOf(ASSISTANT_PRICE_CENTS).totalCents + Math.ceil((ASSISTANT_MESSAGES_MONTHLY * assistantMessageWorstMicroUsd()) / 10_000));
  is("a synthetic complete review exercises the unchanged room without opening sales", [assistantMeetsFloor(700,taxInput,ASSISTANT_TAX_TEST_NOW),reviewed.roomCents!==null&&reviewed.roomCents>=ADD_ON_ROOM_CENTS,ASSISTANT_ON_SALE], [true,true,false]);

  part("Off until switched on, paid for and with a postal address");
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
  const course = await make("Batch Cooking Course", "Cook the dinners in two hours on Sunday.", "49");
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
  const window = assistantWindow(plan, now / 1000)!;

  part("The yes is kept only as given, word for word");
  is("an old page's version is not this sentence", await keep(sessionId(), "ana@example.com", "assist-remind-0"), "version");
  is("no address, or one that is not one: nothing kept", [await keep(sessionId(), ""), await keep(sessionId(), "not-an-address")], ["email", "email"]);
  const first = sessionId();
  is("checked, with an address: kept", await keep(first, " Ana@Example.com "), "kept");
  const [raw, ttl] = await redis.pipeline([["GET", `nl:assist:remind:${first}`], ["TTL", `nl:assist:remind:${first}`]]);
  const kept = JSON.parse(String(raw)) as Record<string, unknown>;
  is("the address, the exact sentence, its version and when", [kept.e, kept.t, kept.v, kept.at], ["ana@example.com", ASSIST_REMINDER_WORDS.en.box, ASSIST_REMIND_VERSION, now]);
  is("deleted by itself three days after the checkout opened", Number(ttl) > ASSIST_REMIND_KEEP_SECONDS - 60 && Number(ttl) <= ASSIST_REMIND_KEEP_SECONDS && ASSIST_REMIND_KEEP_SECONDS === 3 * 86_400, true);
  const [queue] = await redis.pipeline([["ZRANGEBYSCORE", "nl:assist:remindq", "-inf", "+inf"]]);
  is("the queue never holds an address", JSON.stringify(queue).includes("@"), false);

  // The checkout as Stripe has it once it closed unpaid an hour after opening.
  const left = (id: string, over: Record<string, unknown> = {}) => {
    sessions[id] = { id, object: "checkout.session", status: "expired", payment_status: "unpaid", created: nowS, expires_at: nowS + 3_600, consent: null, customer_details: null, metadata: { store: "ovenshop", product: planner }, ...over };
  };

  part("No email without the box");
  const unasked = sessionId();
  left(unasked);
  is("a checkout left unpaid with no yes kept: nothing", [await remindFromConsent(store, unasked, later), emails.length], ["skip", 0]);
  // Stripe's own consent path, on a store with those reminders on too, leaves a checked checkout to this one.
  await setRecovery(OWNER, { enabled: true, address: ADDRESS, asks: true });
  store = (await storeForEmail(OWNER))!;
  left(first, { consent: { promotions: "opt_in" }, customer_details: { email: "ana@example.com" }, expires_at: nowS - 60 });
  is("Stripe's opt-in reminder skips a checkout whose buyer checked this box", await remindAbandoned(store, sessions[first] as never, nowS), "skip");
  left(first);

  part("One email, when it is due");
  model = { line: "A week of dinners, planned for busy evenings.", usage: { input_tokens: 600, output_tokens: 30 } };
  const before = (await poolOf(store.statsId!, window.id)).spent ?? 0;
  const realNow = Date.now;
  Date.now = () => later;
  const run = await sendAssistReminders(storeForEmailHandle, later + 20_000);
  Date.now = realNow;
  is("the job sends the one that is due", run.sent, 1);
  const mail = emails.at(-1)!;
  is("to the address typed beside the box, with an honest subject", [mail.to, mail.subject], ["ana@example.com", "You left Meal Planner at checkout"]);
  is(
    "the product's page, today's price, the sentence checked and the day, the stop link and the postal address",
    [mail.text.includes(`/p/${planner}`), mail.text.includes("$27"), mail.text.includes(`you checked “${ASSIST_REMINDER_WORDS.en.box}” at checkout on`), /\/unsubscribe\?r=[0-9a-f]{40}/.test(mail.text), mail.text.includes(`Oven Shop · ${ADDRESS}`)],
    [true, true, true, true, true],
  );
  is("a mail app can stop it in one press", [/\/api\/mail\/unsubscribe\?r=[0-9a-f]{40}/.test(mail.headers?.["List-Unsubscribe"] ?? ""), mail.headers?.["List-Unsubscribe-Post"]], [true, "List-Unsubscribe=One-Click"]);
  is("the AI's line, under the label that says so", [mail.text.includes("Written by AI from Oven Shop's own product descriptions:\nA week of dinners, planned for busy evenings.")], [true]);
  is("no urgency, scarcity, countdown or discount in it", /hurry|only \d|left in stock|ends|% off|discount|code|!/i.test(mail.text.replace(/You left/, "")), false);
  const sent = asked.at(-1)!;
  is("asked of the assistant's model, with its own small answer cap", [sent.model, sent.max_tokens, sent.system === ASSIST_REMIND_SYSTEM("Oven Shop", "English")], [ASSISTANT_MODEL, ASSIST_REMIND_OUTPUT_TOKENS, true]);
  is("told only the products, never the buyer or a price", [sent.messages[0].content.includes("Meal Planner"), JSON.stringify(sent).includes("ana@example.com"), sent.messages[0].content.includes("$27")], [true, false, false]);
  const after = await poolOf(store.statsId!, window.id);
  is("one reply of the month's pool, settled at what was billed", [after.held, after.spent - before, after.cap], [0, assistantSettledMicroUsd({ input_tokens: 600, output_tokens: 30 }), assistantPoolMicroUsd()]);

  part("Never twice, never after paying, never after stop");
  const count = emails.length;
  is("the same checkout again: nothing", [await remindFromConsent(store, first, later), emails.length - count], ["skip", 0]);
  const paid = sessionId();
  await keep(paid, "ben@example.com");
  left(paid, { status: "complete", payment_status: "paid", metadata: { store: "ovenshop", product: grocery } });
  is("the checkout was paid: nothing", [await remindFromConsent(store, paid, later), emails.length - count], ["skip", 0]);
  const elsewhere = sessionId();
  await keep(elsewhere, "cy@example.com");
  left(elsewhere, { metadata: { store: "ovenshop", product: grocery } });
  paidList = [{ id: "cs_test_paidelsewhere0001", status: "complete", payment_status: "paid", metadata: { store: "ovenshop", product: grocery } }];
  is("the address paid for it in another checkout since: nothing", [await remindFromConsent(store, elsewhere, later), emails.length - count], ["skip", 0]);
  paidList = [];
  const token = /\/unsubscribe\?r=([0-9a-f]{40})/.exec(mail.text)?.[1] ?? "";
  is("stop pressed", await stopReminders(token), true);
  const afterStop = sessionId();
  await keep(afterStop, "ana@example.com");
  left(afterStop, { metadata: { store: "ovenshop", product: course } });
  is("after stop, another product, another checkout: nothing", [await remindFromConsent(store, afterStop, later), emails.length - count], ["skip", 0]);
  const open = sessionId();
  await keep(open, "dee@example.com");
  left(open, { status: "open", expires_at: Math.floor(later / 1000) + 600 });
  is("still open: not yet, and once more an hour after it closes", [await remindFromConsent(store, open, later), emails.length - count], ["open", 0]);

  part("Deleting the person deletes the yes at once");
  const erased = sessionId();
  await keep(erased, "eve@example.com");
  left(erased, { metadata: { store: "ovenshop", product: course } });
  is("the erasure deletes the yes and its note", await forgetAssistReminderPerson(store.statsId, "Eve@Example.com"), 2);
  const [gone] = await redis.pipeline([["EXISTS", `nl:assist:remind:${erased}`]]);
  is("gone, and nothing sent", [Number(gone), await remindFromConsent(store, erased, later), emails.length - count], [0, "skip", 0]);

  part("The fixed reminder when the AI's line cannot be used");
  const pressure = sessionId();
  await keep(pressure, "fay@example.com");
  left(pressure, { metadata: { store: "ovenshop", product: course } });
  model = { line: "Hurry, only 3 left today!" };
  is("a line that does not hold: sent without it", await remindFromConsent(store, pressure, later), "sent");
  is("no AI label, the plain reminder", [emails.at(-1)!.text.includes("Written by AI"), emails.at(-1)!.text.includes("Batch Cooking Course")], [false, true]);
  const failed = sessionId();
  await keep(failed, "gus@example.com");
  left(failed, { metadata: { store: "ovenshop", product: course } });
  model = { status: 529 };
  const held = (await poolOf(store.statsId!, window.id)).spent;
  is("the model fails: sent without it, and nothing billed is kept", [await remindFromConsent(store, failed, later), emails.at(-1)!.text.includes("Written by AI"), (await poolOf(store.statsId!, window.id)).spent - held], ["sent", false, 0]);
  const spent = sessionId();
  await keep(spent, "hal@example.com");
  left(spent, { metadata: { store: "ovenshop", product: grocery } });
  const left0 = (await poolOf(store.statsId!, window.id));
  await pool("reserve", store.statsId!, window.id, assistantPoolMicroUsd() - (left0.spent ?? 0) - (left0.held ?? 0), assistantPoolMicroUsd());
  model = { line: "Printable lists for every week of the planner." };
  const calls = asked.length;
  is("the month's replies used: sent without it, and no model asked", [await remindFromConsent(store, spent, later), emails.at(-1)!.text.includes("Written by AI"), asked.length - calls], ["sent", false, 0]);

  part("Refused before the model when the store's emails are used, or with no postal address");
  const roomless = sessionId();
  await keep(roomless, "ivy@example.com");
  left(roomless, { metadata: { store: "ovenshop", product: planner } });
  const sentBefore = emails.length;
  await takeAllowance(store, "email", 75 - (emails.length - 0), later);
  is("no email room: not sent", [await remindFromConsent(store, roomless, later), emails.length - sentBefore], ["failed", 0]);
  await setRecovery(OWNER, { enabled: false, address: "", asks: true });
  store = (await storeForEmail(OWNER))!;
  is("no postal address: no box, and a kept yes is not sent", [assistReminderShown(store, now), await remindFromConsent(store, roomless, later)], [false, "skip"]);

  part("What the pages say is the code's");
  const pages = JSON.stringify(FEATURE_PAGES) + JSON.stringify(HELP_SECTIONS);
  is("the feature page and the help describe it", [/one reminder/i.test(pages), pages.includes(ASSIST_REMINDER_WORDS.en.box)], [true, true]);
  const privacy = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ");
  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8").replace(/\s+/g, " ");
  is("the privacy policy says what is kept, sent and for how long", [privacy.includes('id="store-assistant-reminder"'), /three days after the checkout opened/.test(privacy)], [true, true]);
  is("the terms say what the creator is responsible for", terms.includes('id="store-assistant-reminder"'), true);
  is("the registry says how it is deleted", PERSON_DATA.filter((d) => d.file === "lib/assistant-reminder.ts").map((d) => d.how), ["erased"]);
  const words = Object.values(ASSIST_REMINDER_WORDS.en).map((v) => (typeof v === "function" ? v("Shop", "Shop") : v)).join(" ");
  is("in US English, with no urgency, scarcity or invented claims", [/\b(colour|cancelled|centre|tick)\b/i.test(words), /unlimited|hurry|only \d|today only|best/i.test(words)], [false, false]);
  is("every language has every word", Object.values(ASSIST_REMINDER_WORDS).every((l) => Object.keys(l).length === Object.keys(ASSIST_REMINDER_WORDS.en).length), true);
}

/** The job's loader: the store by its handle, as the cron route reads it. */
async function storeForEmailHandle(handle: string) {
  const store = await storeForEmail(OWNER);
  return store && store.handle === handle ? store : null;
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
