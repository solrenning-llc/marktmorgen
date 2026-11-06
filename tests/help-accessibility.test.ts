/**
 * The help center's "Accessibility" section (274 [AX1] Part B.3: help for
 * creators to make what they sell easier for everyone to use), held to the
 * code it describes (VR):
 *
 *   - the studio's two checks, by the very titles and field label they show
 *     (components/store-access-check.tsx, components/course-access-check.tsx),
 *     and the button contrast every store gets, word for word as the studio
 *     says it (lib/store-access-check.ts, ACCESS_DONE_FOR_YOU);
 *   - files are handed over as uploaded, apart from the stamping line
 *     (lib/pdf-stamp.ts), so the guidance is the creator's own steps;
 *   - a statement a creator can paste into "Questions on your store page"
 *     (components/faq-editor.tsx), which fits the store's own limits
 *     (lib/store-faq.ts, MAX_FAQ_Q and MAX_FAQ_A) and never claims
 *     conformity (AX274 Part A item 7);
 *   - plain words (AX274 3.1.5): short sentences, terms explained where used;
 *   - each answer fits whole in what the studio's help assistant reads of an
 *     answer (2,500 characters, lib/ai.ts answerHelp), so the assistant's cost
 *     does not move, and the assistant finds them (lib/help-ask.ts);
 *   - the studio's check links to the section, in the same place every time
 *     (WCAG 3.3.5, 3.2.6), with a 44 px target.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { ACCESS_HELP_QUESTIONS, ACCESS_HELP_SECTION, STORE_STATEMENT } from "@/lib/help-accessibility";
import { pickHelp } from "@/lib/help-ask";
import { MAX_FAQ_A, MAX_FAQ_Q, parseFaq } from "@/lib/store-faq";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const storeCheck = read("components/store-access-check.tsx");
const courseCheck = read("components/course-access-check.tsx");
const faqEditor = read("components/faq-editor.tsx");
const accessLib = read("lib/store-access-check.ts");
const stamp = read("lib/pdf-stamp.ts");
const aiSource = read("lib/ai.ts");

const section = HELP_SECTIONS.find((entry) => entry.id === "accessibility");
const answer = (q: string) => (section?.items.find((item) => item.q === q)?.a ?? []).join("\n\n");
const studio = answer(ACCESS_HELP_QUESTIONS.studio);
const files = answer(ACCESS_HELP_QUESTIONS.files);
const statement = answer(ACCESS_HELP_QUESTIONS.statement);
const everything = [section?.title ?? "", section?.blurb ?? "", ...(section?.items ?? []).flatMap((item) => [item.q, ...item.a])].join("\n");

part("The section is in the help center, once");
is("the help center has an 'accessibility' section", section === ACCESS_HELP_SECTION, true);
is("it is there once", HELP_SECTIONS.filter((entry) => entry.id === "accessibility").length, 1);
is("it holds the three questions, in order", section?.items.map((item) => item.q), [ACCESS_HELP_QUESTIONS.studio, ACCESS_HELP_QUESTIONS.files, ACCESS_HELP_QUESTIONS.statement]);
is("no other section asks them", HELP_SECTIONS.filter((entry) => entry.id !== "accessibility").flatMap((entry) => entry.items).some((item) => Object.values(ACCESS_HELP_QUESTIONS).includes(item.q as never)), false);

part("What the studio does, as the studio says it");
is("names the store check by its own title, as the panel shows it", [studio.includes("“Can everyone use your store?”"), storeCheck.includes("Can everyone use your store?")], [true, true]);
is("names the picture field by its own label", [studio.includes("What the picture shows, for people who cannot see it"), storeCheck.includes("What the picture shows, for people who cannot see it")], [true, true]);
is("says it checks the first page of products and the links on the page", [/first page of your store/.test(studio), /links on (its|your store.s) page/.test(studio)], [true, true]);
is("names the course check by its own title", [studio.includes("“Can everyone follow your lessons?”"), courseCheck.includes("Can everyone follow your lessons?")], [true, true]);
is("names the caption files the course editor takes", [/\.vtt/.test(studio) && /\.srt/.test(studio), /\.srt/.test(read("lib/captions.ts")) || /srt/.test(read("lib/captions.ts"))], [true, true]);
const contrastLine = (accessLib.match(/"If a button color[^"]+"/) ?? [""])[0].slice(1, -1);
is("the contrast every store gets, word for word as the studio says it", [contrastLine.length > 0, studio.includes(contrastLine)], [true, true]);
is("says the checks change nothing and are not a full review", [/never change/i.test(studio), /not a full review/.test(studio), /not a full accessibility review/.test(storeCheck)], [true, true, true]);
is("explains 'screen reader' where it is used", /screen reader is a program that reads/.test(studio), true);
is("explains 'captions' where it is used", /Captions show what is said in a video as text/.test(studio), true);

part("Files: what we do and what the creator does");
is("says the file is handed over as uploaded, apart from stamping, as lib/pdf-stamp.ts does", [/as you uploaded it/.test(files), /stamping/.test(files), /handed over as (they were|it was) uploaded/.test(stamp)], [true, true, true]);
for (const [what, pattern] of [
  ["heading styles", /heading styles/],
  ["a description of each picture, called alt text", /alt text/],
  ["decorative pictures", /decorative/],
  ["real text, never a picture of words", /real text/],
  ["the document's language", /language/],
  ["a header row in tables", /header row/],
  ["links that say where they go", /say where (it|they) go/],
  ["never by color alone", /color alone/],
  ["keeping the structure when saving as PDF", /save as PDF/],
  ["checking reading order", /reading order/],
  ["EPUB lets the text grow and flow", /EPUB[\s\S]*bigger[\s\S]*flow/],
] as const) is(`guides on ${what}`, pattern.test(files), true);
is("expands EPUB the first time it is used", /ebook file called an EPUB|EPUB \(an ebook file\)|ebook \(EPUB\)/.test(files), true);

part("The store statement fits the store's own questions");
is("the template question fits a store question", STORE_STATEMENT.q.length <= MAX_FAQ_Q, true);
is("the template answer fits a store answer whole", STORE_STATEMENT.a.length <= MAX_FAQ_A, true);
is("it is kept whole by the store's own rules", parseFaq([STORE_STATEMENT]), [STORE_STATEMENT]);
is("the help answer gives both, word for word", [statement.includes(STORE_STATEMENT.q), statement.includes(STORE_STATEMENT.a)], [true, true]);
is("names where to paste it, as the studio titles it", [statement.includes("“Questions on your store page”"), faqEditor.includes("Questions on your store page")], [true, true]);
const brackets = STORE_STATEMENT.a.match(/\[[^\]]+\]/g) ?? [];
is("the creator fills in what was done, what is hard, how to reach them and when it was checked", [brackets.length >= 4, /\[[^\]]*email[^\]]*\]/i.test(STORE_STATEMENT.a), /\[[^\]]*(month|date)[^\]]*\]/i.test(STORE_STATEMENT.a)], [true, true, true]);
is("says what may still be hard, not only what was done", /may still be hard/.test(STORE_STATEMENT.a), true);
is("promises no reply time", /within \d|hours|business days|24\/7/i.test(STORE_STATEMENT.a), false);

part("No conformity claim anywhere (AX274 Part A item 7)");
for (const banned of [/fully accessible/i, /\bADA\b/, /WCAG/, /certified/i, /\bcompliant\b/i, /\bcompliance\b/i, /most accessible/i, /100%/, /guarantee/i]) {
  is(`never ${banned}`, banned.test(everything), false);
}
is("does not pose as legal advice", /not legal advice/.test(statement), true);

part("Plain words (AX274 3.1.5)");
const sentences = everything
  .replace(/\[[^\]]+\]/g, "it")
  .split(/(?<=[.?!:])\s+|\n+/)
  .map((s) => s.trim())
  .filter(Boolean);
const long = sentences.filter((s) => s.split(/\s+/).length > 30);
is("no sentence over 30 words", long, []);
const words = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
is("sentences average 20 words or fewer", words / sentences.length <= 20, true);

part("The help assistant reads each answer whole, at no new cost");
is("lib/ai.ts still cuts an answer at 2,500 characters", /block\(p\.a, 2_500\)/.test(aiSource), true);
for (const item of section?.items ?? []) is(`"${item.q}" fits in 2,500 characters`, item.a.join("\n\n").length <= 2_500, true);
is("asked about PDFs, the files answer comes first", pickHelp("How do I make my PDF accessible?")[0]?.q, ACCESS_HELP_QUESTIONS.files);
is("asked for a statement, the statement answer comes first", pickHelp("accessibility statement for my store")[0]?.q, ACCESS_HELP_QUESTIONS.statement);

part("The studio's check links to the help, in the same place");
is("the store check links to the section", [/<Link\s+href=\{ACCESS_HELP_HREF\}/.test(storeCheck), /ACCESS_HELP_HREF = `\/help#\$\{ACCESS_HELP_SECTION\.id\}`/.test(read("lib/help-accessibility.ts"))], [true, true]);
is("the link's words say where it goes", /Accessibility help for your files and store/.test(storeCheck), true);
is("its target is at least 44 px tall", /<Link\s+href=\{ACCESS_HELP_HREF\}\s+className="[^"]*min-h-\[44px\][^"]*"/.test(storeCheck), true);
is("the section's anchor is the one the page gives it", answerId("Accessibility") === "accessibility" && ACCESS_HELP_SECTION.id === "accessibility", true);

done();
