/**
 * 639 [GL7](22), unit 2: the creator's business card on the store's contact
 * address (app/[handle]/contact/page.tsx) and its "Save contact" file
 * (app/[handle]/contact/vcard/route.ts), through the real page, route and
 * store, the card itself drawn from components/creator-card-view.tsx. Shown and given only while the card is on; each way to reach the
 * creator a link that says what it is; the file a vCard to save; neither
 * while the store is switched off after a report; each paid for with one of
 * the store's public requests before the card is read, and refused while the
 * store rests (review of #1962); a message sent from the form under the
 * card leads back to the card, by one fixed marker the contact route keeps
 * only as it is (WCAG 2.4.8, 3.2.3; review of #1965, LEVE 2); the words
 * in every language the store can speak.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage, { generateMetadata } from "@/app/[handle]/contact/page";
import { CreatorCardView } from "@/components/creator-card-view";
import { StoreResting } from "@/components/store-resting";
import { GET } from "@/app/[handle]/contact/vcard/route";
import { POST as sendMessage } from "@/app/api/store/contact/route";
import { StoreContactBox } from "@/components/store-contact-box";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { type CreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setContact, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

/** Every element in a page's tree, without drawing it (its server parts that read the request cannot be drawn here). */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elementsOf(element.props.children as ReactNode)];
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "cardpage@example.com";
  await claimHandle(owner, "anapottery", "Ana's Pottery", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_cardpage", subscriptionId: "sub_cardpage", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  // Made at run time, so no number in this file reads as someone's.
  const phone = "+" + "15550104477";
  const card: CreatorCard = { on: true, name: "Ana Souza", title: "Course creator", email: "ana@example.com", phone, website: "https://ana.example.com/", note: "Pottery & glazes" };

  // The page itself: shown, or sent on (its server parts that read the request are not drawn here).
  const open = async (status?: string): Promise<"shown" | { redirect: string }> => {
    try {
      await ContactPage({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve(status ? { status } : {}) });
      return "shown";
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] ?? "" };
      throw error;
    }
  };
  const file = async () => GET(new NextRequest("https://marktmorgen.com/@anapottery/contact/vcard"), { params: Promise.resolve({ handle: "@anapottery" }) });

  part("While the card is off");
  is("the contact address goes to the store, as before", await open(), { redirect: "/@anapottery" });
  is("and there is no file", (await file()).status, 404);
  await saveCreatorCard(store.statsId!, { ...card, on: false }, store);
  is("a card kept but off is not shown", await open(), { redirect: "/@anapottery" });
  is("nor given", (await file()).status, 404);

  part("Turned on: the card");
  await saveCreatorCard(store.statsId!, card, store);
  is("the contact address shows the card", await open(), "shown");
  const draw = (shown: CreatorCard) => renderToStaticMarkup(createElement(CreatorCardView, { card: shown, handle: "anapottery", storeName: "Ana's Pottery", words: CONTACT_WORDS.en.card }));
  const html = draw(card);
  is("a named card with the creator's name as its heading", html.includes('aria-labelledby="card-name"') && html.includes('<h1 id="card-name"') && html.includes("Ana Souza</h1>"), true);
  is("what they do and their line, as typed", html.includes("Course creator") && html.includes("Pottery &amp; glazes"), true);
  is("each way to reach them a link that says what it is", [html.includes("<dt"), html.includes('href="mailto:ana@example.com"'), html.includes(`href="tel:${phone}"`), html.includes('href="https://ana.example.com/"') && html.includes(">ana.example.com</a>")], [true, true, true, true]);
  is("Save contact, explained beside it", html.includes('href="/@anapottery/contact/vcard"') && html.includes('aria-describedby="card-save-hint"') && html.includes("Adds this card to the contacts on your phone or computer."), true);
  is("every link tall enough to tap, the way back to the store too (2.5.5)", (html.match(/<a [^>]*>/g) ?? []).map((tag) => tag.includes("min-h-11")), [true, true, true, true, true]);
  is("the notice's way back is tall enough to tap too", readFileSync("app/[handle]/contact/page.tsx", "utf8").includes('#contact"}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">'), true);
  is("the way back to the store", html.includes("Visit Ana&#x27;s Pottery") || html.includes("Visit Ana's Pottery"), true);
  const bare = draw({ ...card, title: "", email: "", phone: "", website: "", note: "" });
  is("only what was filled in", !bare.includes("<dl") && !bare.includes("mailto:") && bare.includes("Ana Souza</h1>"), true);
  is("a message's notice still shows on the same address", await open("sent"), "shown");
  is("under the card, the store's own contact form when it is on, to leave one's details", readFileSync("app/[handle]/contact/page.tsx", "utf8").includes('{contactOpen(store) ? <StoreContactBox store={store} from="card" /> : null}'), true);
  is("the page reads the card only with no message's notice", readFileSync("app/[handle]/contact/page.tsx", "utf8").includes("if (!card?.on) redirect(`/@${store.handle}`);"), true);

  part("The file to save");
  await saveCreatorCard(store.statsId!, card, store);
  const response = await file();
  const text = await response.text();
  is("a vCard, saved as a file named for the card, never kept in a cache", [response.status, response.headers.get("content-type"), response.headers.get("content-disposition"), response.headers.get("cache-control")], [200, "text/vcard; charset=utf-8", 'attachment; filename="ana-souza.vcf"', "no-store"]);
  is("with the card and the store's page", text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ana Souza\r\n") && text.includes("URL:https://marktmorgen.com/@anapottery\r\n") && text.endsWith("END:VCARD\r\n"), true);
  is("not for a store that does not exist", (await GET(new NextRequest("https://marktmorgen.com/@nobody/contact/vcard"), { params: Promise.resolve({ handle: "@nobody" }) })).status, 404);

  part("A store switched off after a report (lib/takedown.ts)");
  await saveCreatorCard(store.statsId!, card, store);
  await noteTakedown(owner, null, true);
  is("the file is not given", [(await file()).status, (await file()).headers.get("cache-control")], [404, "no-store"]);
  const resting = (await ContactPage({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve({}) })) as { type?: unknown; props?: { suspended?: boolean } } | undefined;
  is("the page says the store is not available, as the store page does, and shows no card", [resting?.type === StoreResting, resting?.props?.suspended], [true, true]);
  is("its title does not name the creator", String((await generateMetadata({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve({}) })).title).includes("Ana Souza"), false);
  await noteTakedown(owner, null, false);
  is("switched back on, the file is given again", (await file()).status, 200);

  part("Paid for before the card is read (review of #1962)");
  // Every command the store's data is sent, to see what each way in counts and reads.
  const base = redis.pipeline.bind(redis);
  const sent: (string | number)[][] = [];
  redis.pipeline = async (batch) => { sent.push(...batch); return base(batch); };
  const counted = async (run: () => Promise<unknown>) => {
    sent.length = 0;
    await run();
    const taken = sent.filter((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")).map((c) => Number(c[2]));
    const firstRead = sent.findIndex((c) => c[0] === "GET" && String(c[1]).startsWith("nl:vcard:"));
    const firstTaken = sent.findIndex((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:"));
    return { taken, paidFirst: firstTaken >= 0 && firstTaken < firstRead };
  };
  const meta = () => generateMetadata({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve({}) });
  try {
    is("the file takes one of the store's public requests, before the card is read", await counted(file), { taken: [1], paidFirst: true });
    is("the page takes one, before the card is read", await counted(open), { taken: [1], paidFirst: true });
    is("its title asked for alone takes one, before the card is read", await counted(meta), { taken: [1], paidFirst: true });
    is("a message's notice reads no card and takes nothing more", await counted(() => open("sent")), { taken: [], paidFirst: false });
    // No paid window the requests can be counted in: the store rests, and the card is not read.
    await setSubscription(owner, { active: true, period: null });
    sent.length = 0;
    const refused = await file();
    is("then the file is refused, kept by no cache", [refused.status, refused.headers.get("cache-control")], [503, "no-store"]);
    is("the page sends the visitor to the store's page, which says it rests", await open(), { redirect: "/@anapottery" });
    is("its title does not name the creator", String((await meta()).title).includes("Ana Souza"), false);
    is("and the card was never read", sent.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:vcard:")), false);
  } finally {
    redis.pipeline = base;
    await setSubscription(owner, { active: true, tier: "creator", period: paidPeriod() });
  }

  part("Sent from under the card: the way back leads to the card (WCAG 2.4.8, 3.2.3; review of #1965)");
  await saveCreatorCard(store.statsId!, card, store);
  await setContact(owner, { on: true });
  // A sender is configured, so the form is open (lib/store-contact.ts, contactOpen); any email it tried to send would be counted here.
  const keyBefore = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_card_contact_only";
  const realFetch = globalThis.fetch;
  const emailed: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).hostname === "api.resend.com") {
      emailed.push(url);
      return new Response("{}", { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  let connection = 0;
  // The form as a browser sends it, each from its own connection, so the form's own limits never answer first.
  // Nothing is ever sent to anybody: each message is refused before sending, or caught by the field no person
  // sees, which answers "sent" without sending (app/api/store/contact/route.ts).
  const post = async (fields: Record<string, string>) => {
    connection += 1;
    const body = new URLSearchParams({ handle: "anapottery", name: "Dana", email: "dana@example.com", message: "Hello! Could you make a set of six bowls for a restaurant?", ...fields });
    const answer = await sendMessage(new NextRequest("https://marktmorgen.com/api/store/contact", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `7.7.${connection}.1` }, body }));
    return [answer.status, answer.headers.get("location")];
  };
  const page = async (query: Record<string, string>) =>
    elementsOf((await ContactPage({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve(query) })) as ReactNode);
  const wayBack = async (query: Record<string, string>) => {
    const links = (await page(query)).filter((element) => typeof element.props.href === "string" && String(element.props.className ?? "").includes("st-footer-link"));
    return links.map((link) => ({ href: link.props.href, text: link.props.children, tall: String(link.props.className).includes("min-h-11") }));
  };
  try {
    const formUnderCard = (await page({})).find((element) => element.type === StoreContactBox);
    const drawn = formUnderCard ? renderToStaticMarkup(formUnderCard) : "";
    is("the form under the card says, in a hidden field, that it was sent from there", drawn.includes('<input type="hidden" name="from" value="card"/>'), true);
    is("the store page's own form says nothing of the kind", renderToStaticMarkup(createElement(StoreContactBox, { store: (await storeForEmail(owner))! })).includes('name="from"'), false);
    const here = "https://marktmorgen.com/@anapottery/contact";
    const caught = { website: "https://spam.example/" };
    is("from the card, sent: the notice is told so", await post({ from: "card", ...caught }), [303, `${here}?status=sent&from=card`]);
    is("from the card, refused (too short, a bad address): the notice is told so too", [await post({ from: "card", message: "Hi" }), await post({ from: "card", email: "dana@" })], [
      [303, `${here}?status=short&from=card`],
      [303, `${here}?status=email&from=card`],
    ]);
    is("with no marker, as before", [await post(caught), await post({ message: "Hi" })], [[303, `${here}?status=sent`], [303, `${here}?status=short`]]);
    const foreign = ["Card", "card ", "cards", "card&status=sent", "//evil.example", "https://evil.example/", "store"];
    const answers = await Promise.all(foreign.map((from) => post({ from, message: "Hi" })));
    is("any other value is ignored and never put in the address (no open redirect)", answers.every(([status, location]) => status === 303 && location === `${here}?status=short`), true);

    const card = { href: "/@anapottery/contact", text: CONTACT_WORDS.en.card.back, tall: true };
    is("the notice after a message sent from the card leads back to the card", await wayBack({ status: "sent", from: "card" }), [card]);
    is("after a refusal, to the form under the card, to write again", await wayBack({ status: "short", from: "card" }), [{ ...card, href: "/@anapottery/contact#contact" }]);
    is("the link says where it goes (2.4.9)", CONTACT_WORDS.en.card.back, "Back to the contact card");
    const toStore = { href: "/@anapottery", text: "Back to Ana's Pottery", tall: true };
    is("with no marker, back to the store, as before", [await wayBack({ status: "sent" }), await wayBack({ status: "short" })], [[toStore], [{ ...toStore, href: "/@anapottery#contact" }]]);
    is("and no email was sent to anybody for any of it", emailed, []);
    is("a foreign value in the address leads to the store, never anywhere it names", [await wayBack({ status: "short", from: "https://evil.example/" }), await wayBack({ status: "sent", from: "Card" })], [[{ ...toStore, href: "/@anapottery#contact" }], [toStore]]);
  } finally {
    globalThis.fetch = realFetch;
    if (keyBefore === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = keyBefore;
    await setContact(owner, { on: false });
  }

  part("In every language the store can speak");
  const keys = Object.keys(CONTACT_WORDS.en.card).sort();
  is("each language has every word", Object.values(CONTACT_WORDS).every((words) => JSON.stringify(Object.keys(words.card).sort()) === JSON.stringify(keys)), true);
  is("and its own words, not English", Object.entries(CONTACT_WORDS).filter(([code]) => code !== "en").every(([, words]) => words.card.save !== CONTACT_WORDS.en.card.save && words.card.saveHint !== CONTACT_WORDS.en.card.saveHint && words.card.back !== CONTACT_WORDS.en.card.back), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
