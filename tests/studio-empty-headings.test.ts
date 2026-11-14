/**
 * AX274, WCAG 1.3.1 and 2.4.10 Section Headings (AAA): the title of an empty or
 * stopped state is a heading at its place in the page's outline. Chromium on
 * 13 November 2026: /studio/pages, /studio/bundles, /studio/email, /studio/blog
 * and /studio/funnels drew the title of their empty, refused or stopped card
 * ("Nothing to build a page for yet", "Write a post"...) as a large <p>, so a
 * screen reader moving by heading went from the page's h1 straight past it.
 *
 * Levels follow each page's outline: under the h1, beside other h2, an h2; the
 * funnels' empty card sits inside "Offers after they pay" (h2), so an h3. The
 * classes are kept, so each looks exactly as before.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const TITLE = 'className="text-lg font-semibold tracking-[-0.02em] text-ink"';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

part("Each empty or stopped state's title is a heading");
for (const [file, level, start] of [
  ["app/studio/pages/page.tsx", "h2", "Nothing to build a page for yet"],
  ["app/studio/bundles/page.tsx", "h2", "{`${target?.title} cannot be a bundle as it is`}"],
  ["app/studio/email/page.tsx", "h2", "{(store.renewalUnpaidSince ?? 0) > 0"],
  ["app/studio/funnels/page.tsx", "h3", "Nothing to follow yet"],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: "${start.slice(0, 40)}" is an ${level} that looks as before`, [new RegExp(`<${level} ${escape(TITLE)}>\\s*${escape(start)}`).test(text), new RegExp(`<p ${escape(TITLE)}>\\s*${escape(start)}`).test(text)], [true, false]);
}
const blog = readFileSync("app/studio/blog/page.tsx", "utf8");
is("app/studio/blog/page.tsx: Write a post is an h2 that looks as before", [blog.includes('<h2 className="text-lg font-semibold text-ink">Write a post</h2>'), blog.includes('<p className="text-lg font-semibold text-ink">Write a post</p>')], [true, false]);

done();
