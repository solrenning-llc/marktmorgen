/**
 * Arrow keys in the site's menus (524 [NV1], unit 2, lib/menu-keys.ts and
 * components/site-nav.tsx; added 1 November 2026).
 *
 * Walked in Chromium against a production build at 1280 x 720 on
 * 1 November 2026, from the Product button: Down opened the menu at its
 * first link, Down moved on, End went to the last, Down from it came round
 * to the first, Up went back to the last, Home to the first; Escape closed
 * the menu and put the focus back on Product; Right and Left moved between
 * Product, Creators and Why Marktmorgen, End went to the last item of the
 * row and Home to the first; Up on Product opened it at its last link. Here,
 * the rule and the wiring.
 */
import { readFileSync } from "node:fs";
import { moveFocus } from "@/lib/menu-keys";
import { done, is, part } from "./check";

part("The rule");
is("down and up in a list, round at the ends", [moveFocus("ArrowDown", 0, 3, "list"), moveFocus("ArrowDown", 2, 3, "list"), moveFocus("ArrowUp", 0, 3, "list")], [1, 0, 2]);
is("right and left in the row", [moveFocus("ArrowRight", 1, 4, "row"), moveFocus("ArrowLeft", 0, 4, "row")], [2, 3]);
is("Home and End in both", [moveFocus("Home", 2, 5, "row"), moveFocus("End", 0, 5, "list")], [0, 4]);
is("the other axis's arrows, and any other key, move nothing", [moveFocus("ArrowDown", 0, 3, "row"), moveFocus("ArrowRight", 0, 3, "list"), moveFocus("Tab", 0, 3, "list"), moveFocus("a", 0, 3, "row")], [null, null, null, null]);
is("nothing to move among: nothing", [moveFocus("ArrowDown", 0, 0, "list"), moveFocus("End", 0, -1, "row")], [null, null]);

part("Wired in the header");
const nav = readFileSync("components/site-nav.tsx", "utf8");
is("the row of menus takes the row's keys", nav.includes('<nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex" onMouseEnter={keepOpen} onKeyDown={onRowKey}>'), true);
is("an open menu takes the list's keys", /id=\{`menu-\$\{menu\.id\}`\}\s*onMouseEnter=\{keepOpen\}\s*onKeyDown=\{onListKey\}/.test(nav), true);
is("Down or Up on a menu's button opens it at its first or last link", nav.includes('const end = event.key === "ArrowDown" ? "first" : "last";') && nav.includes("focusOnOpen.current = end;"), true);
is("a menu already open (by hover) takes the focus at once, with nothing left waiting", nav.includes("if (openMenu === id && links.length) {"), true);
is("Escape from inside a menu puts the focus back on its button", nav.includes("button[aria-controls=\"${panel.id}\"]`)?.focus();"), true);
is("Tab is left alone: no key handler takes it", /key === "Tab"/.test(nav), false);
is("with Alt, Ctrl, Cmd or Shift the keys stay the browser's, in both handlers", nav.includes("const modified = (event: React.KeyboardEvent<HTMLElement>) => event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;") && (nav.match(/if \(modified\(event\)\) return;/g) ?? []).length === 2, true);
is("opened from the keyboard: no hover timer closes it, and Enter on the button closes it at once", /keepOpen\(\);\s*openedByClick\.current = true;\s*setOpenMenu\(id\);/.test(nav), true);
done();
