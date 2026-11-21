/**
 * 766 [STN13], unit 3: help for the screen the creator is on, in the same
 * place on every studio screen (WCAG 3.2.6), with no video that opens by
 * itself. The rules (lib/screen-help.ts), the panel
 * (components/screen-help.tsx) and its place under the studio's top bar
 * (components/studio-header.tsx).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { HELP_CENTER_SEARCH, MOST_SCREEN_ANSWERS, SCREEN_HELP, helpAnchor, screenAnswers, screenOf } from "@/lib/screen-help";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { ScreenHelpPanel } from "@/components/screen-help";
import { StudioHeader } from "@/components/studio-header";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

const studioPages = walk("app/studio", (path) => path.endsWith("/page.tsx"));
/** Every studio screen, by the first folder under app/studio ("" is the studio home). */
const screenFolder = (path: string) => path.slice("app/studio/".length).split("/").slice(0, -1)[0] ?? "";
const screens = [...new Set(studioPages.map(screenFolder))].sort();
/** The pages that do not draw the studio's top bar, so never the panel under it (held to exactly two below). */
const headerless = studioPages.filter((path) => !read(path).includes("<StudioHeader")).sort();
/** The screens the panel is drawn on: every one with a page that draws the top bar. */
const drawn = [...new Set(studioPages.filter((path) => !headerless.includes(path)).map(screenFolder))].sort();
const questions = HELP_SECTIONS.flatMap((section) => section.items.map((item) => item.q));
const panel = (pathname: string | null, checkup: string | null = null) => renderToStaticMarkup(createElement(ScreenHelpPanel, { pathname, checkup }));

part("Every studio screen has its own short list of answers");
is("the screens found under app/studio", screens.length > 40 && screens.includes("") && screens.includes("funnels") && screens.includes("course"), true);
is("each screen with the top bar has an entry, and no entry names a screen that is not there or never draws it", Object.keys(SCREEN_HELP).sort(), drawn);
is("only the screens without the top bar have no entry", screens.filter((screen) => !drawn.includes(screen)), ["new", "paused"]);
is(`at most ${MOST_SCREEN_ANSWERS} answers a screen, never one twice`, Object.entries(SCREEN_HELP).filter(([, list]) => list.length > MOST_SCREEN_ANSWERS || new Set(list).size !== list.length).map(([screen]) => screen), []);
is("the most is three", MOST_SCREEN_ANSWERS, 3);
is("every answer named is a question of the help center today", Object.values(SCREEN_HELP).flat().filter((q) => !questions.includes(q)), []);
is("most screens have at least one answer", Object.values(SCREEN_HELP).filter((list) => list.length > 0).length >= drawn.length - 2, true);
is("the anchor of every help question is the one the help center draws", questions.filter((q) => helpAnchor(q) !== answerId(q)), []);

part("Which screen a path is");
is(
  "the home, a screen, a screen's own page, a screen's sub-page, a path outside the studio",
  [screenOf("/studio"), screenOf("/studio/"), screenOf("/studio/funnels"), screenOf("/studio/course/abc"), screenOf("/studio/path/privacy"), screenOf("/help"), screenOf(null), screenOf("/studio/nothing-here")],
  ["", "", "funnels", "course", "path", null, null, null],
);
is("the answers of a screen, with their anchors", screenAnswers("/studio/bundles"), [{ q: "Can I sell a bundle of products?", id: "can-i-sell-a-bundle-of-products" }]);
is("no answers outside the screens", [screenAnswers("/studio/nothing-here"), screenAnswers(null)], [[], []]);
is("a path that only starts with the studio's letters is not the studio", [screenOf("/studiox"), screenOf("/studio-tools/funnels"), screenAnswers("/studiox"), screenOf("/studio?store=s1"), screenOf("/studio/funnels#top")], [null, null, [], "", "funnels"]);

part("The panel");
const html = panel("/studio/funnels", "/studio/checkup?store=s1");
is("a native disclosure, closed until it is asked for", [/^<details[ >]/.test(html), /<details\b[^>]*?\sopen(=""|\s|>)/.test(html)], [true, false]);
is("its button says what it is", /<summary[^>]*>.*Help for this screen.*<\/summary>/.test(html), true);
is(
  "each answer of the screen is a link that says its question, to its place in the help center, in a new tab that is said",
  (SCREEN_HELP.funnels ?? []).length > 0 && (SCREEN_HELP.funnels ?? []).every((q) => html.includes(`href="/help#${answerId(q)}"`) && html.includes(`${q.replace(/'/g, "&#x27;")}<span class="new-tab-note sr-only"> (opens in a new tab)</span>`)),
  true,
);
is("the help center's search, by its own field", [HELP_CENTER_SEARCH, html.includes(`href="${HELP_CENTER_SEARCH}"`), read("components/help-search.tsx").includes('id="help-search"')], ["/help#help-search", true, true]);
is("a person, by email, the address in the link's words", html.includes(`href="mailto:${SUPPORT_EMAIL}"`) && html.includes(`Email us at ${SUPPORT_EMAIL}`), true);
is("the store check, for whoever may open it", [html.includes('href="/studio/checkup?store=s1"'), panel("/studio/funnels").includes("checkup")], [true, false]);
const unknown = panel("/studio/nothing-here");
is("a screen with no answer of its own: said so, and the rest is still there", [unknown.includes("No answer here is just for this screen yet."), unknown.includes(HELP_CENTER_SEARCH), unknown.includes("mailto:")], [true, true, true]);
is("nothing on a page outside the studio", panel("/help"), "");

part("No video, no sound, nothing over the page");
is("the panel holds no player of any kind", /<(video|audio|iframe|object|embed)\b/i.test(html), false);
const autoplaying = walk("app", (path) => path.endsWith(".tsx")).concat(walk("components", (path) => path.endsWith(".tsx"))).filter((path) => /\bautoPlay\b|<(video|audio)\b[^>]*\bautoplay\b/.test(read(path)));
is("no page or component starts a video or a sound by itself", autoplaying, []);
const source = read("components/screen-help.tsx") + read("lib/screen-help.ts");
is("the panel opens in the page, never over the menu", /\b(absolute|fixed|sticky)\b/.test(read("components/screen-help.tsx")), false);
is("it reads and sends nothing: no database, no provider, no request", /lib\/redis|lib\/stripe|\bfetch\(/.test(source), false);

part("Easy to press and to read");
const controls = html.match(/<(summary|a)\b[^>]*>/g) ?? [];
is("every control is at least 44 px tall with its words centered in it", controls.length >= 5 && controls.every((tag) => /\bmin-h-11\b/.test(tag) && /\bitems-center\b/.test(tag)), true);
is("the panel's text stays within 80 characters a line", /max-w-\[80ch\]/.test(html), true);

part("In the same place on every studio screen (3.2.6)");
const header = renderToStaticMarkup(
  createElement(
    AppRouterContext.Provider,
    { value: {} as never },
    createElement(
      PathnameContext.Provider,
      { value: "/studio/bundles" },
      createElement(StudioHeader, { current: { sid: "s1", name: "Harbor", handle: "harbor" }, role: "owner", stores: [], owned: 1, action: { href: "/studio?store=s1", label: "Back to the studio", short: "Studio" } }),
    ),
  ),
);
is("the studio's top bar carries it, with the answers of the screen it is on", [header.includes("Help for this screen"), header.includes('href="/help#can-i-sell-a-bundle-of-products"')], [true, true]);
is("the store check for the owner, by the store's own address", header.includes('href="/studio/checkup?store=s1"'), true);
const helper = renderToStaticMarkup(
  createElement(AppRouterContext.Provider, { value: {} as never }, createElement(PathnameContext.Provider, { value: "/studio/bundles" }, createElement(StudioHeader, { current: { sid: "s1", name: "Harbor", handle: "harbor" }, role: "editor", stores: [], owned: 0, action: { href: "/studio?store=s1", label: "Back to the studio", short: "Studio" } }))),
);
is("no store check for a role that cannot open it", [helper.includes("Help for this screen"), helper.includes("checkup")], [true, false]);
is(
  "every studio screen draws that top bar, but the two that come before a store is open or after its requests are used",
  headerless,
  ["app/studio/new/page.tsx", "app/studio/paused/page.tsx"],
);

part("What it adds to a page");
const largest = Math.max(...Object.keys(SCREEN_HELP).map((screen) => Buffer.byteLength(panel(`/studio/${screen}`, "/studio/checkup?store=s1aaaaaaaaaaaaaaaaaaaa"))));
is("at most 3,600 bytes of HTML, on the screen with the longest answers", largest > 0 && largest <= 3_600, true);

done();
