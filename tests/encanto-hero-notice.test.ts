import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MorningHeader } from "@/components/morning-header";
import { HeroClaim } from "@/components/home-claim";
import { PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";

const header = renderToStaticMarkup(createElement(MorningHeader));
assert.match(header, /<details class="hm-preview-compact">/, "mobile notice has a native disclosure");
assert.match(header, /<summary>Still being built\. Plans closed\.<\/summary>/);
assert.equal(header.split(PREVIEW_LINE).length - 1, 2, "both responsive presentations retain the exact closed-plan notice");
assert.equal(header.split(`href="${PREVIEW_LINK.href}"`).length - 1, 2, "both presentations retain the existing detail link");
assert.doesNotMatch(header, /<details[^>]*\bopen\b/);
const hero = renderToStaticMarkup(createElement(HeroClaim, { offer: "Synthetic offer", items: [] }));
assert.match(hero, /class="hm-hero-cards"/, "all three example cards have their own flow group");
assert.equal((hero.match(/class="hm-float hm-rise/g) ?? []).length, 3);
assert.match(hero, /Preview with demo products/);
console.log("Hero card grouping and both complete native preview notices retained");
