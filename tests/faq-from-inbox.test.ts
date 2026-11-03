/**
 * 630 [HN6](32): a visitor's question answered in the inbox, put on the
 * store page's questions in one step, without saying who asked.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { FAQ_ADD_WORDS, faqAddition, faqDraft, withoutWhoAsked } from "@/lib/faq-from-inbox";
import { MAX_FAQ, MAX_FAQ_A, MAX_FAQ_Q } from "@/lib/store-faq";
import { addFaq, claimHandle, setFaq, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/faq/route";
import { FaqFromInbox } from "@/components/faq-from-inbox";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Who asked is taken out");
  const cleaned = withoutWhoAsked("Hi, I'm Ana Souza (ana.souza@example.com, +55 85 99876-5432). Does the course have subtitles? See https://x.example/a", "Ana Souza");
  is("name, address, phone and link go", /Ana|Souza|@|99876|https/.test(cleaned.text), false);
  is("the question stays", cleaned.text.includes("Does the course have subtitles?"), true);
  is("it says something was taken out", cleaned.cut, true);
  is("a name inside another word stays (whole words only)", withoutWhoAsked("Is Banana Bread included?", "Ana").text, "Is Banana Bread included?");
  is("short name parts are left (too likely to be words)", withoutWhoAsked("Can I pay by card?", "I Li").text, "Can I pay by card?");
  is("nothing to take out, nothing said", withoutWhoAsked("How do files arrive?", "Bo Chen").cut, false);
  is("any case of the name", withoutWhoAsked("MARIA here: when does it start?", "Maria").text, "here: when does it start?");

  part("The draft: the latest answer and the question just before it");
  const thread = [
    { from: "visitor" as const, text: "Hello" },
    { from: "store" as const, text: "Hi! How can I help?" },
    { from: "visitor" as const, text: "Thanks, I'm Pia." },
    { from: "visitor" as const, text: "Do you ship\nto Canada?" },
    { from: "store" as const, text: "Yes, Pia, we ship to Canada in 5 to 8 days." },
  ];
  is("question on one line, answer as written, name gone", faqDraft(thread, "Pia Kahn"), { q: "Do you ship to Canada?", a: "Yes, we ship to Canada in 5 to 8 days.", cut: true });
  is("not answered yet: no draft", faqDraft([{ from: "visitor", text: "Any discount?" }], "X"), null);
  is("only the store wrote: no draft", faqDraft([{ from: "store", text: "Welcome" }], "X"), null);
  is("a question that was only an address: no draft", faqDraft([{ from: "visitor", text: "me@example.com" }, { from: "store", text: "Thanks" }], "X"), null);

  part("Adding to the store's questions");
  const one = [{ q: "How do files arrive?", a: "By email." }];
  is("added at the end", faqAddition(one, { q: " Do you ship  to Canada? ", a: "Yes." }), { ok: true, faq: [...one, { q: "Do you ship to Canada?", a: "Yes." }] });
  is("both halves needed", [faqAddition(one, { q: "Q?", a: " " }), faqAddition(one, null), faqAddition(one, [])].map((r) => r.ok || r.reason), ["empty", "empty", "empty"]);
  is("too long is refused, never cut", [faqAddition(one, { q: "x".repeat(MAX_FAQ_Q + 1), a: "a" }), faqAddition(one, { q: "q", a: "a".repeat(MAX_FAQ_A + 1) })].map((r) => r.ok || r.reason), ["long", "long"]);
  is("the longest that fits is kept whole", faqAddition([], { q: "q".repeat(MAX_FAQ_Q), a: "a".repeat(MAX_FAQ_A) }).ok, true);
  const full = Array.from({ length: MAX_FAQ }, (_, i) => ({ q: `Question ${i}?`, a: "Yes." }));
  is("a full page refuses", faqAddition(full, { q: "One more?", a: "No." }), { ok: false, reason: "full" });
  is("the same question twice refuses, whatever its case", faqAddition(one, { q: "how do FILES arrive?", a: "Other" }), { ok: false, reason: "same" });
  is("every refusal has words for the creator", Object.keys(FAQ_ADD_WORDS).sort(), ["empty", "full", "long", "same"]);

  const OWNER = "faqinbox@example.com";
  await claimHandle(OWNER, "faqinbox", "FAQ Inbox", "");
  await setFaq(OWNER, one);
  is("the store adds it, read and written as one change", await addFaq(OWNER, { q: "Do you ship to Canada?", a: "Yes." }), { ok: true, faq: [...one, { q: "Do you ship to Canada?", a: "Yes." }] });
  is("and keeps it", (await storeForEmail(OWNER))!.faq.length, 2);
  is("a refusal changes nothing", [await addFaq(OWNER, { q: "Do you ship to Canada?", a: "Again" }), (await storeForEmail(OWNER))!.faq.length], [{ ok: false, reason: "same" }, 2]);
  is("no store, refused", await addFaq("nobody@example.com", { q: "Q?", a: "A" }), { ok: false, reason: "none" });

  part("Through the route");
  const session = await openSession(OWNER);
  const call = async (body: unknown, signedIn = true) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/faq", { method: "POST", headers: { "content-type": "application/json", ...(signedIn ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  is("signed out, refused", (await call({ add: { q: "Refunds?", a: "Within 14 days." } }, false)).body.ok, false);
  const added = await call({ add: { q: "Refunds?", a: "Within 14 days." } });
  is("added, with the list as kept", [added.status, added.body.ok, added.body.faq.at(-1)], [200, true, { q: "Refunds?", a: "Within 14 days." }]);
  const again = await call({ add: { q: "Refunds?", a: "Again" } });
  is("a refusal says why", [again.status, again.body.error], [400, "same"]);
  is("saving the whole list still works", (await call({ items: one })).body.faq, one);

  part("In the inbox");
  const render = (room: number) => renderToStaticMarkup(createElement(FaqFromInbox, { messages: thread, name: "Pia Kahn", room, studioHref: "/studio?store=faqinbox" }));
  const html = render(3);
  is("a closed disclosure, opened by the creator", /<details[^>]*data-faq-from-inbox/.test(html) && !/<details[^>]*open/.test(html) && html.includes("<summary"), true);
  is("the words come ready to check", html.includes(">Do you ship to Canada?</textarea>") && html.includes("Yes, we ship to Canada in 5 to 8 days."), true);
  is("it says what was taken out and asks to check", html.includes("Their name, email addresses, links and phone numbers were taken out.") && html.includes("change anything that could say who asked"), true);
  is("each field is labelled and tied to its count", (html.match(/<label/g) ?? []).length === 2 && /aria-describedby="[^"]*-q"/.test(html) && html.includes(`of ${MAX_FAQ_Q} characters`), true);
  is("nothing is published on its own: one button", (html.match(/type="submit"/g) ?? []).length === 1 && html.includes("Publish on my store page"), true);
  is("a full page says so instead of a form", render(0).includes(FAQ_ADD_WORDS.full.replace(/"/g, "&quot;")) && !render(0).includes("<form"), true);
  is("nothing to offer when nothing was answered", renderToStaticMarkup(createElement(FaqFromInbox, { messages: [{ from: "visitor", text: "Hi?" }], name: "", room: 3, studioHref: "/studio" })), "");
  const inbox = readFileSync("components/inbox-studio.tsx", "utf8");
  const page = readFileSync("app/studio/inbox/page.tsx", "utf8");
  is("shown only to whoever may edit the store page", page.includes('faq={can(view.role, "page") ?'), true);
  is("drawn under the conversation, fresh for each one", inbox.includes("<FaqFromInbox key={`${c.id}-${thread.messages.length}`}"), true);

  done();
}

void main();
