/**
 * 639 [GL7](22), unit 2: the creator's business card on the store's contact
 * address (app/[handle]/contact/page.tsx) and its "Save contact" file
 * (app/[handle]/contact/vcard/route.ts), through the real page, route and
 * store, the card itself drawn from components/creator-card-view.tsx. Shown and given only while the card is on; each way to reach the
 * creator a link that says what it is; the file a vCard to save; neither
 * while the store is switched off after a report, nor while it rests
 * (lib/traffic.ts), the file one of the store's public requests; an old
 * address and a domain the store may not use sent on as the store page
 * does; the words in every language the store can speak.
 *
 * The page runs inside a request scope made with Next's own stores, so its
 * headers() reads what the test gives it, as on a real request.
 */
// First, before anything of Next's loads.
import "./next-request-scope";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage, { generateMetadata } from "@/app/[handle]/contact/page";
import { CreatorCardView, mailtoHref } from "@/components/creator-card-view";
import { POST as sendContactForm } from "@/app/api/store/contact/route";
import { StoreResting } from "@/components/store-resting";
import { GET } from "@/app/[handle]/contact/vcard/route";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { type CreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, renameHandle, setSubscription, storeForEmail } from "@/lib/store";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

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

  // A request's scope, as Next makes one for a page, with the headers the test gives.
  const inRequest = <T,>(head: Record<string, string>, run: () => Promise<T>): Promise<T> =>
    workAsyncStorage.run({ route: "/[handle]/contact" } as never, () => workUnitAsyncStorage.run({ type: "request", phase: "render", headers: new Headers(head) } as never, run));
  type Element = { type?: unknown; props?: Record<string, unknown> } | null | undefined;
  const page = (query: Record<string, string> = {}, handle = "@anapottery", head: Record<string, string> = {}) =>
    inRequest(head, async () => (await ContactPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(query) })) as Element);
  // The page itself: shown, resting, or sent on (its server parts that read the request are not drawn here).
  const open = async (status?: string, handle = "@anapottery", head: Record<string, string> = {}): Promise<"shown" | "resting" | "suspended" | { redirect: string }> => {
    try {
      const shown = await page(status ? { status } : {}, handle, head);
      if (shown?.type === StoreResting) return shown.props?.suspended ? "suspended" : "resting";
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
  is("under the card, the store's own contact form when it is on, to leave one's details", readFileSync("app/[handle]/contact/page.tsx", "utf8").includes("{contactOpen(store) ? <StoreContactBox store={store} from=\"card\" /> : null}"), true);
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
  is("the page says the store is not available, as the store page does, and shows no card", await open(), "suspended");
  is("its title does not name the creator", String((await generateMetadata({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve({}) })).title).includes("Ana Souza"), false);
  await noteTakedown(owner, null, false);
  is("switched back on, the file is given again", (await file()).status, 200);

  part("An address typed with characters a link would read otherwise");
  const odd = "a?b&c%d#e/f@example.com";
  is("its link keeps the whole address (RFC 6068)", [mailtoHref(odd), draw({ ...card, email: odd }).includes(`href="${mailtoHref(odd)}"`), decodeURIComponent(mailtoHref(odd).slice(7))], ["mailto:a%3Fb%26c%25d%23e%2Ff@example.com", true, odd]);

  part("A message sent from under the card leads back to the card");
  const form = (fields: Record<string, string>) =>
    sendContactForm(new NextRequest("https://marktmorgen.com/api/store/contact", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: new URLSearchParams(fields) }));
  // The hidden field no person fills in: told it worked, and nothing is sent anywhere.
  const sentFrom = await form({ handle: "anapottery", from: "card", website: "x", name: "Bo", email: "bo@example.com", message: "Hello there, a question." });
  is("the page after it says it came from the card", [sentFrom.status, sentFrom.headers.get("location")], [303, "https://marktmorgen.com/@anapottery/contact?status=sent&from=card"]);
  is("and from the store page, as before", (await form({ handle: "anapottery", website: "x", name: "Bo", email: "bo@example.com", message: "Hello there, a question." })).headers.get("location"), "https://marktmorgen.com/@anapottery/contact?status=sent");
  const links = (node: unknown, found: { href: string; text: unknown }[] = []): { href: string; text: unknown }[] => {
    if (Array.isArray(node)) node.forEach((child) => links(child, found));
    else if (node && typeof node === "object" && "props" in node) {
      const props = (node as { props: Record<string, unknown> }).props;
      if (typeof props.href === "string") found.push({ href: props.href, text: props.children });
      links(props.children, found);
    }
    return found;
  };
  is("its way back is the card", links(await page({ status: "sent", from: "card" })), [{ href: "/@anapottery/contact", text: "Back to the contact card" }]);
  is("and to the form under it when it was not sent", links(await page({ status: "short", from: "card" })).map((link) => link.href), ["/@anapottery/contact#contact"]);
  is("the form under the card says where it is", readFileSync("components/store-contact-box.tsx", "utf8").includes('{from ? <input type="hidden" name="from" value={from} /> : null}') && readFileSync("app/[handle]/contact/page.tsx", "utf8").includes('<StoreContactBox store={store} from="card" />'), true);

  part("A store that rests (lib/traffic.ts)");
  is("before, the card shows", await open(), "shown");
  // The window's requests and visits, used: as a month of visitors would leave them.
  const spent = redis.keys().filter((key) => key.startsWith("nl:traffic:r:"));
  is("the store has a window of requests", spent.length > 0, true);
  await redis.pipeline(spent.flatMap((key) => [["SET", key, 1_000_000_000], ["SET", key.replace(":r:", ":n:"), 1_000_000_000]]));
  is("the page rests, as the store page does, and shows no card", await open(), "resting");
  const tired = await file();
  is("the file is not made: try again later, never from a cache", [tired.status, tired.headers.get("cache-control")], [429, "no-store"]);
  is("the tab's title never reads the card", String((await generateMetadata({ params: Promise.resolve({ handle: "@anapottery" }), searchParams: Promise.resolve({}) })).title), "Contact card · Ana's Pottery — Marktmorgen");
  await redis.pipeline(spent.flatMap((key) => [["DEL", key], ["DEL", key.replace(":r:", ":n:")]]));
  is("its window open again, the file is given", (await file()).status, 200);
  is("an address that cannot be read is no file", (await GET(new NextRequest("https://marktmorgen.com/@%E0%A4%A/contact/vcard"), { params: Promise.resolve({ handle: "@%E0%A4%A" }) })).status, 404);

  part("Its own domain and an old address, as on the store page");
  is("on a domain that is not the store's, sent to the address that always works", await open(undefined, "@anapottery", { "x-nimbus-domain": "shop.example.com" }), { redirect: `${SITE_URL}/@anapottery/contact` });
  is((await renameHandle(owner, "anaceramics")).ok ? "renamed" : "not renamed", "renamed", "renamed");
  is("an old address sent on to the one it uses now", await open(undefined, "@anapottery"), { redirect: "/@anaceramics/contact" });
  is("with the message's notice kept", await open("sent", "@anapottery"), { redirect: "/@anaceramics/contact?status=sent" });
  is("the address it uses now shows the card", await open(undefined, "@anaceramics"), "shown");

  part("In every language the store can speak");
  const keys = Object.keys(CONTACT_WORDS.en.card).sort();
  is("each language has every word", Object.values(CONTACT_WORDS).every((words) => JSON.stringify(Object.keys(words.card).sort()) === JSON.stringify(keys)), true);
  is("and its own words, not English", Object.entries(CONTACT_WORDS).filter(([code]) => code !== "en").every(([, words]) => words.card.save !== CONTACT_WORDS.en.card.save && words.card.saveHint !== CONTACT_WORDS.en.card.saveHint), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
