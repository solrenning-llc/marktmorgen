/**
 * 656 [WG16], unit 1: one pattern for an empty list (components/empty-state.tsx):
 * a heading, one sentence and, only where it works, one action. On the public
 * store it speaks to the buyer and draws no dead button: the store with nothing
 * on it and its blog with no posts each say what this is and what comes, in
 * every buyer language. A store with no posts has no blog at all (its page is
 * not found, and nothing links to it); the blog's empty state is a page past
 * the last post, with a link to all posts. The studio is unit 2 (app/studio/page.tsx is held by
 * other work); the buyer's orders and library wait on #1969, which rewrites
 * those parts.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "@/components/empty-state";
import { wordsIn } from "@/lib/buyer-words";
import { done, is, part } from "./check";

const render = (props: Parameters<typeof EmptyState>[0]) => renderToStaticMarkup(createElement(EmptyState, props));

part("The pattern: a heading, one sentence, and an action only where it works");
const plain = render({ title: "Nothing here yet", body: "When Harbor adds something, it shows up here." });
is("the title is a heading", /<h2[^>]*>Nothing here yet<\/h2>/.test(plain), true);
is("one sentence under it", plain.includes("<p") && plain.includes("When Harbor adds something, it shows up here."), true);
is("no action given: no button, no link", /<a |<button/.test(plain), false);
is("marked as an empty list", plain.includes('data-empty-state=""'), true);
const acting = render({ title: "No posts yet", body: "Write the first one.", action: { href: "/@harbor", label: "Back to Harbor" } });
is("an action on this site is a real link", /<a [^>]*href="\/@harbor"[^>]*>Back to Harbor<\/a>/.test(acting), true);
for (const href of ["", "https://elsewhere.example/x", "//elsewhere.example", "javascript:alert(1)", "#", "@harbor"]) {
  is(`an action that would not work here (${JSON.stringify(href)}) is not drawn`, /<a |<button/.test(render({ title: "T", body: "B", action: { href, label: "Go" } })), false);
}
is("an action with no words is not drawn", /<a /.test(render({ title: "T", body: "B", action: { href: "/@harbor", label: "  " } })), false);
is("a title or sentence left empty draws nothing at all, never a blank block", render({ title: "", body: "B" }) + render({ title: "T", body: " " }), "");

part("The words, in every buyer language");
for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
  const w = wordsIn(language);
  is(`${language}: the empty store has a heading and a sentence`, Boolean(w.nothingYet && w.nothingYetBody("Harbor").includes("Harbor")), true);
  is(`${language}: a blog page past the last post has a heading and a sentence`, Boolean(w.blogPastEnd && w.blogPastEndBody && w.blogAll), true);
}

part("The public pages use it, with no dead button");
const store = readFileSync("app/[handle]/page.tsx", "utf8");
is("the empty store: heading and sentence, no action", /<EmptyState title=\{w\.nothingYet\} body=\{w\.nothingYetBody\(store\.name\)\} \/>/.test(store), true);
const blog = readFileSync("app/[handle]/blog/page.tsx", "utf8");
is("a blog page past the last post: heading, sentence and the link to all posts", blog.includes('<EmptyState title={w.blogPastEnd} body={w.blogPastEndBody} action={{ href: base, label: w.blogAll }} className="mt-8" />'), true);
// The exact reader distinguishes an unavailable listing before destructuring it.
// Keep the confirmed-empty 404 contract, without requiring the old await spelling.
is("a store with no posts still has no blog page",
  /const listing = await publishedPosts\(store\.statsId, page\)\.catch\(\(\) => null\);\s*if \(listing === null\) return <BlogUnavailable[^;]+;\s*const \{ posts, total \} = listing;\s*if \(total === 0\) notFound\(\);/.test(blog), true);
is("no bare sentence left where the blog is empty", blog.includes("{w.blogEmpty}</p>"), false);

done();
