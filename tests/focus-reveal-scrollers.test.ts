/**
 * AX274 Part A / 310 [AX2] (WCAG 2.4.12 Focus Not Obscured (Enhanced), 2.4.11), found in the measured browser sweep
 * outside the studio (Claude 4 cloud AA, 15 November 2026): at 320 px, the help center's "Sections" list scrolls
 * sideways, and Chromium scrolls a focused control into view only when it is wholly out of sight. Tabbing along it
 * left "The demo store" at 184-346 px and "Your store" at 282-407 px inside a list that ends at 304 px: most of the
 * focused link, and its focus ring, cut off.
 *
 * A list of links or buttons that scrolls sideways outside the studio now brings the focused one wholly into view
 * (`revealFocused`, components/reveal-focus.ts) with `scrollIntoView({ block: "nearest", inline: "nearest" })`: no
 * movement when it is already in view, and the page's own `scroll-behavior` decides whether it glides.
 *
 * Read from every .tsx under app/ and components/ outside the studio (app/studio/ and components/studio-*.tsx; the
 * studio's own section bar is in #3757): a <ul>, or an element with role="group", whose
 * classes scroll sideways (`overflow-x-auto`) is drawn by FocusRevealList or carries onFocus={revealFocused}.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";
import { revealFocused } from "@/components/reveal-focus";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join("app", "studio") ? [] : tsxFiles(path);
    return path.endsWith(".tsx") && !entry.name.startsWith("studio-") ? [path] : [];
  });
}

part("2.4.12: a sideways-scrolling list of controls outside the studio reveals the focused one");
const bare: string[] = [];
let lists = 0;
for (const file of [...tsxFiles("app"), ...tsxFiles("components")]) {
  const source = readFileSync(file, "utf8");
  for (const tag of source.matchAll(/<(ul|div|nav|ol)\b[^>]*?>/g)) {
    const text = tag[0];
    if (!/\boverflow-x-auto\b/.test(text)) continue;
    if (tag[1] !== "ul" && !/role="group"/.test(text)) continue;
    lists += 1;
    if (!/onFocus=\{revealFocused\}/.test(text)) bare.push(`${file}:${source.slice(0, tag.index).split("\n").length}`);
  }
}
is("sideways lists of controls outside the studio were found (the scan reads something)", lists >= 1, true);
is("each one reveals the focused control", bare, []);

part("the help center's Sections list is drawn by FocusRevealList");
const help = readFileSync("app/help/page.tsx", "utf8");
const nav = help.slice(help.indexOf('aria-label="Help sections"'), help.indexOf("</nav>", help.indexOf('aria-label="Help sections"')));
is("the Sections nav uses FocusRevealList", /<FocusRevealList\b[^>]*overflow-x-auto/.test(nav), true);
is("FocusRevealList passes revealFocused to its list", /onFocus=\{revealFocused\}/.test(readFileSync("components/focus-reveal-list.tsx", "utf8")), true);

part("revealFocused scrolls the focused control, nearest edge only, never the list itself");
const calls: unknown[] = [];
const fakeElement = (name: string) => ({ name, scrollIntoView: (options: unknown) => calls.push([name, options]) });
const list = fakeElement("list");
const link = fakeElement("link");
revealFocused({ target: link, currentTarget: list } as unknown as React.FocusEvent<HTMLElement>);
is("the focused link is scrolled to its nearest edge", calls, [["link", { block: "nearest", inline: "nearest" }]]);
calls.length = 0;
revealFocused({ target: list, currentTarget: list } as unknown as React.FocusEvent<HTMLElement>);
is("focus on the list itself moves nothing", calls, []);
calls.length = 0;
revealFocused({ target: { name: "text node" }, currentTarget: list } as unknown as React.FocusEvent<HTMLElement>);
is("a target without scrollIntoView is left alone", calls, []);

done();
