/**
 * The preview text's rules (537 [PH1], unit 1; added 2 November 2026): kept
 * as plain words up to 120 characters as a reader counts them, refused (never
 * cut) when longer, with markup or a link, or the subject again; text that
 * spells a word or builds an emoji kept whole; first and hidden in the HTML,
 * with spacers, and first line of the plain text; nothing added without one.
 */
import { MAX_PREVIEW, PREVIEW_PROBLEMS, cleanPreview, preheaderHtml, previewLength, withPreviewLine } from "@/lib/preheader";
import { done, is, part } from "./check";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b), BOM = cp(0xfeff), ZWJ = cp(0x200d), ZWNJ = cp(0x200c), RLM = cp(0x200f), RLO = cp(0x202e);
const FAMILY = cp(0x1f468) + ZWJ + cp(0x1f469) + ZWJ + cp(0x1f467);

part("What is kept");
is("none is none", [cleanPreview(""), cleanPreview("   "), cleanPreview(undefined), cleanPreview(42)], Array(4).fill({ ok: true, text: "" }));
is("spaces and line breaks made single, ends trimmed, characters that draw nothing taken out (not made spaces)", cleanPreview(`  Three   recipes\nfor busy${ZWSP} weeks${BOM} `), { ok: true, text: "Three recipes for busy weeks" });
is("what spells a word or builds an emoji is kept whole: joiners, Persian non-joiner, right-to-left mark", [cleanPreview(`New ${FAMILY} recipes`), cleanPreview(`می${ZWNJ}خواهم`), cleanPreview(`20${RLM}% off`)].map((r) => r.ok && r.text), [`New ${FAMILY} recipes`, `می${ZWNJ}خواهم`, `20${RLM}% off`]);
is("a bidi override and a lone surrogate half are taken out", [cleanPreview(`Hi${RLO} there`), cleanPreview(String.fromCharCode(0xd800) + " lone")], [{ ok: true, text: "Hi there" }, { ok: true, text: "lone" }]);
is("counted as a reader counts: an emoji built of several is one", [previewLength(FAMILY), previewLength("é"), previewLength("abc")], [1, 1, 3]);
is("120 characters kept whole, 121 refused, never cut; 120 family emojis kept", [cleanPreview("a".repeat(MAX_PREVIEW)).ok, cleanPreview("a".repeat(MAX_PREVIEW + 1)), cleanPreview(FAMILY.repeat(MAX_PREVIEW)).ok], [true, { ok: false, why: "long" }, true]);
is("markup refused", [cleanPreview("<b>New</b> recipes"), cleanPreview("a > b")], [{ ok: false, why: "markup" }, { ok: false, why: "markup" }]);
is("a link or an address refused, common and country endings alike", ["See https://x.example", "Visit www.example.com", "Read it on example.com", "Write to ana@example.com", "shop.de", "tool.ai", "blog.dev", "bit.ly", "loja.com.br"].map((t) => cleanPreview(t).ok), Array(9).fill(false));
is("ordinary words with a full stop are not taken for one", ["Dr.Smith says hi", "e.g. soups", "3.5 hours", "co-op dinners", "Built with Node.js", "Thanks, me.", "Ready? Go.Shop now", "Read more.Info inside"].map((t) => cleanPreview(t).ok), Array(8).fill(true));
is("not the subject again, in any case, spacing or invisible character", [cleanPreview("Three new recipes", `three  new${ZWSP} recipes`), cleanPreview("Inside: three dinners", "Three new recipes")], [{ ok: false, why: "subject" }, { ok: true, text: "Inside: three dinners" }]);
is("not the subject again behind a character that draws nothing, a soft hyphen or another way of writing the same letter", [
  cleanPreview("Three new recipes", `Three${ZWNJ} new recipes`),
  cleanPreview(`Three${ZWNJ} new recipes`, "Three new recipes"),
  cleanPreview(`Three new${cp(0xad)} recipes`, "Three new recipes"),
  cleanPreview(`Three${cp(0x34f)} new recipes${cp(0xfe0f)}`, "Three new recipes"),
  cleanPreview(`Three new recipes${cp(0xe0041)}${RLM}`, "three new recipes"),
  cleanPreview(`Three${cp(0x3164)}new recipes`, "Three new recipes"),
  cleanPreview("Cafe\u0301 news", "Caf\u00e9 news"),
].map((r) => r.ok ? "kept" : r.why), Array(7).fill("subject"));
is("a preview of characters that draw nothing is refused, never sent as a blank line", [ZWNJ, ZWJ, cp(0xad), cp(0x34f), cp(0xfe0f), cp(0x3164), cp(0xffa0), cp(0x2800), cp(0xe0041, 0xe0042), RLM + cp(0x200e), `${ZWNJ} ${cp(0xad)} ${cp(0x3164)}`].map((t) => cleanPreview(t)), Array(11).fill({ ok: false, why: "blank" }));
is("one letter carrying a pile of marks is refused, however few bytes", [cleanPreview("a" + cp(0x301).repeat(3000)), cleanPreview("Hi a" + cp(0x301).repeat(7) + " there"), cleanPreview("x" + cp(0xe0041).repeat(40))], Array(3).fill({ ok: false, why: "heavy" }));
const HEBREW = "\u05d1\u05bc\u05b0\u05e8\u05b5\u05d0\u05e9\u05c1\u05b4\u05d9\u05ea";
const FAMILY_TONES = cp(0x1f468, 0x1f3fb) + ZWJ + cp(0x1f469, 0x1f3fd) + ZWJ + cp(0x1f467, 0x1f3fe) + ZWJ + cp(0x1f466, 0x1f3ff);
const ENGLAND = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
is("real writing and real emoji are kept: Vietnamese written with marks, Hebrew with its points, Hindi, a keycap, a family with skin tones, a flag", ["Tie\u0302\u0301ng Vie\u0323\u0302t", HEBREW, "\u0938\u094d\u0924\u094d\u0930\u0940", "1" + cp(0xfe0f, 0x20e3), FAMILY_TONES, ENGLAND].map((t) => cleanPreview(t).ok), Array(6).fill(true));
is("every problem has its plain words", Object.keys(PREVIEW_PROBLEMS).sort(), ["blank", "heavy", "link", "long", "markup", "subject"]);

part("In the email");
const html = preheaderHtml("Three dinners & a list");
is("nothing added without one, nor for one its rules refuse", [preheaderHtml(""), preheaderHtml("<b>x</b>"), withPreviewLine("Body.", ""), withPreviewLine("Body.", "a".repeat(200))], ["", "", "Body.", "Body."]);
is("hidden from view, from Outlook and from screen readers, escaped, then spacers enough for the longest previews", [html.startsWith('<div aria-hidden="true" style="display:none;'), html.includes('<span style="mso-hide:all">Three dinners &amp; a list</span>'), (html.match(/&#847;&zwnj;&nbsp;/g) ?? []).length], [true, true, 120]);
is("the plain text's first line, tidied, then a blank line", withPreviewLine("Hello.\nMore.", "Three\ndinners"), "Three dinners\n\nHello.\nMore.");

done();
