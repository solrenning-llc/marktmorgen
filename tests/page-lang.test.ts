/**
 * The language of a page and of a block left untranslated (inbox C4-19 (c),
 * C4-26 (2)). A page says the language its words are in when it is known
 * (made in the studio, or translated); a block a translation had to leave as
 * it was says the language it is still in, so the page draws it with that
 * lang (WCAG 3.1.2). When the language is not known, nothing is marked: a
 * wrong lang is worse than none. A mark holds only while the block's words
 * are the ones it was marked with.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, PageSections } from "@/components/sales-blocks";
import { keepEveryBlock, keptMarks, marksOf, pageWords, withWords } from "@/lib/page-translate";
import { PAGE_LANGUAGES, type PageBlock, type SalesPage, parsePage } from "@/lib/sales-page";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const booking = (extra: Record<string, unknown> = {}) => ({ id: "book0001", kind: "booking", product: "call000001", heading: "x".repeat(95), ...extra });
const text = (id: string, heading: string) => ({ id, kind: "text", heading, body: "Twenty minutes." });
// Every word a little longer, as a translation into Spanish may make it: the booking's heading no longer fits.
const longer = (page: SalesPage) => withWords(page, pageWords(page).map((w) => `${w} (traducido al español)`));
const langs = (blocks: PageBlock[] | undefined) => (blocks ?? []).map((b) => b.lang ?? null);

part("A page and a block keep a language only when it is one of the store languages");
{
  is("the page's list of languages is the store's", [...PAGE_LANGUAGES], [...LANGUAGE_CODES]);
  const read = parsePage({ lang: "en", blocks: [{ ...text("text0001", "Why"), lang: "de" }, { ...text("text0002", "How"), lang: "klingon" }] });
  is("the page's and the block's own are kept; anything else is dropped", [read.lang, langs(read.blocks)], ["en", ["de", null]]);
  is("a page with none says none", "lang" in parsePage({ blocks: [text("text0001", "Why")] }), false);
}

part("A translation says the page's new language, and the language of each block it left as it was");
{
  const page = parsePage({ lang: "en", blocks: [booking(), text("text0001", "Why talk")] });
  const kept = keepEveryBlock(page, longer(page), "es");
  is("the page is now in Spanish", kept.page.lang, "es");
  is("the block left as it was says English; the translated one says nothing of its own", [kept.page.blocks.map((b) => b.kind), langs(kept.page.blocks), kept.untranslated], [["booking", "text"], ["en", null], 1]);

  const unknown = parsePage({ blocks: [booking(), text("text0001", "Why talk")] });
  const notKnown = keepEveryBlock(unknown, longer(unknown), "es");
  is("a page whose language is not known: the block left as it was is not marked", [langs(notKnown.page.blocks), notKnown.untranslated], [[null, null], 1]);

  const back = keepEveryBlock(kept.page, longer(kept.page), "en");
  is("translated back into English, the English block left as it was is no longer marked", langs(back.page.blocks), [null, null]);

  const third = keepEveryBlock(kept.page, longer(kept.page), "de");
  is("into a third language, the block keeps the language it is really in", langs(third.page.blocks), ["en", null]);

  const twoVersions = parsePage({ lang: "en", blocks: [booking(), text("text0001", "Why talk")], variant: { id: "", blocks: [booking(), text("text0001", "Why not")] } });
  const both = keepEveryBlock(twoVersions, longer(twoVersions), "es");
  is("the second version's block left as it was is marked too", langs(both.page.variant?.blocks), ["en", null]);

  const noTarget = keepEveryBlock(page, longer(page));
  is("without the language asked for, nothing is marked or changed", [noTarget.page.lang, langs(noTarget.page.blocks)], ["en", [null, null]]);
}

part("A mark holds only while the block's words are the ones it was marked with");
{
  const page = parsePage({ lang: "en", blocks: [booking(), text("text0001", "Why talk")] });
  const translated = keepEveryBlock(page, longer(page), "es").page;
  const marks = marksOf(translated);
  is("unchanged, the mark stays", langs(keptMarks(translated, marks).blocks), ["en", null]);
  const edited = { ...translated, blocks: translated.blocks.map((b) => (b.kind === "booking" ? { ...b, heading: "Hablemos primero" } : b)) };
  is("rewritten by hand, its language is no longer known and the mark goes", langs(keptMarks(edited, marks).blocks), [null, null]);
  const moved = { ...translated, blocks: [...translated.blocks].reverse() };
  is("moved, not rewritten, the mark stays", langs(keptMarks(moved, marks).blocks), [null, "en"]);
  const forged = { ...translated, blocks: translated.blocks.map((b) => (b.kind === "text" ? { ...b, lang: "fr" as const } : b)) };
  is("a mark the studio never made is not kept", langs(keptMarks(forged, marks).blocks), ["en", null]);
}

part("The page draws a block's own language");
{
  const ctx = { storeName: "Kiln Works", productTitle: "Glaze Guide", lang: "es", preview: false } as unknown as BlockContext;
  const draw = (blocks: PageBlock[]) => renderToStaticMarkup(createElement(PageSections, { blocks, ctx, style: "plain", reviewsFor: () => null }));
  const marked = parsePage({ blocks: [{ ...text("text0001", "Why we talk"), lang: "en" }, text("text0002", "Por qué")] }).blocks;
  const html = draw(marked);
  is("the block in English says lang=\"en\"; the other says nothing of its own", [/data-block="text0001"[^>]*lang="en"/.test(html), /data-block="text0002"[^>]*lang=/.test(html)], [true, false]);
}

done();
