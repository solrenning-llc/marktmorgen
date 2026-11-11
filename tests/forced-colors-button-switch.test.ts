/**
 * Inbox C4-35: in Studio AAA (WebKit, forced colors, 390 px), "Add a pixel"
 * was measured at 2.78:1, GrayText on sand, with aria-disabled already
 * "false". The summary was drawn off until the page was ready, and WebKit
 * animates a button's colors in forced colors, so a moment after it turned
 * usable it still wore the off colors.
 *
 * What fails here:
 *   - the pixel summary marked off before the page is ready (a <details> opens
 *     without script, so "off" was untrue), or its fields not held until then;
 *   - any color of a button, or of a round icon button (.icon-btn), animated in forced colors;
 *   - the off button's forced look (GrayText, dashed) lost.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const editor = readFileSync("components/pixel-editor.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

part("The pixel summary is never drawn off and then on");
{
  const summary = editor.slice(editor.indexOf("<summary"), editor.indexOf("</summary>"));
  is("no aria-disabled on the summary", /aria-disabled/.test(summary), false);
  is("no click held back by script either: it opens as a <details> does", /preventDefault/.test(summary), false);
  is("until ready, what it opens is held: its fieldset is disabled", editor.includes("<fieldset disabled={!ready || busy}"), true);
  is("and a save before then does nothing", editor.includes("if (!ready || busy) return;"), true);
  is("the browser check waits for its fields to be ready, not for a mark the summary no longer has", readFileSync("tests/e2e/pixel-attribution-center.mjs", "utf8").includes(`document.querySelector('section[aria-labelledby="pixels-title"] fieldset')?.disabled===false`) && !readFileSync("tests/e2e/pixel-attribution-center.mjs", "utf8").includes('getAttribute("aria-disabled")==="false"'), true);
}

part("Forced colors: no button color is animated");
{
  const blocks = [...css.matchAll(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const offBlock = blocks.find((b) => b.includes('.btn[aria-disabled="true"]'));
  is("the off button's forced look is kept", !!offBlock && /color: GrayText;\s*border-style: dashed;\s*border-color: GrayText;/.test(offBlock), true);
  is("and in the same place, a button's transition is none, a round icon button's too (#2904 review)", !!offBlock && /\n  \.btn,\s*\.icon-btn \{\s*transition: none;\s*\}/.test(offBlock), true);
  const at = css.indexOf("@media (forced-colors: active) {\n  /* The system's colour for an unavailable control");
  is("after the base .btn rule, so it wins", at > css.indexOf("\n.btn {\n"), true);
}

done();
