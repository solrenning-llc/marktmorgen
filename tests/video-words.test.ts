/**
 * Every video says what it shows in words (inbox C4-16 (g), C4-26 (3);
 * WCAG 1.2.2, 1.2.8): the video block, a row's video and a video in a window
 * may carry the creator's transcript, shown under the video, or the
 * creator's word that the video has captions of its own; the page's checklist
 * asks for one on every video. Nobody can tell from here whether a video on
 * another site has captions, so the creator says so.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView } from "@/components/sales-blocks";
import { VideoTranscript } from "@/components/video-transcript";
import { coachChecks, type CoachInput } from "@/lib/page-coach";
import { TRANSLATE_PART_CHARS, keepEveryBlock, pageWords, withWords } from "@/lib/page-translate";
import { buildBundle } from "@/lib/funnel-bundle";
import { MAX_TRANSCRIPT, type PageBlock, type RowElement, pageProblem, parsePage, saysInWords } from "@/lib/sales-page";
import { done, is, part } from "./check";

const youtube = { provider: "youtube", id: "dQw4w9WgXcQ" };
const videoBlock = (extra: Record<string, unknown> = {}) => ({ id: "vide0001", kind: "video", heading: "A lesson", video: youtube, caption: "", ...extra });
const rowWith = (...elements: Record<string, unknown>[]) => ({ id: "row00001", kind: "row", columns: [elements] });
const rowVideo = (extra: Record<string, unknown> = {}) => ({ kind: "video", video: youtube, title: "The tour", ...extra });
const windowed = (extra: Record<string, unknown> = {}) => ({ kind: "video-window", video: youtube, title: "The tour", label: "Watch the tour", ...extra });
const read = (blocks: unknown[], variant?: unknown[]) => parsePage({ blocks, ...(variant ? { variant: { id: "", blocks: variant } } : {}) });

part("What a video says is kept only as given");
{
  is("a transcript as long as one translation part, at the most", MAX_TRANSCRIPT <= TRANSLATE_PART_CHARS, true);
  const kept = read([videoBlock({ transcript: "  Hello.\r\n\r\nToday we bake.  ", captioned: true })]).blocks[0] as PageBlock & { transcript?: string; captioned?: boolean };
  is("the video block keeps its transcript, tidied, and its captions", [kept.transcript, kept.captioned], ["Hello.\n\nToday we bake.", true]);
  const plain = read([videoBlock({ captioned: "yes", transcript: "   " })]).blocks[0];
  is("anything but true is not captions, and an empty transcript is none: a page saved before keeps its shape", ["captioned" in plain, "transcript" in plain], [false, false]);
  is("a transcript longer than the most is cut there", ((read([videoBlock({ transcript: "w".repeat(MAX_TRANSCRIPT + 50) })]).blocks[0] as { transcript?: string }).transcript ?? "").length, MAX_TRANSCRIPT);
  const row = read([rowWith(rowVideo({ transcript: "Step one." }), windowed({ captioned: true }))]).blocks[0];
  const parts = row.kind === "row" ? (row.columns[0] as (RowElement & { transcript?: string; captioned?: boolean })[]) : [];
  is("a row's video and a video in a window keep theirs", [parts[0]?.transcript, parts[1]?.captioned], ["Step one.", true]);
  is("captions or a transcript, either says it in words", [saysInWords({ captioned: true }), saysInWords({ transcript: "Hi" }), saysInWords({ transcript: "  " }), saysInWords({})], [true, true, false, false]);
}

part("A transcript too long is told back or left as it was, never cut (review of the unit)");
{
  const long = "w".repeat(MAX_TRANSCRIPT + 1);
  const sentVideo = { blocks: [videoBlock({ transcript: long })] };
  is("a video block's: the save is refused with its reason", pageProblem(sentVideo, parsePage(sentVideo)), "transcript");
  const sentRow = { blocks: [rowWith(rowVideo({ transcript: long }))] };
  is("a row's video: the row is refused whole", pageProblem(sentRow, parsePage(sentRow)), "row");
  const sentHero = { blocks: [{ id: "hero0001", kind: "hero", headline: "Hi", sub: "", media: "video", video: youtube, transcript: long }] };
  is("the video at the top's too", pageProblem(sentHero, parsePage(sentHero)), "transcript");
  // A transcript near the most, which a translation makes longer than it may be.
  const near = read([videoBlock({ transcript: "Hello there. ".repeat(300).trim() }), rowWith(rowVideo({ transcript: "Step one. ".repeat(390).trim() }))]);
  const grown = keepEveryBlock(near, withWords(near, pageWords(near).map((w) => `${w} ${w.slice(0, 1_500)}`)));
  const kept = grown.page.blocks[0] as { transcript?: string };
  is("translated longer than the most: the block stays as it was, counted, never cut", [kept.transcript === (near.blocks[0] as { transcript?: string }).transcript, grown.untranslated], [true, 2]);
}

part("The video at the top has words too");
{
  const hero = (extra: Record<string, unknown>) => read([{ id: "hero0001", kind: "hero", headline: "Bake bread", sub: "", ...extra }]).blocks[0] as PageBlock & { transcript?: string; captioned?: boolean };
  is("with a video, its words are kept", [hero({ media: "video", video: youtube, captioned: true, transcript: "Hi." }).captioned, hero({ media: "video", video: youtube, transcript: "Hi." }).transcript], [true, "Hi."]);
  is("with a picture, there are none", ["transcript" in hero({ media: "picture", transcript: "Hi." }), "captioned" in hero({ media: "picture", captioned: true })], [false, false]);
}

part("A shared funnel leaves the sender's video words out with the video");
{
  const page = read([{ id: "hero0001", kind: "hero", headline: "Launch", sub: "", media: "video", video: youtube, transcript: "The sender speaks.", captioned: true }, videoBlock({ transcript: "The sender again.", captioned: true })]);
  const source = {
    name: "Launch",
    steps: [{ kind: "page" as const, id: "page000001" }],
    pages: new Map([["page000001", { meta: { id: "page000001", slug: "launch", title: "Launch", nav: true, target: "", from: 0 }, page }]]),
    forms: new Map(),
    products: new Map(),
  };
  const json = JSON.stringify(buildBundle(source as never, "share").bundle);
  is("no transcript and no captions mark travel without their video", [json.includes("The sender"), json.includes("captioned")], [false, false]);
}

part("The page's checklist asks for words on every video");
{
  const input = (blocks: PageBlock[], variant?: PageBlock[]): CoachInput => ({
    page: { blocks, seoDescription: "", test: null, ...(variant ? { variant: { blocks: variant } as never } : {}) },
    productTitle: "Bread basics",
    free: false,
    picture: false,
    pictureAlt: "",
    facts: {},
  });
  const check = (blocks: unknown[], variant?: unknown[]) => coachChecks(input(read(blocks).blocks, variant ? read(variant).blocks : undefined)).find((c) => c.id === "video_words");
  is("no video, no question", check([{ id: "text0001", kind: "text", heading: "", body: "Words" }]), undefined);
  const bare = check([videoBlock(), rowWith(rowVideo(), windowed())]);
  is("three videos with no words: not done, and counted", [bare?.done, bare?.label], [false, "Every video says what it shows in words (3 do not)"]);
  const some = check([videoBlock({ transcript: "Hello." }), rowWith(rowVideo({ captioned: true }), windowed())]);
  is("one left: said as one", [some?.done, some?.label], [false, "Every video says what it shows in words (1 does not)"]);
  is("all with captions or a transcript: done", check([videoBlock({ captioned: true }), rowWith(windowed({ transcript: "Hi." }))])?.done, true);
  is("the second version's videos count too, said as such", [check([videoBlock({ captioned: true })], [videoBlock({ caption: "B" })])?.done, check([videoBlock({ captioned: true })], [videoBlock({ caption: "B" })])?.label], [false, "Every video says what it shows in words (1 does not, in the second version)"]);
  is("a video both versions show, without words, is one, not two", check([videoBlock()], [videoBlock({ caption: "B" })])?.label, "Every video says what it shows in words (1 does not, in each version)");
  is("the video at the top counts", check([{ id: "hero0001", kind: "hero", headline: "Hi", sub: "", media: "video", video: youtube }])?.done, false);
  is("a video block with no video yet is not a video", check([{ ...videoBlock(), video: null }]), undefined);
}

part("A transcript is translated and checked as the page's words");
{
  const page = read([videoBlock({ transcript: "Hello." }), rowWith(rowVideo({ transcript: "Step one." }), windowed({ transcript: "The tour." }))]);
  const words = pageWords(page);
  is("each transcript is among the words read", ["Hello.", "Step one.", "The tour."].map((w) => words.includes(w)), [true, true, true]);
  const translated = withWords(page, words.map((w) => `${w} (es)`));
  const video = translated.blocks[0] as { transcript?: string };
  const row = translated.blocks[1];
  const parts = row.kind === "row" ? (row.columns[0] as { transcript?: string }[]) : [];
  is("and replaced by its translation", [video.transcript, parts[0]?.transcript, parts[1]?.transcript], ["Hello. (es)", "Step one. (es)", "The tour. (es)"]);
}

part("On the page: a transcript anyone can open, in the store's language, as plain words");
{
  const ctx = { storeName: "Kiln Works", productTitle: "Glaze Guide", lang: "es", preview: false } as unknown as BlockContext;
  const draw = (block: unknown) => renderToStaticMarkup(createElement(BlockView, { block: read([block]).blocks[0], ctx, reviews: null }));
  const html = draw(videoBlock({ transcript: "Hola.\n\nVisit https://example.com for more." }));
  is("a closed <details> under the video, opened by its summary in the store's language", [/<details class="sp-transcript[^"]*"><summary[^>]*>Transcripción<\/summary>/.test(html), html.includes("<details open")], [true, false]);
  is("each paragraph its own, and an address in it is words, not a link", [(html.match(/<p class="whitespace-pre-line">/g) ?? []).length, /<a [^>]*example\.com/.test(html)], [2, false]);
  is("no transcript, nothing drawn", draw(videoBlock()).includes("<details"), false);
  is("a row's video shows its transcript too", draw(rowWith(rowVideo({ transcript: "Paso uno." }))).includes("Paso uno."), true);
  const summary = renderToStaticMarkup(createElement(VideoTranscript, { text: "Hi.", lang: "en" }));
  is("the summary is at least 44 pixels high (WCAG 2.5.5) and says Transcript", [summary.includes("min-h-11"), summary.includes(">Transcript</summary>")], [true, true]);
}

done();
