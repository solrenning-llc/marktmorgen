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
import { NO_ANSWER, SupportHandoff, StudioHelp } from "@/components/studio-help";
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
  supportWaitWords,
} from "@/lib/help-support";
import { paidPeriod } from "./billing-period-fixture";
import { limitResetSeconds } from "@/lib/request-guard";
import { advance, store as redis } from "./redis-stub";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Sent = { to: string[] | string; subject: string; text: string; reply_to?: string | string[] };
const sent: { body: Sent; key: string | null }[] = [];
/** Which sends fail, counted from the next one: "all", or the 1-based numbers of the calls that fail. */
let failing: "none" | "all" | number[] = "none";
let calls = 0;
/** The signed-in creator a page's own relative requests are sent as, and what /api/store/help answers. */
let pageCookie = "";
let helpAnswer: { status: number; body: unknown } = { status: 502, body: { ok: false, error: "failed" } };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/")) {
    if (input === "/api/store/help") return new Response(JSON.stringify(helpAnswer.body), { status: helpAnswer.status });
    if (input === "/api/store/help/support") {
      const headers = new Headers(init?.headers);
      headers.set("cookie", pageCookie);
      return POST(new NextRequest(`https://marktmorgen.com${input}`, { method: "POST", headers, body: init?.body as string }));
    }
    throw new Error(`unexpected page request ${input}`);
  }
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    calls += 1;
    if (failing === "all" || (Array.isArray(failing) && failing.includes(calls))) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const headers = new Headers(init?.headers);
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, key: headers.get("Idempotency-Key") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let countLost = false;
let waitLost = false;
redis.pipeline = (async (batch: Command[]) => {
  if (countLost && batch.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:rl:help-support:"))) throw new Error("synthetic Redis timeout");
  if (waitLost && batch.some((c) => c[0] === "TTL")) throw new Error("synthetic Redis timeout");
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
  is("the next one: 429", [busy.status, busy.data.error], [429, "busy"]);
  const waited = busy.data.retryInSeconds as number;
  is("it says when, from the counter the first request opened: within the day, never more", waited > 86_000 && waited <= 86_400, true);
  is("in words", String(busy.data.words), `Your store has sent ${SUPPORT_PER_DAY} requests to support in the last 24 hours, the most a day. You can send again in 24 hours. Or write to support@marktmorgen.com.`);
  advance(20 * 3_600_000 + 60_000);
  const later = await send(cookie, { text: "One more question for today." });
  is("twenty hours on, still refused, and the wait is what is left, rounded up", [later.status, later.data.retryInSeconds, String(later.data.words).includes("You can send again in 4 hours.")], [429, 86_400 - 72_060, true]);
  waitLost = true;
  const noWait = await send(cookie, { text: "One more question for today." });
  waitLost = false;
  is("a wait that cannot be read is the window's own bound, never 'now'", [noWait.status, noWait.data.retryInSeconds, String(noWait.data.words).includes("You can send again within 24 hours.")], [429, null, true]);
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
  is("502, nothing said sent", [down.status, down.data.error, "value" in down.data], [502, "unsent", false]);
  is("no email", sent.length, 0);
  calls = 0;
  failing = [2];
  const noCopy = await send(otherCookie, { text: "A question whose copy is lost." });
  failing = "none";
  is("sent, with the copy said missing", [noCopy.status, (noCopy.data.value as { copied: boolean }).copied], [200, false]);
  is("only the inbox got it", sent.map((s) => recipients(s.body)), ["support@marktmorgen.com"]);

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

  part("The wait read from the counter: none for a counter that is not there");
  is("no counter (TTL -2) is no wait known, never 'now'", await limitResetSeconds("help-support", "a-store-that-never-sent"), null);

  part("The wait in words: rounded up, so never earlier than true");
  is("each", [null, 0, -2, 30, 60, 61, 3_599, 3_600, 3_601, 86_400].map(supportWaitWords), [
    "You can send again within 24 hours.", "You can send again within 24 hours.", "You can send again within 24 hours.",
    "You can send again in a minute.", "You can send again in a minute.", "You can send again in 2 minutes.", "You can send again in 60 minutes.",
    "You can send again in an hour.", "You can send again in 2 hours.", "You can send again in 24 hours.",
  ]);

  part("When the help gives no answer, a person can still be asked, about that same question");
  (globalThis as { window?: unknown }).window = { location: { pathname: "/studio" } };
  const helpBox = await mount(StudioHelp, { left: 10 });
  const input = find(helpBox.tree(), (n) => n.type === "input")[0];
  (input.props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "How do I sell in yen?" } });
  await helpBox.settle();
  const submit = () => (find(helpBox.tree(), (n) => n.type === "form")[0].props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
  await submit();
  await helpBox.settle();
  const offered = find(helpBox.tree(), (n) => n.type === SupportHandoff);
  is("the help said it had no answer", texts(helpBox.tree()).join("").includes("No answer just now."), true);
  is("and offers support, with the question asked and no answer invented", offered.map((n) => [n.props?.question, n.props?.answer]), [["How do I sell in yen?", NO_ANSWER]]);
  helpAnswer = { status: 200, body: { ok: true, value: { answer: "Open Products.", sources: [] }, left: 9 } };
  await submit();
  await helpBox.settle();
  is("an answer replaces it with the answer's own offer", find(helpBox.tree(), (n) => n.type === SupportHandoff).map((n) => [n.props?.question, n.props?.answer]), [["How do I sell in yen?", "Open Products."]]);

  part("At the cap, the form itself says when to try again");
  const third = "help-support-c@example.test";
  pageCookie = await creator(third, "helpsupportc");
  for (let i = 0; i < SUPPORT_PER_DAY; i++) await send(pageCookie, { text: `Question number ${i} of the day.` });
  const box = await mount(SupportHandoff, { question: "How do I sell in yen?", answer: NO_ANSWER });
  const opener = find(box.tree(), (n) => n.type === "button" && texts(n.props?.children).includes("Send this to support"))[0];
  (opener.props?.onClick as () => void)();
  await box.settle();
  sent.length = 0;
  await (find(box.tree(), (n) => n.type === "form")[0].props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
  await box.settle();
  const said = find(box.tree(), (n) => n.props?.role === "status").map((n) => texts(n.props?.children).join(""));
  is("the refusal with the wait, in a status region", said.some((t) => t.includes("You can send again in 24 hours.")), true);
  // A refusal of the studio's own guard (lib/studio-route.ts) answers with `message`: it is said as written, never as "could not send".
  const guardBox = await mount(SupportHandoff, { question: "How do I sell in yen?", answer: NO_ANSWER, startOpen: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "studio_used", message: "Too many of these today. Try again tomorrow, or write to support." }), { status: 429 })) as typeof fetch;
  await (find(guardBox.tree(), (n) => n.type === "form")[0].props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
  await guardBox.settle();
  globalThis.fetch = realFetch;
  is("the guard's own sentence is shown", find(guardBox.tree(), (n) => n.props?.role === "status").map((n) => texts(n.props?.children).join("")), ["Too many of these today. Try again tomorrow, or write to support."]);
  is("nothing sent, and nothing said sent", [sent.length, find(box.tree(), (n) => n.props?.["data-support-sent"] !== undefined).length], [0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
