/**
 * Complement WG (MQ2 group c) of 491 [PP2], unit 1: "Send this to support" from the studio's "How do I…?", through
 * the real route (app/api/store/help/support), the real store record and the real form, against the in-memory Redis
 * and a stubbed email provider. Synthetic stores only. Each part fails on the wrong behavior it names: an email
 * with more than the four facts and the creator's words, a plan or screen taken from the request, a link written
 * into the email from outside the studio, a request sent past the day's cap, an unreadable count taken for room,
 * a request said sent when the inbox's email failed, a second email for one request, and a form that sends before
 * the creator can read and change the words.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/help/support/route";
import { SupportHandoff, StudioHelp } from "@/components/studio-help";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription } from "@/lib/store";
import {
  MAX_SUPPORT_TEXT,
  SUPPORT_NUMBER,
  SUPPORT_PER_DAY,
  cleanSupportText,
  supportDraft,
  supportNumber,
  supportScreen,
} from "@/lib/help-support";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Sent = { to: string[] | string; subject: string; text: string; reply_to?: string | string[] };
const sent: { body: Sent; key: string | null }[] = [];
/** Which sends fail, counted from the next one: "all", or the 1-based numbers of the calls that fail. */
let failing: "none" | "all" | number[] = "none";
/** The 1-based calls the provider accepts and then loses the reply of: taken, but the sender hears an error. */
let lostReply: number[] = [];
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    calls += 1;
    if (failing === "all" || (Array.isArray(failing) && failing.includes(calls))) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const headers = new Headers(init?.headers);
    const key = headers.get("Idempotency-Key");
    // A provider honoring its idempotency key: the same key again is the same email, not a second one.
    if (key && sent.some((s) => s.key === key)) return new Response(JSON.stringify({ id: "email_again" }));
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, key });
    if (lostReply.includes(calls)) throw new Error("synthetic lost reply");
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let countLost = false;
redis.pipeline = (async (batch: Command[]) => {
  if (countLost && batch.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:rl:help-support:"))) throw new Error("synthetic Redis timeout");
  return real(batch);
}) as typeof redis.pipeline;

const url = "https://marktmorgen.com/api/store/help/support";

async function creator(email: string, handle: string) {
  await claimHandle(email, handle, "Synthetic shop", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return `${SESSION_COOKIE}=${await openSession(email)}`;
}

async function send(cookie: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await POST(new NextRequest(url, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

const recipients = (s: Sent) => (Array.isArray(s.to) ? s.to : [s.to]).join(",");
const replyOf = (s: Sent) => (Array.isArray(s.reply_to) ? s.reply_to.join(",") : s.reply_to ?? "");

async function main() {
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  part("The request's number: 40 random bits, eight symbols, none of I, L, O or U");
  is("all zero bits", supportNumber(new Uint8Array([0, 0, 0, 0, 0])), "SR-0000-0000");
  is("all one bits", supportNumber(new Uint8Array([255, 255, 255, 255, 255])), "SR-ZZZZ-ZZZZ");
  is("five bits at a time, in order", supportNumber(new Uint8Array([0x08, 0x42, 0x10, 0x84, 0x21])), "SR-1111-1111");
  is("the last symbol comes from the last five bits", supportNumber(new Uint8Array([0, 0, 0, 0, 0x1f])), "SR-0000-000Z");
  const fresh = Array.from({ length: 200 }, () => supportNumber());
  is("fresh numbers have the shape", fresh.every((n) => SUPPORT_NUMBER.test(n)), true);
  is("and are not repeated", new Set(fresh).size, fresh.length);

  part("What is sent is cleaned, and the screen is only ever a studio address");
  is("control and invisible characters go; new lines and tabs stay", cleanSupportText("  a\u0000b‮c​d\r\ne\tf  "), "abcd\ne\tf");
  is("a non-string is nothing", cleanSupportText(42), "");
  is("a studio screen is kept, without its query", supportScreen("/studio/products?store=abc#x"), "/studio/products");
  is("anything else is 'the studio'", ["https://evil.test/studio", "/@someone", "//evil.test", "/studio/../admin", "/studio/A B", 7].map(supportScreen), Array(6).fill("the studio"));
  const draft = supportDraft("How do I add a coupon?", "Open Products, then Coupons.");
  is("the draft is the question and the answer, with room for more", draft, "My question: How do I add a coupon?\n\nThe answer I got: Open Products, then Coupons.\n\nWhat I still need: ");

  const email = "help-support-a@example.test";
  const cookie = await creator(email, "helpsupporta");

  part("Signed out, nothing is sent");
  const out = await send(null, { text: "I need help with my coupons please." });
  is("401", out.status, 401);
  is("no email", sent.length, 0);

  part("One press sends one request to the support inbox, with the four facts and the creator's words only");
  const words = `${draft}I still cannot find the Coupons tab.`;
  const first = await send(cookie, { text: words, screen: "/studio/products", tier: "scale", plan: "scale", handle: "someoneelse", buyers: ["buyer@example.test"] });
  is("200", first.status, 200);
  const value = first.data.value as { number: string; copied: boolean };
  is("a number of the right shape", SUPPORT_NUMBER.test(value.number), true);
  is("the copy went", value.copied, true);
  is("two emails, no more", sent.length, 2);
  const [inbox, copy] = [sent[0], sent[1]];
  is("the first goes to the support inbox", recipients(inbox.body), "support@marktmorgen.com");
  is("and answers go to the person who sent it", replyOf(inbox.body), email);
  is("its subject names the number and the store", inbox.body.subject, `Support request ${value.number} from @helpsupporta`);
  is("its text is exactly the facts and the creator's words: plan and store read on the server, nothing else attached", inbox.body.text, [
    `Request ${value.number}, sent from the studio's help.`,
    "Store: @helpsupporta (https://marktmorgen.com/@helpsupporta)",
    "Plan: Store",
    "Screen: /studio/products",
    `From: ${email}`,
    "",
    words,
  ].join("\n"));
  is("its own idempotency key", inbox.key, `help-support-${value.number}`);
  is("the copy goes to the person who sent it", recipients(copy.body), email);
  is("and replies to it reach support", replyOf(copy.body), "support@marktmorgen.com");
  is("the copy names the number and repeats the words", [copy.body.subject.includes(value.number), copy.body.text.includes(words)], [true, true]);
  is("the copy has a key of its own", copy.key, `help-support-${value.number}-copy`);

  part("A screen from outside the studio is never written into the email");
  sent.length = 0;
  const outside = await send(cookie, { text: "Something is wrong with my page.", screen: "https://evil.test/phish" });
  is("sent", outside.status, 200);
  is("as 'the studio'", sent[0].body.text.includes("Screen: the studio\n"), true);
  is("and the link is nowhere", sent.some((s) => s.body.text.includes("evil.test")), false);

  part("Too little or too much is refused before anything is counted or sent");
  sent.length = 0;
  const short = await send(cookie, { text: "  help  " });
  is("too short: 400", [short.status, short.data.error], [400, "short"]);
  const long = await send(cookie, { text: "x".repeat(MAX_SUPPORT_TEXT + 1) });
  is("too long: 413", [long.status, long.data.error], [413, "long"]);
  is("no email for either", sent.length, 0);

  part("At most SUPPORT_PER_DAY requests a store a day, counted before sending");
  // Two were sent above; three more fill the day.
  for (let i = 0; i < SUPPORT_PER_DAY - 2; i++) is(`request ${i + 3} goes`, (await send(cookie, { text: `Another question number ${i}.` })).status, 200);
  sent.length = 0;
  const busy = await send(cookie, { text: "One more question for today." });
  is("the next one: 429, said in words", [busy.status, busy.data.error, String(busy.data.words).includes("Try again tomorrow")], [429, "busy", true]);
  is("and nothing is sent", sent.length, 0);

  part("A count that cannot be read is never room: 503 and nothing sent");
  const other = "help-support-b@example.test";
  const otherCookie = await creator(other, "helpsupportb");
  countLost = true;
  const lost = await send(otherCookie, { text: "A question while the count is lost." });
  countLost = false;
  is("503", [lost.status, lost.data.error], [503, "unknown"]);
  is("no email", sent.length, 0);

  part("An inbox email that failed is never said sent; a lost copy is said");
  calls = 0;
  failing = "all";
  const down = await send(otherCookie, { text: "A question while email is down." });
  is("502, nothing said sent", [down.status, down.data.error, "value" in down.data], [502, "unconfirmed", false]);
  is("no email", sent.length, 0);
  calls = 0;
  failing = [2];
  const noCopy = await send(otherCookie, { text: "A question whose copy is lost." });
  failing = "none";
  is("sent, with the copy said missing", [noCopy.status, (noCopy.data.value as { copied: boolean }).copied], [200, false]);
  is("only the inbox got it", sent.map((s) => recipients(s.body)), ["support@marktmorgen.com"]);

  part("An inbox email whose answer was lost is never said unsent, and sending again is the same request (Codex U, MEDIUM)");
  sent.length = 0;
  calls = 0;
  lostReply = [1];
  const number = "SR-7K3M-Q9TB";
  const unsure = await send(otherCookie, { text: "A question whose answer is lost.", number });
  lostReply = [];
  is("taken by the provider", sent.map((s) => recipients(s.body)), ["support@marktmorgen.com"]);
  is("so the words never say nothing was sent", String(unsure.data.words).includes("nothing was sent"), false);
  is("they say it could not be confirmed, with the request's number", [unsure.status, unsure.data.error, String(unsure.data.words).includes("could not confirm"), String(unsure.data.words).includes(number)], [502, "unconfirmed", true, true]);
  const again = await send(otherCookie, { text: "A question whose answer is lost.", number });
  is("sending again: the same number", [again.status, (again.data.value as { number: string }).number], [200, number]);
  is("and support has one request, under one key", [sent.filter((s) => recipients(s.body) === "support@marktmorgen.com").length, new Set(sent.filter((s) => recipients(s.body) === "support@marktmorgen.com").map((s) => s.key)).size], [1, 1]);
  const bad = await send(otherCookie, { text: "A question with a made-up number.", number: "help-support-x" });
  is("a number not in the shape is never used: a fresh one", [bad.status, SUPPORT_NUMBER.test((bad.data.value as { number: string }).number), (bad.data.value as { number: string }).number === "help-support-x"], [200, true, false]);
  is("each key is scoped to the store, so a number never reaches another store's request", sent.every((s) => !s.key || s.key.includes(":")), true);
  const form = (await import("node:fs")).readFileSync("components/studio-help.tsx", "utf8");
  is("the form keeps one number for every try of the same request", [form.includes("const [number] = useState(() => supportNumberOf(crypto.getRandomValues(new Uint8Array(5))));"), form.includes("JSON.stringify({ text: draft, screen: window.location.pathname, number })")], [true, true]);
  is("and a lost answer in the browser is never said unsent", form.includes("nothing was sent"), false);

  part("The form: nothing is sent before the creator reads, can change and sends the words");
  const help = renderToStaticMarkup(createElement(StudioHelp, { left: 10 }));
  is("before an answer there is no support button", help.includes("Send this to support"), false);
  const closed = renderToStaticMarkup(createElement(SupportHandoff, { question: "How do I add a coupon?", answer: "Open Products." }));
  is("after an answer, one button opens it", [closed.includes(">Send this to support</button>"), closed.includes("<textarea")], [true, false]);
  const open = renderToStaticMarkup(createElement(SupportHandoff, { question: "How do I add a coupon?", answer: "Open Products.", startOpen: true }));
  const field = /<textarea[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/.exec(open);
  is("a text field the creator can change, filled with the draft", field?.[2], supportDraft("How do I add a coupon?", "Open Products.").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  is("named by a visible label", open.includes(`<label for="${field?.[1]}"`), true);
  is("bounded like the server", open.includes(`maxLength="${MAX_SUPPORT_TEXT}"`), true);
  is("it says what is added and that no buyer's data goes", [open.includes("We add your store, your plan and this screen."), open.includes("Nothing about your buyers is sent.")], [true, true]);
  is("and the send is a button the creator presses, with a way back", [open.includes(">Send to support</button>"), open.includes(">Cancel</button>")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
