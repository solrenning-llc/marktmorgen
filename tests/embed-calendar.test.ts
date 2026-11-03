/**
 * The calendar embedded in the creator's own site (637 [GL5], unit 6; added
 * 3 November 2026): a call the checkout script opened in a frame, on a site
 * the creator listed, shows its times in that frame, and its form opens
 * Stripe's page in a new tab. The card page reads headers at request time,
 * so it is read in its source here, as tests/embed.test.ts reads it; the time
 * picker is drawn for real.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { SlotPicker, type SlotWords } from "@/components/slot-picker";
import { isEmbedPage } from "@/lib/csp";
import { BOOKING_WORDS } from "@/lib/buyer-words/booking";
import { done, is, part } from "./check";

const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");

part("Only where the creator allows it");
is("only a call the script opened in a frame, on a listed site, while it may sell, with no affiliate's code, in weekly hours", card.includes('!plain && open?.mode === "overlay" && open.live && Boolean(open.site) && !open.via && action.kind === "link" &&\n    product.call?.kind === "weekly" && canSellProduct(store, product);'), true);
is("anywhere else the card stays a link to the booking page in a new tab, as before", card.includes(') : action.kind === "link" ? (\n          <a href={action.href === "#buy" ? toBuyBox(into(action.href)) : into(action.href)} {...aside}'), true);
is("the times open at the same address, so the frame's own policy is the card's", [card.includes('href={here({ view: "times" })}'), isEmbedPage("/embed/lena/p1"), isEmbedPage("/embed/lena/p1/book")], [true, true, false]);
is("every parameter the script checked is kept, and nothing typed is put back but strings", card.includes('for (const [key, value] of Object.entries(query)) if (typeof value === "string" && !drop.includes(key)) next.set(key, value);'), true);

part("The times in the frame");
is("read and offered as on the booking page: the lengths it can book, the price, the deposit", [card.includes("offeredLengths(call.call, product.priceCents, { pkg: false, team: read.team })"), card.includes("const due = chargeNow({ priceCents: cents"), card.includes("b.depositRest(say.money(due.rest), store.name)")], [true, true, true]);
is("each length a link in a named group, the one shown marked and said", [card.includes('role="group" aria-labelledby={`length-${product.id}`}'), card.includes("aria-current={l.minutes === chosen.minutes"), card.includes('role="status">{b.lengthChosen(')], [true, true, true]);
is("a way back to the card, named by the product", card.includes("{b.backToCard(product.title)}"), true);
const words: SlotWords = { locale: "en-US", pickDay: "Pick a day", pickTime: "Pick a time", noneTitle: "None", noneBody: "None", yours: "Times are in your time zone, {zone}.", creators: "", chosen: "", submit: "Continue", note: "" };
const starts = [Date.now() + 3 * 86_400_000];
const framed = renderToStaticMarkup(createElement(SlotPicker, { starts, creatorTz: "America/New_York", handle: "lena", productId: "p1", newTab: true, words }));
const page = renderToStaticMarkup(createElement(SlotPicker, { starts, creatorTz: "America/New_York", handle: "lena", productId: "p1", words }));
const moving = renderToStaticMarkup(createElement(SlotPicker, { starts, creatorTz: "America/New_York", handle: "lena", productId: "p1", newTab: true, move: "cs_test_x", words }));
is("in the frame, Stripe's page opens in a new tab, never in the frame", [framed.includes('target="_blank"'), framed.includes('rel="noopener"')], [true, true]);
is("on the booking page and when a booking moves, as before", [page.includes('target="_top"'), moving.includes('target="_top"')], [true, true]);

part("In every language");
const langs = Object.entries(BOOKING_WORDS);
is("the way back names the product", langs.map(([, w]) => w.backToCard("Coaching").includes("Coaching")), langs.map(() => true));
is("in US English", BOOKING_WORDS.en.backToCard("Coaching"), "Back to Coaching");

done();
