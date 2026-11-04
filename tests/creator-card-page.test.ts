/**
 * 639 [GL7](22), unit 2: the creator's business card on the store's contact
 * address (app/[handle]/contact/page.tsx) and its "Save contact" file
 * (app/[handle]/contact/vcard/route.ts), through the real page, route and
 * store, the card itself drawn from components/creator-card-view.tsx. Shown and given only while the card is on; each way to reach the
 * creator a link that says what it is; the file a vCard to save; neither
 * while the store is switched off after a report; the words
 * in every language the store can speak.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage, { generateMetadata } from "@/app/[handle]/contact/page";
import { CreatorCardView } from "@/components/creator-card-view";
import { StoreResting } from "@/components/store-resting";
import { GET } from "@/app/[handle]/contact/vcard/route";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { type CreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setSubscription, storeForEmail } from "@/lib/store";
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
  is("every link tall enough to tap", (html.match(/min-h-11/g) ?? []).length >= 4, true);
  is("the way back to the store", html.includes("Visit Ana&#x27;s Pottery") || html.includes("Visit Ana's Pottery"), true);
  const bare = draw({ ...card, title: "", email: "", phone: "", website: "", note: "" });
  is("only what was filled in", !bare.includes("<dl") && !bare.includes("mailto:") && bare.includes("Ana Souza</h1>"), true);
  is("a message's notice still shows on the same address", await open("sent"), "shown");
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
