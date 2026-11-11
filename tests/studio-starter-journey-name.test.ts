/**
 * The campaign gallery on /studio/funnels (components/funnel-starter-gallery.tsx)
 * shows one card per campaign, each with a button that opens its journey. Every
 * one of those buttons was called "See the journey and what you need", so in a
 * screen reader's list of buttons 14 entries read the same and none said which
 * campaign it opens (WCAG 2.2 2.4.6 and 4.1.2; AX274 Part A item 4). Each now
 * ends, for assistive technology only, with its campaign's name, and the visible
 * words stay first so a voice command with them still works (2.5.3).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelStarterGallery } from "@/components/funnel-starter-gallery";
import { starterCard } from "@/lib/funnel-starter-catalog";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { done, is } from "./check";

const starters = FUNNEL_STARTERS.map(starterCard);
const html = renderToStaticMarkup(createElement(FunnelStarterGallery, { starters, busy: false, onChoose: () => {} }));
const text = (fragment: string) => fragment.replace(/<[^>]*>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
const toggles = [...html.matchAll(/<button[^>]*aria-expanded="false"[^>]*>([\s\S]*?)<\/button>/g)].map((found) => text(found[1]));

is("one journey button per campaign", toggles.length, starters.length);
is("each journey button starts with its visible words", toggles.every((name) => name.startsWith("See the journey and what you need")), true);
is("each journey button names its campaign", toggles.every((name, index) => name.includes(starters[index].label)), true);
is("no two journey buttons share a name", new Set(toggles).size, toggles.length);
is("the campaign's name is for assistive technology only", /See the journey and what you need<span class="sr-only">/.test(html), true);

done();
