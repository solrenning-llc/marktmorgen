/**
 * 766 [STN13], unit 2: a trail at the top of the studio's pages, so a
 * creator always sees where they are and can go one level up (AX274, WCAG
 * 2.4.8 Location). One component draws it (components/breadcrumb.tsx); it
 * reads nothing, and its links never load a page ahead of the click, because
 * each studio page drawn is counted against the store's window
 * (lib/studio-allowance-rules.ts, STUDIO_PAGE_UNITS).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumb, StudioTrail } from "@/components/breadcrumb";
import { done, is, part } from "./check";

const store = { sid: "s1" };

part("What it draws");
const html = renderToStaticMarkup(createElement(StudioTrail, { store, here: "Funnels" }));
is("a navigation landmark named Breadcrumb, with an ordered list", [html.startsWith('<nav aria-label="Breadcrumb"'), html.includes("<ol")], [true, true]);
is("the first step is the studio of this store, as a link", /<a [^>]*href="\/studio\?store=s1"[^>]*>Studio<\/a>/.test(html), true);
is("the page itself is the last item, marked as the current page", /<li [^>]*aria-current="page"[^>]*>Funnels<\/li><\/ol>/.test(html), true);
is("the current page is not a link", /aria-current="page"[^>]*><a/.test(html), false);
is("two items in all", (html.match(/<li/g) ?? []).length, 2);
is("the slash between them is hidden from screen readers", /<span aria-hidden="true"[^>]*>\/<\/span>/.test(html), true);

const deep = renderToStaticMarkup(createElement(StudioTrail, { store, path: [{ label: "Products", href: "/studio?store=s1#products" }], here: "My podcast" }));
is("a level in between is a link, in order", [...deep.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]), ["Studio", "Products"]);
is("and its address is the one given", deep.includes('href="/studio?store=s1#products"'), true);
is("three items", (deep.match(/<li/g) ?? []).length, 3);

const links = [...deep.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1]);
is("every link is a 44px target with its words centered in it (AX274 2.5.5)", links.every((c) => /\binline-flex\b/.test(c) && /\bmin-h-11\b/.test(c) && /\bitems-center\b/.test(c)), true);
is("every link is underlined, so it is never told by color alone", links.length === 2 && links.every((c) => /\bunderline\b/.test(c)), true);
is("a long name wraps instead of running off a phone screen", /<li [^>]*class="[^"]*\[overflow-wrap:anywhere\][^"]*"[^>]*aria-current="page"/.test(deep) || /aria-current="page"[^>]*class="[^"]*\[overflow-wrap:anywhere\]/.test(deep), true);
is("the first step can go back to a part of the studio instead of its top", /<a [^>]*href="\/studio\?store=s1#closing"[^>]*>Studio<\/a>/.test(renderToStaticMarkup(createElement(StudioTrail, { store, home: "/studio?store=s1#closing", here: "Refund unused time" }))), true);
is("a name is shown as text, never as markup", renderToStaticMarkup(createElement(StudioTrail, { store, here: "<b>Mine</b> & co" })).includes("&lt;b&gt;Mine&lt;/b&gt; &amp; co"), true);
is("a blank name draws nothing rather than an empty item", renderToStaticMarkup(createElement(StudioTrail, { store, here: "  " })), "");
is("the generic trail draws the same way from its own first step", /<a [^>]*href="\/help"[^>]*>Help<\/a>/.test(renderToStaticMarkup(createElement(Breadcrumb, { path: [{ label: "Help", href: "/help" }], here: "Buyers" }))), true);
is("the generic trail with no link above it draws nothing", renderToStaticMarkup(createElement(Breadcrumb, { path: [], here: "Buyers" })), "");

part("It costs nothing");
const source = readFileSync("components/breadcrumb.tsx", "utf8");
const linkTags = source.match(/<Link\b[^>]*>/g) ?? [];
is("every link in it is drawn with prefetching off", linkTags.length > 0 && linkTags.every((tag) => tag.includes("prefetch={false}")), true);
is("it runs on the server and reads nothing", [source.includes('"use client"'), /\bawait\b|@\/lib\/redis|fetch\(/.test(source)], [false, false]);

part("On every page of the studio");
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(path).isDirectory() ? pages(path) : entry === "page.tsx" ? [path] : [];
  });
}
// The studio's first page is where every trail starts: its heading says
// "Studio" above the store's name, so it needs no trail of one item.
const EXEMPT = ["app/studio/page.tsx"];
// Pages that still wait for the trail. This list may only get shorter: a page
// given the trail leaves it, and a new page of the studio is made with one.
const PENDING = [
  "app/studio/add/page.tsx", "app/studio/affiliates/page.tsx", "app/studio/agent/page.tsx", "app/studio/agreements/page.tsx",
  "app/studio/calendar/page.tsx", "app/studio/card/page.tsx", "app/studio/community/page.tsx", "app/studio/copy/page.tsx",
  "app/studio/course/[product]/page.tsx", "app/studio/deals/page.tsx", "app/studio/discord/page.tsx", "app/studio/disputes/page.tsx",
  "app/studio/email/page.tsx", "app/studio/forms/page.tsx", "app/studio/growth/page.tsx", "app/studio/import/page.tsx",
  "app/studio/inbox/page.tsx", "app/studio/integrations/page.tsx", "app/studio/invite/page.tsx", "app/studio/labels/page.tsx",
  "app/studio/meetings/page.tsx", "app/studio/memberships/page.tsx", "app/studio/new/page.tsx", "app/studio/outreach/page.tsx",
  "app/studio/pages/page.tsx", "app/studio/path/page.tsx", "app/studio/path/privacy/page.tsx", "app/studio/paused/page.tsx",
  "app/studio/people/page.tsx", "app/studio/phone/page.tsx", "app/studio/refund/page.tsx", "app/studio/requests/page.tsx",
  "app/studio/reviews/page.tsx", "app/studio/tax/page.tsx", "app/studio/team/page.tsx", "app/studio/totals/page.tsx",
];
const all = pages("app/studio").sort();
const read = (path: string) => readFileSync(path, "utf8");
is("every page of the studio draws the trail (a new page is made with one)", all.filter((p) => !EXEMPT.includes(p) && !PENDING.includes(p) && !read(p).includes("<StudioTrail")), []);
is("no page still waiting has it already: take it off the list", PENDING.filter((p) => all.includes(p) && read(p).includes("<StudioTrail")), []);
is("every page on the list still exists", PENDING.filter((p) => !all.includes(p)), []);
is("a page with the trail has it in each of its screens", all.filter((p) => read(p).includes("<StudioTrail") && (read(p).match(/<StudioTrail\b/g) ?? []).length < (read(p).match(/<main\b/g) ?? []).length), []);
is("no trail is made by hand outside the list", all.filter((p) => !PENDING.includes(p) && read(p).includes('aria-label="Breadcrumb"')), []);
const moved = ["funnels", "bundles", "blog", "site", "podcast/[product]"].map((p) => `app/studio/${p}/page.tsx`);
is("on these pages the trail takes the place of the small heading above the title", moved.filter((p) => read(p).includes('className="eyebrow"')), []);
is("and says what that heading said", moved.map((p) => /<StudioTrail [^>]*here="([^"]+)"/.exec(read(p))?.[1] ?? null), ["Funnels", "Bundles", "Blog", "Your pages", "Private podcast"]);
is("the closing refunds page keeps its way back to the closing part of the studio", /<StudioTrail [^>]*home=\{back\}/.test(read("app/studio/closing-refunds/page.tsx")), true);

done();
