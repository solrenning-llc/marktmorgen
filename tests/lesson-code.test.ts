/**
 * Blocks of code in a lesson's text (103 [E2-LESSON-MEDIA], unit 1; added 2
 * November 2026): between lines of three backticks, kept exactly as typed and
 * shown as text, never as markup; reachable by keyboard to scroll; the rest
 * of the text read as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonText } from "@/components/lesson-text";
import { lessonBlocks } from "@/lib/lesson-blocks";
import { done, is, part } from "./check";

const F = "`".repeat(3);

part("The rest of the text, as before");
is("paragraphs on blank lines, lists on dashes, lines of a paragraph kept together", lessonBlocks("First line\nsecond line\n\n- one\n- two\nAfter the list\n\nLast"), [
  { kind: "paragraph", lines: ["First line", "second line"] },
  { kind: "list", items: ["one", "two"] },
  { kind: "paragraph", lines: ["After the list"] },
  { kind: "paragraph", lines: ["Last"] },
]);

part("Code");
const code = ["Intro", "", `${F}js`, "const a = 1;", "", "  if (a < 2) { run(); }", "<script>alert(1)</script>", F, "", "After"].join("\n");
is("kept exactly as typed, blank lines and indentation included, with its language", lessonBlocks(code), [
  { kind: "paragraph", lines: ["Intro"] },
  { kind: "code", language: "js", code: "const a = 1;\n\n  if (a < 2) { run(); }\n<script>alert(1)</script>" },
  { kind: "paragraph", lines: ["After"] },
]);
is("no language; an opening never closed is just text, so it never swallows the rest of a lesson", [lessonBlocks(`${F}\nplain\n${F}`), lessonBlocks(`Text\n${F}\nopen\n\n- a list`)], [[{ kind: "code", language: "", code: "plain" }], [{ kind: "paragraph", lines: ["Text", F, "open"] }, { kind: "list", items: ["a list"] }]]);
is("whatever follows the backticks opens it; only a single word is kept as its language", [lessonBlocks(`${F}my lang\nx\n${F}\nrest`), lessonBlocks(`${F}js extra\nx\n${F}`)], [[{ kind: "code", language: "", code: "x" }, { kind: "paragraph", lines: ["rest"] }], [{ kind: "code", language: "", code: "x" }]]);
is("four backticks open a block that only four or more close, so three inside are code", lessonBlocks(`${"`".repeat(4)}\n${F}\ninside\n${"`".repeat(4)}`), [{ kind: "code", language: "", code: `${F}\ninside` }]);
is("an empty block is not shown", lessonBlocks(`Before\n${F}\n\n${F}\nAfter`), [{ kind: "paragraph", lines: ["Before"] }, { kind: "paragraph", lines: ["After"] }]);
is("a long line of backticks and spaces is read at once (no pattern that goes back over itself)", (() => { const t = Date.now(); lessonBlocks(F + " ".repeat(20000) + "!"); return Date.now() - t < 50; })(), true);
part("On the page");
const html = renderToStaticMarkup(createElement(LessonText, { text: code + "\n\nSee https://example.com/x" }));
is("shown as text, never markup: the script is escaped", [html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html.includes("<script>")], [true, false]);
is("scrolled sideways, reachable by keyboard to scroll, in the store's colors with its own focus ring", [/<pre tabindex="0" data-language="js" class="[^"]*overflow-x-auto[^"]*"><code>const a = 1;\n\n  if \(a &lt; 2\) \{ run\(\); \}/.test(html), html.includes("bg-[var(--st-item)]") && html.includes("text-[var(--st-text)]") && html.includes("focus-visible:outline-[var(--st-accent-text)]"), html.includes('role="region"')], [true, true, false]);
is("a web address outside code is still a link; inside code, it stays text", [html.includes('href="https://example.com/x"'), renderToStaticMarkup(createElement(LessonText, { text: `${F}\nhttps://example.com/y\n${F}` })).includes("href=")], [true, false]);

done();
