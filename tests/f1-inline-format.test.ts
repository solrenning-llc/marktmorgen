/**
 * Inline formatting for the page editor's preview (32 [F1], with the 375
 * [TB1] complement of 29 October 2026, 10h58: the floating bar's bold,
 * italic and link, and lists): the pure rules in lib/inline-format.ts. No UI
 * in this unit; the bar comes next (components/page-editor.tsx).
 *
 * What is checked, against the real module:
 *
 *   - bold, italic and a link become runs of the shape the community already
 *     draws (lib/community-text.ts, Segment: text or link), with bold and
 *     italic as flags, and adjacent runs that look the same are one run;
 *   - a list is a row's list (one item per line), each item its own runs;
 *   - the creator's words come back exactly: the plain text of a proposal is
 *     the text sent, and nothing sent is changed (the function only proposes);
 *   - refused with a reason, never cleaned into something else: raw HTML,
 *     javascript:, data:, mailto: and http links, an address that is not in
 *     the form the page keeps (the fix is offered, not applied), link words
 *     that do not say where it goes, overlapping or nested marks, a mark that
 *     splits a link or crosses a list item, text over the row's caps, text
 *     not in the form a page keeps, control characters, unknown or malformed
 *     requests;
 *   - a stored block is read back only when it is exactly what the rules
 *     would propose from its own words and marks (well-formed and minimal).
 */
import {
  INLINE_PROBLEM_WORDS,
  MAX_INLINE_DEPTH,
  MAX_INLINE_LINKS,
  MAX_INLINE_MARKS,
  type InlineBlock,
  plainTextOf,
  proposeInlineFormat,
  readInlineBlock,
} from "@/lib/inline-format";
import { MAX_ITEM, MAX_ROW_LIST_ITEMS, MAX_ROW_PARAGRAPH } from "@/lib/sales-page";
import { done, is, part } from "./check";

const SITE = "https://example.com/planner";
const para = (marks: unknown[]) => ({ as: "paragraph", marks });
const list = (marks: unknown[]) => ({ as: "list", marks });
const problemOf = (text: unknown, request: unknown) => {
  const got = proposeInlineFormat(text, request);
  return got.ok ? "ok" : got.problem;
};
const blockOf = (text: unknown, request: unknown): InlineBlock | string => {
  const got = proposeInlineFormat(text, request);
  return got.ok ? got.block : got.problem;
};

part("Plain text stays plain, and exact");
{
  is("no marks: one plain run", blockOf("Plan a week in ten minutes.", para([])), { kind: "paragraph", runs: [{ kind: "text", text: "Plan a week in ten minutes." }] });
  const text = "Write what you have.\n\nThe planner does the rest.";
  const got = proposeInlineFormat(text, para([]));
  is("a paragraph's line breaks are kept", got.ok ? plainTextOf(got.block) : got.problem, text);
}

part("Bold, italic and a link become runs");
{
  const text = "Plan a week in ten minutes with the planner.";
  is(
    "bold on two words",
    blockOf(text, para([{ kind: "bold", start: 0, end: 11 }])),
    { kind: "paragraph", runs: [{ kind: "text", text: "Plan a week", bold: true }, { kind: "text", text: " in ten minutes with the planner." }] },
  );
  is(
    "bold and italic overlapping: flags split the runs",
    blockOf(text, para([{ kind: "bold", start: 0, end: 11 }, { kind: "italic", start: 5, end: 26 }])),
    {
      kind: "paragraph",
      runs: [
        { kind: "text", text: "Plan ", bold: true },
        { kind: "text", text: "a week", bold: true, italic: true },
        { kind: "text", text: " in ten minutes", italic: true },
        { kind: "text", text: " with the planner." },
      ],
    },
  );
  is(
    "a link with words that say where it goes",
    blockOf(text, para([{ kind: "link", start: 36, end: 43, href: SITE }])),
    { kind: "paragraph", runs: [{ kind: "text", text: "Plan a week in ten minutes with the " }, { kind: "link", text: "planner", href: SITE }, { kind: "text", text: "." }] },
  );
  is(
    "a bold link: the bold covers the whole link",
    blockOf(text, para([{ kind: "link", start: 36, end: 43, href: SITE }, { kind: "bold", start: 32, end: 44 }])),
    {
      kind: "paragraph",
      runs: [
        { kind: "text", text: "Plan a week in ten minutes with " },
        { kind: "text", text: "the ", bold: true },
        { kind: "link", text: "planner", href: SITE, bold: true },
        { kind: "text", text: ".", bold: true },
      ],
    },
  );
  is(
    "two bold marks that touch make one run (minimal)",
    blockOf(text, para([{ kind: "bold", start: 0, end: 4 }, { kind: "bold", start: 4, end: 11 }])),
    { kind: "paragraph", runs: [{ kind: "text", text: "Plan a week", bold: true }, { kind: "text", text: " in ten minutes with the planner." }] },
  );
  is("marks given in any order give the same runs", JSON.stringify(blockOf(text, para([{ kind: "italic", start: 5, end: 26 }, { kind: "bold", start: 0, end: 11 }]))), JSON.stringify(blockOf(text, para([{ kind: "bold", start: 0, end: 11 }, { kind: "italic", start: 5, end: 26 }]))));
}

part("A list: one item per line, each with its own runs");
{
  const text = "Shopping list\nSeven dinners\nThe planner";
  is(
    "items with a bold word and a link",
    blockOf(text, list([{ kind: "bold", start: 0, end: 8 }, { kind: "link", start: 32, end: 39, href: SITE }])),
    {
      kind: "list",
      items: [
        [{ kind: "text", text: "Shopping", bold: true }, { kind: "text", text: " list" }],
        [{ kind: "text", text: "Seven dinners" }],
        [{ kind: "text", text: "The " }, { kind: "link", text: "planner", href: SITE }],
      ],
    },
  );
  const got = proposeInlineFormat(text, list([]));
  is("a list's plain text is its items, one per line", got.ok ? plainTextOf(got.block) : got.problem, text);
  is("a mark across two items is refused", problemOf(text, list([{ kind: "bold", start: 9, end: 20 }])), "mark_crosses_item");
  is("an empty item is refused, not dropped", problemOf("Shopping list\n\nSeven dinners", list([])), "list_empty_item");
  is(`more than ${MAX_ROW_LIST_ITEMS} items is refused, not cut`, problemOf(Array.from({ length: MAX_ROW_LIST_ITEMS + 1 }, (_, i) => `Item ${i + 1}`).join("\n"), list([])), "too_many_items");
  is(`${MAX_ROW_LIST_ITEMS} items is fine`, problemOf(Array.from({ length: MAX_ROW_LIST_ITEMS }, (_, i) => `Item ${i + 1}`).join("\n"), list([])), "ok");
  is(`an item over ${MAX_ITEM} characters is refused`, problemOf(`${"a".repeat(MAX_ITEM + 1)}\nShort`, list([])), "item_too_long");
  is("an item with two spaces in a row is not in the form a list keeps", problemOf("Shopping  list\nSeven dinners", list([])), "not_saved_form");
}

part("The creator's words are never changed: the rules only propose");
{
  const text = "Plan a week in ten minutes.";
  const request = Object.freeze({ as: "paragraph", marks: Object.freeze([Object.freeze({ kind: "bold", start: 0, end: 4 })]) });
  const got = proposeInlineFormat(text, request);
  is("a frozen request is read, not written", got.ok, true);
  is("the plain text of the proposal is the text sent", got.ok ? plainTextOf(got.block) : "", text);
  is("the request is left as sent", JSON.stringify(request), JSON.stringify({ as: "paragraph", marks: [{ kind: "bold", start: 0, end: 4 }] }));
  is("an address that needs https:// is refused with the fix offered, not applied", proposeInlineFormat("Get the planner now.", para([{ kind: "link", start: 8, end: 15, href: "example.com/planner" }])), {
    ok: false,
    problem: "link_not_https",
    words: INLINE_PROBLEM_WORDS.link_not_https,
    fix: "https://example.com/planner",
  });
  is("an http address is refused with the https one offered", proposeInlineFormat("Get the planner now.", para([{ kind: "link", start: 8, end: 15, href: "http://example.com/planner" }])), {
    ok: false,
    problem: "link_not_https",
    words: INLINE_PROBLEM_WORDS.link_not_https,
    fix: "https://example.com/planner",
  });
}

part("Raw HTML is refused, never cleaned");
{
  for (const text of ["Plan a <b>week</b>.", "Hello <script>alert(1)</script>", "An <img src=x onerror=alert(1)> picture", "A note <!-- hidden -->", "Close </p> here"]) {
    is(`refused: ${JSON.stringify(text)}`, problemOf(text, para([])), "html");
  }
  is("a less-than sign in a sentence is words, not HTML", problemOf("3 < 5 and 7 > 2", para([])), "ok");
  is("an HTML entity is shown as typed, not refused", problemOf("Fish &amp; chips", para([])), "ok");
}

part("Links follow the page's own rule (quoteUrl): https only");
{
  const text = "Read the planner guide.";
  for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>", "mailto:me@example.com", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
    is(`refused scheme: ${JSON.stringify(href)}`, problemOf(text, para([{ kind: "link", start: 9, end: 22, href }])), "link_scheme");
  }
  for (const href of ["https://user:pw@example.com/", "https://localhost/a", "https://127.0.0.1/a", "https://intranet/a", `https://example.com/${"a".repeat(400)}`, ""]) {
    is(`refused address: ${JSON.stringify(href.slice(0, 40))}`, problemOf(text, para([{ kind: "link", start: 9, end: 22, href }])), "link_not_https");
  }
  is("a link's href must be a string", problemOf(text, para([{ kind: "link", start: 9, end: 22, href: 42 }])), "unknown_mark");
  const vague = "Click here for the planner guide.";
  for (const [start, end] of [[0, 10], [6, 10]]) {
    is(`link words that do not say where it goes are refused (${vague.slice(start, end)})`, problemOf(vague, para([{ kind: "link", start, end, href: SITE }])), "link_words");
  }
  is("the same link on words that say where it goes is fine", problemOf(vague, para([{ kind: "link", start: 19, end: 32, href: SITE }])), "ok");
  is("an address as the link's words is refused", problemOf(`Go to ${SITE} now.`, para([{ kind: "link", start: 6, end: 6 + SITE.length, href: SITE }])), "link_words");
  is("a link across a line break is refused", problemOf("Read the planner\nguide.", para([{ kind: "link", start: 9, end: 22, href: SITE }])), "link_crosses_line");
  const many = Array.from({ length: MAX_INLINE_LINKS + 1 }, (_, i) => `Guide ${String.fromCharCode(97 + i)}`).join(" ");
  const links = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "link", start: i * 8, end: i * 8 + 7, href: `${SITE}/${i}` }));
  is(`${MAX_INLINE_LINKS} links is fine`, problemOf(many, para(links(MAX_INLINE_LINKS))), "ok");
  is(`more than ${MAX_INLINE_LINKS} links is refused`, problemOf(many, para(links(MAX_INLINE_LINKS + 1))), "too_many_links");
}

part("Nesting and overlap stay within the stated caps");
{
  const text = "Plan a week in ten minutes with the planner.";
  is("the stated depth: a link, bold and italic", MAX_INLINE_DEPTH, 3);
  is("a link inside a link is refused", problemOf(text, para([{ kind: "link", start: 32, end: 43, href: SITE }, { kind: "link", start: 36, end: 43, href: `${SITE}/b` }])), "links_overlap");
  is("two links that touch are refused (one would read as the other)", problemOf(text, para([{ kind: "link", start: 32, end: 35, href: SITE }, { kind: "link", start: 35, end: 43, href: `${SITE}/b` }])), "links_overlap");
  is("bold over bold is refused, not merged", problemOf(text, para([{ kind: "bold", start: 0, end: 11 }, { kind: "bold", start: 5, end: 20 }])), "marks_overlap");
  is("italic inside a link splits it and is refused", problemOf(text, para([{ kind: "link", start: 36, end: 43, href: SITE }, { kind: "italic", start: 36, end: 40 }])), "mark_splits_link");
  is("bold over half a link is refused", problemOf(text, para([{ kind: "link", start: 36, end: 43, href: SITE }, { kind: "bold", start: 40, end: 44 }])), "mark_splits_link");
  const marks = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "italic" : "bold", start: i, end: i + 1 }));
  const long = "a".repeat(MAX_INLINE_MARKS + 2);
  is(`${MAX_INLINE_MARKS} marks is fine`, problemOf(long, para(marks(MAX_INLINE_MARKS))), "ok");
  is(`more than ${MAX_INLINE_MARKS} marks is refused before any is read`, problemOf(long, para([...marks(MAX_INLINE_MARKS), { kind: "nonsense" }])), "too_many_marks");
}

part("Length and the form a page keeps");
{
  is(`a paragraph of ${MAX_ROW_PARAGRAPH} characters is fine`, problemOf("a".repeat(MAX_ROW_PARAGRAPH), para([])), "ok");
  is(`a paragraph over ${MAX_ROW_PARAGRAPH} characters is refused, not cut`, problemOf("a".repeat(MAX_ROW_PARAGRAPH + 1), para([])), "too_long");
  is("empty text is refused", problemOf("", para([])), "empty");
  is("a space at the end is not in the form a page keeps", problemOf("Plan a week ", para([])), "not_saved_form");
  is("three line breaks in a row are not in the form a page keeps", problemOf("One\n\n\nTwo", para([])), "not_saved_form");
  is("a space before a line break is not in the form a page keeps", problemOf("One \nTwo", para([])), "not_saved_form");
  for (const ch of ["\u0000", "\r", "\t", "\u007f", "\u0085", "\u2028", "\u202e", "\u2066"]) {
    is(`a control character (U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}) is refused, not dropped`, problemOf(`Plan${ch}a week`, para([])), "control_character");
  }
}

part("Unknown or malformed input is refused with a reason");
{
  const text = "Plan a week in ten minutes.";
  is("text that is not a string", problemOf(42, para([])), "not_text");
  is("a request that is not an object", problemOf(text, "bold"), "unknown_request");
  is("a request with an unknown shape", problemOf(text, { as: "heading", marks: [] }), "unknown_request");
  is("a request with an extra field", problemOf(text, { as: "paragraph", marks: [], html: "<b>" }), "unknown_request");
  is("marks that are not a list", problemOf(text, { as: "paragraph", marks: {} }), "unknown_request");
  is("an unknown mark (underline is not in this unit)", problemOf(text, para([{ kind: "underline", start: 0, end: 4 }])), "unknown_mark");
  is("a mark with an extra field", problemOf(text, para([{ kind: "bold", start: 0, end: 4, style: "color:red" }])), "unknown_mark");
  for (const [start, end] of [[4, 4], [5, 2], [-1, 3], [0, text.length + 1], [0.5, 3], ["0", 3]]) {
    is(`a range that is not one (${JSON.stringify([start, end])})`, problemOf(text, para([{ kind: "bold", start, end }])), "bad_range");
  }
  is("a range that splits a character in two", problemOf("Plan 🗓 a week", para([{ kind: "bold", start: 0, end: 6 }])), "bad_range");
  is("a range around a whole character is fine", problemOf("Plan 🗓 a week", para([{ kind: "bold", start: 5, end: 7 }])), "ok");
  for (const key of Object.keys(INLINE_PROBLEM_WORDS) as (keyof typeof INLINE_PROBLEM_WORDS)[]) {
    const words = INLINE_PROBLEM_WORDS[key];
    is(`the reason "${key}" has plain words of its own`, typeof words === "string" && words.length > 10 && words.length < 160 && !/[<>]/.test(words), true);
  }
}

part("A stored block is read back only when well-formed and minimal");
{
  const text = "Plan a week in ten minutes with the planner.";
  const made = proposeInlineFormat(text, para([{ kind: "bold", start: 0, end: 11 }, { kind: "italic", start: 5, end: 26 }, { kind: "link", start: 36, end: 43, href: SITE }]));
  const back = made.ok ? readInlineBlock(JSON.parse(JSON.stringify(made.block))) : made;
  is("a proposal reads back as itself", back.ok ? JSON.stringify(back.block) : back.problem, made.ok ? JSON.stringify(made.block) : "");
  const listMade = proposeInlineFormat("Shopping list\nThe planner", list([{ kind: "bold", start: 0, end: 8 }, { kind: "link", start: 18, end: 25, href: SITE }]));
  const listBack = listMade.ok ? readInlineBlock(JSON.parse(JSON.stringify(listMade.block))) : listMade;
  is("a list proposal reads back as itself", listBack.ok ? JSON.stringify(listBack.block) : listBack.problem, listMade.ok ? JSON.stringify(listMade.block) : "");
  const read = (raw: unknown) => {
    const got = readInlineBlock(raw);
    return got.ok ? "ok" : got.problem;
  };
  is("two runs that look the same are not minimal", read({ kind: "paragraph", runs: [{ kind: "text", text: "Plan " }, { kind: "text", text: "a week" }] }), "malformed");
  is("bold: false is not minimal", read({ kind: "paragraph", runs: [{ kind: "text", text: "Plan", bold: false }] }), "malformed");
  is("an empty run is malformed", read({ kind: "paragraph", runs: [{ kind: "text", text: "" }] }), "malformed");
  is("a run with HTML in a field of its own is malformed", read({ kind: "paragraph", runs: [{ kind: "text", text: "Plan", html: "<b>Plan</b>" }] }), "malformed");
  is("a link nested in a link is malformed", read({ kind: "paragraph", runs: [{ kind: "link", text: "planner", href: SITE, runs: [{ kind: "link", text: "planner", href: SITE }] }] }), "malformed");
  is("an unknown kind is malformed", read({ kind: "heading", runs: [{ kind: "text", text: "Plan" }] }), "malformed");
  is("a stored javascript: link is refused for its scheme", read({ kind: "paragraph", runs: [{ kind: "text", text: "Read the " }, { kind: "link", text: "planner guide", href: "javascript:alert(1)" }] }), "link_scheme");
  is("stored HTML in a run's words is refused", read({ kind: "paragraph", runs: [{ kind: "text", text: "<script>alert(1)</script>" }] }), "html");
  is("a stored list with an item over the cap is refused", read({ kind: "list", items: Array.from({ length: MAX_ROW_LIST_ITEMS + 1 }, () => [{ kind: "text", text: "Item" }]) }), "too_many_items");
  is("a stored list item with a line break is malformed", read({ kind: "list", items: [[{ kind: "text", text: "One\nTwo" }]] }), "malformed");
  is("an empty stored list is refused", read({ kind: "list", items: [] }), "empty");
}

done();
