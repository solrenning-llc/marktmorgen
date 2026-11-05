/**
 * A ready outline to start a blog post from (487 [IT4], item 5; added 2
 * November 2026): the shapes, read by the blog's own reader; the prompts
 * found exactly, never the creator's own brackets; never published with a
 * prompt left in (the route refuses it, the editor says so first); offered
 * only on an empty post.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BlogEditor } from "@/components/blog-editor";
import { BLOG_OUTLINES, OUTLINE_LEFT_MESSAGE, OUTLINE_PROMPTS, outlinePromptsLeft } from "@/lib/blog-outline";
import { MAX_POST_BODY, cleanPost, postBlocks } from "@/lib/store-blog";
import { done, is, part } from "./check";

part("The outlines");
is("three, each named once", [BLOG_OUTLINES.length, new Set(BLOG_OUTLINES.map((o) => o.id)).size, new Set(BLOG_OUTLINES.map((o) => o.name)).size], [3, 3, 3]);
is("each fits a post and is read by the blog as headings, points and paragraphs", BLOG_OUTLINES.every((o) => o.body.length <= MAX_POST_BODY && postBlocks(o.body).some((b) => b.kind === "heading") && postBlocks(o.body).some((b) => b.kind !== "heading")), true);
is("every part the creator writes is a prompt in brackets: no claim, figure or quotation of ours", BLOG_OUTLINES.every((o) => postBlocks(o.body).every((b) => (b.kind === "heading" ? /^\[.+\]$/.test(b.text) || !/\d/.test(b.text) : true)) && !/\d|“|"/.test(o.body.replace(/\[[^\]]*\]/g, ""))), true);
is("the prompts, each once", [OUTLINE_PROMPTS.length > 10, new Set(OUTLINE_PROMPTS).size === OUTLINE_PROMPTS.length, OUTLINE_PROMPTS.every((p) => /^\[[^\]\n]+\]$/.test(p))], [true, true, true]);

part("Prompts left in a post");
const how = BLOG_OUTLINES[0].body;
is("an outline as the server keeps it still holds all its prompts", outlinePromptsLeft("", cleanPost({ title: "T", body: how, draft: false }).body), how.match(/\[[^\]\n]+\]/g));
is("in the order they appear, from the title too", outlinePromptsLeft("[The first mistake]", "[One sentence your reader should remember.]"), ["[The first mistake]", "[One sentence your reader should remember.]"]);
is("the creator's own brackets are never taken for one", outlinePromptsLeft("[Updated] My guide", "Read the [2026 edition] first."), []);
const written = how.replace(/\[[^\]\n]+\]/g, "My own words.");
is("every prompt replaced: none left", outlinePromptsLeft("A title", written), []);

part("Never published with a prompt left in");
const route = readFileSync("app/api/store/blog/route.ts", "utf8");
is("the route refuses publishing, before anything is saved; a draft is kept", [route.includes('if (!input.draft && outlinePromptsLeft(input.title, input.body).length) return fail("outline_left");'), route.indexOf('fail("outline_left")') < route.indexOf("await savePost(")], [true, true]);
const editor = readFileSync("components/blog-editor.tsx", "utf8");
is("the editor says it first, with the first prompt left, and has words for the route's refusal", [editor.includes("const left = draft ? [] : outlinePromptsLeft(title, body);"), editor.includes("The first one left: ${left[0]}"), editor.includes("outline_left: OUTLINE_LEFT_MESSAGE")], [true, true, true]);
is("the words", OUTLINE_LEFT_MESSAGE, "Replace each part in [brackets] from the outline with your own words before publishing. You can save it as a draft now.");

part("Offered on an empty post only");
const render = (body: string, id: string | null = null) =>
  renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(BlogEditor, { post: { id, title: "", body, product: null, draft: true, href: null }, products: [], back: "/studio/blog", look: {} as never })),
  );
const empty = render("");
is("on an empty post: its label, help, the three outlines and the button", [/<label for="post-outline" class="field-label">Outline<\/label>/.test(empty), empty.includes('aria-describedby="post-outline-hint"'), BLOG_OUTLINES.every((o) => new RegExp(`<option value="${o.id}"( selected="")?>${o.name}</option>`).test(empty)), empty.includes(">Use this outline</button>")], [true, true, true, true]);
is("a post with words, or one already saved, is not offered one", [render("My own post.").includes("data-blog-outline"), render("", "abc123").includes("data-blog-outline")], [false, false]);
is("the help says to replace the brackets too", empty.includes("Replace each part in [brackets], brackets and all, with your own words."), true);
const source = readFileSync("components/blog-editor.tsx", "utf8");
is("decided when the post opens, never while typing; used only on an empty post; the focus moves to the words with the first part selected", [source.includes("useState(() => !post.id && !post.body.trim())"), source.includes("if (body.trim()) return;"), source.includes("field.setSelectionRange(start, chosen.indexOf(\"]\", start) + 1);")], [true, true, true]);
is("each refusal is announced again, the same words or not", [source.includes("<p key={tries} className=\"notice notice-error\" role=\"alert\">"), (source.match(/setTries\(\(n\) => n \+ 1\)/g) ?? []).length], [true, 2]);

done();
