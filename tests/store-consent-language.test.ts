/**
 * The two consent requests on a store's pages, the affiliate cookie
 * (components/affiliate-click.tsx) and ad measurement
 * (components/store-pixels.tsx), drawn by components/store-tracking.tsx, are
 * in the store's language (lib/store-language.ts) and say which language
 * they are in (`lang`, WCAG 3.1.2, AX274), as the rest of the store's pages
 * do: a buyer never meets a page half in one language and half in another,
 * least of all on the one question that asks them to decide.
 *
 * English keeps every word as it was, and an unknown language falls back
 * to English marked as English. Links, buttons and the choice they keep
 * are the same in every language.
 *
 * Synthetic: rendered to static markup with the state the browser reaches
 * after the component's effect; nothing is fetched or stored.
 */
import ReactDefault, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateClick } from "@/components/affiliate-click";
import { StorePixels } from "@/components/store-pixels";
import { StoreTracking } from "@/components/store-tracking";
import { NO_PIXELS, pixelNames, type Pixels } from "@/lib/pixels";
import { LANGUAGE_CODES, LANGUAGES } from "@/lib/store-language";
import type { Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { done, is, part } from "./check";

/** Renders a client component with its one useState forced to `value` (what the browser shows after its effect). */
function withState(value: unknown, node: ReactElement): string {
  const R = ReactDefault as unknown as { useState: unknown };
  const real = R.useState;
  R.useState = () => [value, () => {}];
  try {
    return renderToStaticMarkup(node);
  } finally {
    R.useState = real;
  }
}

function withGpc<T>(on: boolean, run: () => T): T {
  const nav = globalThis.navigator as Navigator & { globalPrivacyControl?: boolean };
  const before = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
  Object.defineProperty(nav, "globalPrivacyControl", { value: on, configurable: true });
  try {
    return run();
  } finally {
    if (before) Object.defineProperty(nav, "globalPrivacyControl", before);
    else delete (nav as { globalPrivacyControl?: boolean }).globalPrivacyControl;
  }
}

const visible = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** English words a banner in another language must not carry. */
const ENGLISH = /\b(the|your|you|with|this|that|and|of|for|from|here|sent|Allow|No thanks|More about this|measures|permission|nothing|Turn off|settings|Affiliate link|Ad measurement)\b/;

const STORE = "Küche Kraus";
const PIXELS: Pixels = { ...NO_PIXELS, meta: "123456789012345", google: "G-ABCDEF1234" };

const affiliate = (language: unknown, days = 30) =>
  withState("aff123", createElement(AffiliateClick, { handle: "kueche", storeName: STORE, days, askFirst: true, language } as never));
const pixels = (language: unknown, state: "ask" | "on" | "off", names = "Meta and Google") =>
  withState(state, createElement(StorePixels, { handle: "kueche", storeName: STORE, pixels: PIXELS, names, askFirst: true, language } as never));

/** The opening tag of the first element rendered. */
const rootTag = (html: string) => html.match(/^<[^>]+>/)?.[0] ?? "";
const buttons = (html: string) => (html.match(/<button[^>]*>/g) ?? []).map((tag) => tag.replace(/\s+/g, " "));
const links = (html: string) => (html.match(/href="[^"]*"/g) ?? []).join(" ");

async function main(): Promise<void> {
  part("English keeps every word it had");
  const enAff = visible(affiliate("en"));
  is("affiliate banner, word for word", enAff, `An affiliate of ${STORE} sent you here With your permission, this store keeps a cookie with that affiliate's code and the time you arrived, so they are credited if you buy within 30 days. It holds nothing else about you, and the price is the same either way. More about this Allow No thanks`);
  is("one day is said as one day", visible(affiliate("en", 1)).includes("if you buy within 1 day. It holds"), true);
  is("the affiliate banner's name for a screen reader", /aria-label="Affiliate link"/.test(affiliate("en")), true);
  const enAds = visible(pixels("en", "ask"));
  is("ad banner, word for word", enAds, `${STORE} measures its ads With your permission, this page loads ad measurement from Meta and Google, which sets cookies, and ${STORE} tells them about your sign-ups and purchases, so it can tell which of its ads bring people here. If you say no, nothing loads, nothing is sent, and the page works just the same. More about this Allow No thanks`);
  is("the ad banner's name for a screen reader", /aria-label="Ad measurement"/.test(pixels("en", "ask")), true);
  is("the link to turn it off, and back on", [visible(pixels("en", "on")), visible(pixels("en", "off"))], ["Turn off ad measurement", "Ad measurement settings"]);
  is("the Global Privacy Control note", visible(withGpc(true, () => pixels("en", "ask"))), "Your browser’s Global Privacy Control keeps ad measurement off. Manage this signal in your browser settings.");
  is("the names of the pixels, as before", pixelNames({ ...NO_PIXELS, meta: "1", google: "G", x: "a" }), "Meta, Google and X");

  for (const code of LANGUAGE_CODES) {
    const locale = LANGUAGES[code].locale;
    part(`${LANGUAGES[code].english}: both requests in the store's language, and marked`);
    const aff = affiliate(code);
    const ask = pixels(code, "ask");
    const on = pixels(code, "on");
    const off = pixels(code, "off");
    const gpc = withGpc(true, () => pixels(code, "ask"));
    is("each says which language it is in", [aff, ask, on, off, gpc].map((html) => new RegExp(`\\blang="${locale}"`).test(rootTag(html))), [true, true, true, true, true]);
    is("each keeps its links and its two buttons", [links(aff), links(ask), buttons(aff).length, buttons(ask).length, buttons(on).length, buttons(off).length], ['href="/privacy#affiliates"', 'href="/privacy#ads"', 2, 2, 1, 1]);
    is("the store's name and the days are said", [visible(aff).includes(STORE), visible(aff).includes("30"), visible(ask).includes(STORE)], [true, true, true]);
    if (code === "en") continue;
    for (const [what, html] of [["affiliate banner", aff], ["ad banner", ask], ["turn off", on], ["settings", off], ["Global Privacy Control note", gpc]] as const) {
      const words = visible(html).replace(STORE, "");
      is(`the ${what} is not in English`, ENGLISH.test(words), false);
    }
    is("the screen reader names are in the store's language", [/aria-label="Affiliate link"/.test(aff), /aria-label="Ad measurement"/.test(ask)], [false, false]);
    is("one day and thirty days are said differently", visible(affiliate(code, 1)) !== visible(affiliate(code, 30)).replace("30", "1"), true);
  }

  part("An unknown language falls back to English, marked as English");
  for (const unknown of ["xx", undefined, 7]) {
    const aff = affiliate(unknown);
    const ask = pixels(unknown, "ask");
    is(`${String(unknown)}: English words`, [visible(aff), visible(ask)], [enAff, enAds]);
    is(`${String(unknown)}: lang="en-US"`, [/\blang="en-US"/.test(rootTag(aff)), /\blang="en-US"/.test(rootTag(ask))], [true, true]);
  }

  part("components/store-tracking.tsx hands both the store's language, and names the pixels in it");
  answering(new Request("https://marktmorgen.com/@kueche", { headers: { "x-vercel-ip-country": "DE" } }));
  const store = {
    handle: "kueche",
    name: STORE,
    language: "de",
    pixels: PIXELS,
    affiliates: { enabled: true, days: 30 },
  } as unknown as Store;
  const tree = (await StoreTracking({ store })) as ReactElement<{ children: unknown[] }>;
  const kids = (tree.props.children as unknown[]).filter(Boolean) as ReactElement<Record<string, unknown>>[];
  const aff = kids.find((kid) => kid.type === AffiliateClick);
  const px = kids.find((kid) => kid.type === StorePixels);
  is("the affiliate banner is given the store's language", aff?.props.language, "de");
  is("the ad banner is given the store's language", px?.props.language, "de");
  is("the pixels are named in German", px?.props.names, "Meta und Google");
  answering(null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

