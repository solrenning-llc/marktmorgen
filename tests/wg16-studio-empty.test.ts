/**
 * 656 [WG16], unit 2: the studio's empty lists use the one empty-state
 * pattern (components/empty-state.tsx), in a studio variant drawn with the
 * studio's own colors: a heading at the level the page's outline needs, one
 * plain sentence that stays true, and at most one action that works and fills
 * the list. The blog's action starts a new post, and is not drawn while one is
 * already being written (it would lead nowhere new). The reviews' only action
 * is the existing jump to "Asking for reviews" on the same page, for a role
 * that can switch the email on, while the store has no review at all; it stays
 * a plain in-page link, so the browser moves the focus to that heading. The
 * store variant's output does not change.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as empty from "@/components/empty-state";
import { done, is, part } from "./check";

type StudioProps = { title: string; body: string; action?: { href: string; label: string }; level?: 2 | 3; className?: string };
const Studio = (empty as unknown as Record<string, unknown>).StudioEmptyState as ((props: StudioProps) => unknown) | undefined;
const render = (props: StudioProps) => (typeof Studio === "function" ? renderToStaticMarkup(createElement(Studio as never, props as never)) : "");

part("The studio variant: the studio's own colors, a heading at the right level, an action only where it works");
is("the component exports a studio variant", typeof Studio, "function");
const plain = render({ title: "No posts yet", body: "Your store page links to your blog once a post is published.", level: 3 });
is("the title is a heading at the level asked for", /<h3[^>]*>No posts yet<\/h3>/.test(plain), true);
is("level 2 when the page's outline needs it", /<h2[^>]*>No totals yet<\/h2>/.test(render({ title: "No totals yet", body: "B", level: 2 })), true);
is("one sentence under it", /<p[^>]*>Your store page links to your blog once a post is published\.<\/p>/.test(plain), true);
is("marked as an empty list", plain.includes('data-empty-state=""'), true);
is("drawn with the studio's text colors (16:1 and 10:1 on white), never the store theme's", plain.includes("text-ink") && plain.includes("text-ink-soft") && !/st-note|--st-text|st-btn/.test(plain), true);
is("no action given: no button, no link", /<a |<button/.test(plain), false);
const acting = render({ title: "No posts yet", body: "B", level: 3, action: { href: "/studio/blog?store=s1&edit=new", label: "Write your first post" } });
is("a path on this site is a real link, at least 44 by 44 px (.btn is 48 px tall)", /<a [^>]*href="\/studio\/blog\?store=s1&amp;edit=new"[^>]*class="btn [^"]*"[^>]*>Write your first post<\/a>|<a [^>]*class="btn [^"]*"[^>]*href="\/studio\/blog\?store=s1&amp;edit=new"[^>]*>Write your first post<\/a>/.test(acting), true);
const jump = render({ title: "No reviews yet", body: "B", level: 3, action: { href: "#asking-for-reviews", label: "Ask buyers for a review" } });
is("a jump to a named place on the same page is a plain link, so the browser moves the focus there", /<a [^>]*href="#asking-for-reviews"[^>]*>Ask buyers for a review<\/a>/.test(jump), true);
for (const href of ["", "#", "# x", "https://elsewhere.example/x", "//elsewhere.example", "/\\elsewhere.example", "javascript:alert(1)", "@harbor", "studio/blog"]) {
  is(`an action that would not work here (${JSON.stringify(href)}) is not drawn`, /<a |<button/.test(render({ title: "T", body: "B", action: { href, label: "Go" } })), false);
}
is("an action with no words is not drawn", /<a /.test(render({ title: "T", body: "B", action: { href: "/studio/blog", label: " " } })), false);
is("a title or sentence left empty draws nothing at all, never a blank block", typeof Studio === "function" ? render({ title: "", body: "B" }) + render({ title: "T", body: " " }) : "missing", "");

part("The store variant is unchanged");
const store = renderToStaticMarkup(createElement(empty.EmptyState, { title: "Nothing here yet", body: "When Harbor adds something, it shows up here.", action: { href: "/@harbor", label: "Back to Harbor" } }));
is("same markup as unit 1", store, '<div class="st-note text-center" data-empty-state=""><h2 class="text-base font-bold" style="color:var(--st-text)">Nothing here yet</h2><p class="mt-2 text-sm">When Harbor adds something, it shows up here.</p><a class="btn st-btn mt-4" href="/@harbor">Back to Harbor</a></div>');

part("The studio blog: no posts yet");
const blog = readFileSync("app/studio/blog/page.tsx", "utf8");
is("its empty list uses the studio variant, as an h3 under the list's h2", blog.includes('<StudioEmptyState\n                  level={3}\n                  title="No posts yet"\n                  body="Your store page links to your blog once a post is published."'), true);
is("its action starts a new post, only while none is being written", blog.includes('action={writing ? undefined : { href: `${back}${back.includes("?") ? "&" : "?"}edit=new`, label: "Write your first post" }}'), true);
is("the list's heading it sits under is an h2", blog.includes('<h2 id="posts-title"'), true);
is("no bare sentence left where the list is empty", blog.includes("No posts yet. Your store page links"), false);

part("The studio reviews: an empty list and no totals yet");
const reviews = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("the empty list uses the studio variant, as an h3 under the list's h2, inside its card", /<StudioEmptyState\s+level=\{3\}\s+className="card mt-5 p-6 sm:p-8"/.test(reviews), true);
is("its three cases keep their true words", ['"No reviews on this page"', '"Nothing new"', '"No reviews yet"', '"Choose an earlier page to see the reviews in this list."', '"Every review has been seen. New ones, and reviews their buyers change, come back here."', "\"When a buyer reviews something, it appears here and on the product's page at the same moment.\""].every((words) => reviews.includes(words)), true);
is("its one action is the jump to asking for reviews, for a role that can switch it on, while the store has no review at all", reviews.includes('action={current.total === 0 && numbers.size === 0 && can(view.role, "settings") ? { href: "#asking-for-reviews", label: "Ask buyers for a review" } : undefined}'), true);
is("the place it jumps to is still a heading that takes the focus", reviews.includes('<h2 id="asking-for-reviews" tabIndex={-1}'), true);
// Rule 23 (Codex Q on #2841, review 5806653591): the totals' reader cannot tell "none" from "not read", so the by-product
// box keeps main's sentence, which only says none can be shown here; the shared empty state would claim there are none.
is("no totals: main's sentence, which never claims there are none", reviews.includes("No product review totals are available in this view.") && !reviews.includes("No product totals yet"), true);
is("no bare sentence left where the list is empty", reviews.includes('<p className="text-lg font-semibold tracking-[-0.02em] text-ink">{current.total > 0'), false);

done();
