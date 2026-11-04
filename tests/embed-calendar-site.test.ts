/**
 * A booking made from the calendar on the creator's own site keeps that site
 * (637 [GL5], unit 6b; added 3 November 2026), as the card's checkout keeps
 * it: on the sale as metadata[embed_site], so the receipt page sends the
 * buyer back there and the webhook names it; checked against the creator's
 * list again by the booking route; never on a session from a package.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { callCheckoutBody, keepEmbedSite } from "@/lib/calls";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { listedReturn, listedSite } from "@/lib/embed-sites";
import { SlotPicker, type SlotWords } from "@/components/slot-picker";
import type { Product, Store } from "@/lib/store";
import { done, is, part } from "./check";

const NY = "America/New_York";
const call = readSetup({ kind: "weekly", minutes: 30, tz: NY, weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;
const store = { handle: "lena", name: "Lena", language: "en", currency: "usd", hasDiscounts: false, tax: { enabled: false, included: false }, embedSites: ["https://lena.example"] } as unknown as Store;
const product = { id: "p1", title: "Coaching", summary: "", priceCents: 4500, fields: [], call } as unknown as Product;
const start = Date.now() + 3 * 86_400_000;
const body = (extra: { embedSite?: string; fromPackage?: { id: string; coupon: string; email: string; back: string } }) => {
  const made = callCheckoutBody({ store, product, start, end: start + 1_800_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: extra.fromPackage ?? null });
  keepEmbedSite(made, extra.embedSite, Boolean(extra.fromPackage));
  return made;
};

part("Kept on the sale");
is("a listed site's address, as the card's checkout keeps it", body({ embedSite: "https://lena.example/book" }).get("metadata[embed_site]"), "https://lena.example/book");
is("nothing without one, or with anything but a secure address", [body({}).has("metadata[embed_site]"), body({ embedSite: "http://lena.example" }).has("metadata[embed_site]"), body({ embedSite: "javascript:alert(1)" }).has("metadata[embed_site]")], [false, false, false]);
const full = new URLSearchParams(Array.from({ length: 50 }, (_, i) => [`metadata[f${i}]`, "x"]));
keepEmbedSite(full, "https://lena.example", false);
is("written last, after the platform's share, and never past Stripe's fifty metadata fields", [readFileSync("lib/calls.ts", "utf8").indexOf("keepEmbedSite(body, input.embedSite") > readFileSync("lib/calls.ts", "utf8").indexOf("applyShare(body, store, { recurring: false"), full.has("metadata[embed_site]")], [true, false]);
is(
  "back from Stripe's page, the booking page still has the site, so a second try is still the site's; never from a package",
  [new URL(body({ embedSite: "https://lena.example/book" }).get("cancel_url") ?? "").searchParams.get("site"), new URL(body({}).get("cancel_url") ?? "").searchParams.has("site"), body({ embedSite: "https://lena.example", fromPackage: { id: "cs_test_pkg", coupon: "c1", email: "ana@example.com", back: "https://marktmorgen.com/@lena" } }).get("cancel_url")],
  ["https://lena.example/book", false, "https://marktmorgen.com/@lena"],
);
is("never on a session from a package, which pays nothing here", body({ embedSite: "https://lena.example", fromPackage: { id: "cs_test_pkg", coupon: "c1", email: "ana@example.com", back: "https://marktmorgen.com/@lena" } }).has("metadata[embed_site]"), false);

part("Checked against the creator's list again");
is("a listed site, or a way back on one, is taken; anything else is not", [listedSite(store.embedSites, "https://lena.example/x"), listedSite(store.embedSites, "https://evil.example"), listedReturn(store.embedSites, "https://lena.example/thanks"), listedReturn(store.embedSites, "https://evil.example/thanks")], ["https://lena.example", null, "https://lena.example/thanks", null]);
const route = readFileSync("app/api/store/book/route.ts", "utf8");
const limit = Number(/const MAX_BODY_BYTES = ([\d_]+);/.exec(route)?.[1].replace(/_/g, ""));
const longest = new URLSearchParams({ handle: "a".repeat(40), product: "p".repeat(40), start: "1".repeat(14), tz: "America/Argentina/ComodRivadavia", pkg: "k".repeat(60), code: "c".repeat(60), host: "5", host_label: "\u00e9".repeat(60), minutes: "120", site: `https://${"s".repeat(292)}`, return: `https://${"r".repeat(600)}?a=${"\u00e9".repeat(30)}` }).toString();
is("the whole form fits the route's limit at every field's longest, form-encoded", [longest.length < limit, limit <= 4_000], [true, true]);
is("the booking route checks what the form sent before handing it on", route.includes("embedSite: listedReturn(store.embedSites, returnAsked) ?? listedSite(store.embedSites, siteAsked) ?? null,"), true);

is(
  "after a refusal, the booking route sends the listed site and the way back with the buyer, only as listed, never with a package",
  [route.includes("const keptSite = listedSite(store.embedSites, siteAsked);"), route.includes("const keptBack = keptSite ? listedReturn(store.embedSites, returnAsked) : null;"), route.includes("const keptEmbed = keptSite && !pkg ?"), route.includes("${keptLength}${keptEmbed}`")],
  [true, true, true, true],
);
const bookPage = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
is(
  "and the booking page hands them back to its own form, read against the creator's list again",
  [bookPage.includes("const embedSite = listedSite(store.embedSites, typeof query.site === \"string\" ? query.site : null);"), bookPage.includes("const embed = embedSite && !pkgOf(query) ? { site: embedSite, back: embedBack } : null;"), bookPage.includes("embed={embed}")],
  [true, true, true],
);

part("Sent by the calendar's own form");
const words: SlotWords = { locale: "en-US", pickDay: "Pick a day", pickTime: "Pick a time", noneTitle: "None", noneBody: "None", yours: "Times are in your time zone, {zone}.", creators: "", chosen: "", submit: "Continue", note: "" };
const starts = [start];
const framed = renderToStaticMarkup(createElement(SlotPicker, { starts, creatorTz: NY, handle: "lena", productId: "p1", newTab: true, embed: { site: "https://lena.example", back: "https://lena.example/thanks" }, words }));
const moving = renderToStaticMarkup(createElement(SlotPicker, { starts, creatorTz: NY, handle: "lena", productId: "p1", move: "cs_test_x", embed: { site: "https://lena.example", back: null }, words }));
is("the site and the way back go with the time", [framed.includes('name="site" value="https://lena.example"'), framed.includes('name="return" value="https://lena.example/thanks"')], [true, true]);
is("never with a move, which pays nothing", moving.includes('name="site"'), false);
is("the embedded calendar hands its open's site and way back to its form", readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8").includes("embed={open.site ? { site: open.site, back: open.back ?? null } : null}"), true);

is("a team the buyer picks from keeps the listed site and the way back, on the card's link and on the pick", [readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8").includes("<a href={toBuyBox(tag(`/@${store.handle}/book/${product.id}`))} {...aside}"), readFileSync("app/[handle]/book/[product]/page.tsx", "utf8").includes('{embed ? <input type="hidden" name="site" value={embed.site} /> : null}'), readFileSync("app/[handle]/book/[product]/page.tsx", "utf8").includes('{embed?.back ? <input type="hidden" name="return" value={embed.back} /> : null}')], [true, true, true]);

done();
