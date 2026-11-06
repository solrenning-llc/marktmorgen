import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MorningHeader } from "@/components/morning-header";
import { HeroClaim } from "@/components/home-claim";
import { PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";

const header = renderToStaticMarkup(createElement(MorningHeader));
assert.match(header, /<input id="hm-preview-toggle" class="hm-preview-toggle" type="checkbox" aria-controls="hm-preview-detail"\/>/, "mobile notice has an unclipped native checkbox and explicit controlled paragraph");
assert.match(header, /<label class="hm-preview-compact" for="hm-preview-toggle">/);
assert.match(header, /Still being built\. Plans closed\./);
assert.equal(header.split(PREVIEW_LINE).length - 1, 1, "one exact notice shared across responsive presentations, within ME3");
assert.equal(header.split(`href="${PREVIEW_LINK.href}"`).length - 1, 1, "one existing detail link, within ME3");
assert.doesNotMatch(header, /\bchecked=/);
const hero = renderToStaticMarkup(createElement(HeroClaim, { offer: "Synthetic offer", items: [] }));
assert.match(hero, /class="hm-hero-cards"/, "all three example cards have their own flow group");
assert.equal((hero.match(/class="hm-float hm-rise/g) ?? []).length, 3);
assert.match(hero, /Preview with demo products/);
console.log("One complete native preview notice and all hero cards retained");
