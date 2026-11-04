/**
 * A block a translation left as it was says the language it is still in
 * (inbox C4-19 (c), C4-26 (2); WCAG 3.1.2). The creator says which language
 * the page is in when translating ("Not sure" by default); only then is such
 * a block marked. The mark carries a print of the words it was made for, and
 * the page draws the lang only while the block's words are still those, so a
 * block rewritten since (by hand, an undo, a saved section, the API) never
 * says a language it is not in. Nothing is ever guessed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, PageSections } from "@/components/sales-blocks";
import { keepEveryBlock, markHolds, markLang, pageWords, withWords, wordsPrint } from "@/lib/page-translate";
import { PAGE_LANGUAGES, type PageBlock, type SalesPage, parsePage, sameBlocks } from "@/lib/sales-page";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const booking = (extra: Record<string, unknown> = {}) => ({ id: "book0001", kind: "booking", product: "call000001", heading: "x".repeat(95), ...extra });
const text = (id: string, heading: string) => ({ id, kind: "text", heading, body: "Twenty minutes." });
// Every word longer, as a translation may make it: the booking's heading no longer fits.
const longer = (page: SalesPage) => withWords(page, pageWords(page).map((w) => `${w} (traducido al español)`));
const langs = (blocks: PageBlock[] | undefined) => (blocks ?? []).map((b) => (markHolds(b) ? b.lang : null));

part("A block's mark is read only with the print of its words");
{
  is("the page's list of languages is the store's", [...PAGE_LANGUAGES], [...LANGUAGE_CODES]);
  const marked = markLang(parsePage({ blocks: [text("text0001", "Why")] }).blocks[0], "de");
  const read = parsePage({ blocks: [marked, { ...text("text0002", "How"), lang: "de" }, { ...text("text0003", "When"), lang: "klingon", langOf: "0000abcd" }] }).blocks;
  is("kept with its print; a mark with no print, or not a store language, is dropped", [read.map((b) => b.lang ?? null), markHolds(read[0])], [["de", null, null], true]);
  is("the print is eight hex characters", /^[0-9a-f]{8}$/.test(wordsPrint(read[0])), true);
}

part("A translation marks a block it left as it was only with the language the creator said");
{
  const page = parsePage({ blocks: [booking(), text("text0001", "Why talk")] });
  const said = keepEveryBlock(page, longer(page), "es", "en");
  is("said English: the block left as it was says English, the translated one nothing", [said.page.blocks.map((b) => b.kind), langs(said.page.blocks), said.untranslated], [["booking", "text"], ["en", null], 1]);
  const notSure = keepEveryBlock(page, longer(page), "es");
  is("not sure: nothing is marked", [langs(notSure.page.blocks), notSure.untranslated], [[null, null], 1]);
  const sameAsTarget = keepEveryBlock(page, longer(page), "es", "es");
  is("said the language asked for: nothing is marked", langs(sameAsTarget.page.blocks), [null, null]);

  const back = keepEveryBlock(said.page, longer(said.page), "en", "es");
  is("translated back into English, the English block is no longer marked, whatever was said", langs(back.page.blocks), [null, null]);
  const third = keepEveryBlock(said.page, longer(said.page), "de", "es");
  is("into a third language, the block keeps the language it is really in, not the one said for the page", langs(third.page.blocks), ["en", null]);
  const thirdNotSure = keepEveryBlock(said.page, longer(said.page), "de");
  is("and so when not sure", langs(thirdNotSure.page.blocks), ["en", null]);

  const twoVersions = parsePage({ blocks: [booking(), text("text0001", "Why talk")], variant: { id: "", blocks: [booking(), text("text0001", "Why not")] } });
  const both = keepEveryBlock(twoVersions, longer(twoVersions), "es", "en");
  is("the second version's block left as it was is marked too", langs(both.page.variant?.blocks), ["en", null]);
}

part("A mark holds only while the block's words are the ones it was marked for");
{
  const page = parsePage({ blocks: [booking(), text("text0001", "Why talk")] });
  const translated = keepEveryBlock(page, longer(page), "es", "en").page;
  const rewritten = translated.blocks.map((b) => (b.kind === "booking" ? { ...b, heading: "Hablemos primero" } : b));
  is("rewritten by hand, the mark no longer holds", langs(rewritten), [null, null]);
  is("moved, hidden on a screen or saved again, it still holds", langs(parsePage({ blocks: [...translated.blocks].reverse().map((b) => ({ ...b, screens: "phone" })) }).blocks), [null, "en"]);
  const forged = translated.blocks.map((b) => (b.kind === "text" ? { ...b, lang: "fr" as const, langOf: "deadbeef" } : b));
  is("a mark sent with someone else's print never holds", langs(parsePage({ blocks: forged }).blocks), ["en", null]);
  const again = keepEveryBlock({ ...translated, blocks: rewritten }, longer({ ...translated, blocks: rewritten }), "de");
  is("a mark that no longer holds is not carried by the next translation", langs(again.page.blocks), [null, null]);
}

part("Two versions that differ only in a mark are the same page");
{
  const a = parsePage({ blocks: [text("text0001", "Why"), text("text0002", "How")] }).blocks;
  const b = a.map((block, i) => (i === 0 ? markLang(block, "en") : block));
  is("the A/B test sees no difference", sameBlocks(a, b), true);
}

part("The page draws a block's language only while its mark holds");
{
  const ctx = { storeName: "Kiln Works", productTitle: "Glaze Guide", lang: "es", preview: false } as unknown as BlockContext;
  const draw = (blocks: PageBlock[]) => renderToStaticMarkup(createElement(PageSections, { blocks, ctx, style: "plain", reviewsFor: () => null }));
  const marked = markLang(parsePage({ blocks: [text("text0001", "Why we talk")] }).blocks[0], "en");
  const html = draw([marked, parsePage({ blocks: [text("text0002", "Por qué")] }).blocks[0]]);
  is("the block in English says lang=\"en\"; the other says nothing of its own", [/data-block="text0001"[^>]*lang="en"/.test(html), /data-block="text0002"[^>]*lang=/.test(html)], [true, false]);
  const stale = { ...marked, heading: "Por qué hablamos" } as PageBlock;
  is("rewritten since, it says nothing", /lang=/.test(draw([stale])), false);
}

done();
