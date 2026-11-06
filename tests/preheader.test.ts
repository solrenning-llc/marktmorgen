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
is("every problem has its plain words", Object.keys(PREVIEW_PROBLEMS).sort(), ["link", "long", "markup", "subject"]);

part("In the email");
const html = preheaderHtml("Three dinners & a list");
is("nothing added without one, nor for one its rules refuse", [preheaderHtml(""), preheaderHtml("<b>x</b>"), withPreviewLine("Body.", ""), withPreviewLine("Body.", "a".repeat(200))], ["", "", "Body.", "Body."]);
is("hidden from view, from Outlook and from screen readers, escaped, then spacers enough for the longest previews", [html.startsWith('<div aria-hidden="true" style="display:none;'), html.includes('<span style="mso-hide:all">Three dinners &amp; a list</span>'), (html.match(/&#847;&zwnj;&nbsp;/g) ?? []).length], [true, true, 120]);
is("the plain text's first line, tidied, then a blank line", withPreviewLine("Hello.\nMore.", "Three\ndinners"), "Three dinners\n\nHello.\nMore.");

done();
