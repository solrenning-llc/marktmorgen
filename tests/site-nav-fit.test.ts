/**
 * The "Product" menu, whole on one screen (524 [NV1]; added 1 November 2026).
 *
 * Measured in Chromium against a production build on 1 November 2026: before,
 * the panel's links needed 769 px and showed 541 at 1536 × 639 (622 at
 * 1280 × 720), scrolling inside itself with seven links out of sight, and
 * its cap let it end 15 px below a 720 px window. After, 469 px, no scroll
 * and no link out of sight at 1280 × 720, 1366 × 720 and 1536 × 639. The
 * browser measurement is not repeated here; what holds it in place is:
 *
 *   - every item keeps its place: the same three groups, twenty pages, their
 *     icons, the panel on the left and its link to every feature;
 *   - each phrase is one short line: none longer than the longest measured
 *     on one line at 14 px (34 characters), and each name fits too;
 *   - the rows keep a 44 px target and the panel's cap is the window less
 *     the header, so it never ends below the window;
 *   - the menus still open with real buttons, aria-expanded and aria-controls.
 */
import { readFileSync } from "node:fs";
import { MENUS } from "@/components/site-nav";
import { done, is, part } from "./check";

const nav = readFileSync("components/site-nav.tsx", "utf8");
const product = MENUS.find((m) => m.id === "product")!;
const items = product.groups!.flatMap((g) => g.items);

part("Nothing lost");
is("the three groups, in order", product.groups!.map((g) => g.label), ["Sell", "Get paid", "Deliver and grow"]);
is("twenty feature pages, each once, each with an icon", [items.length, new Set(items.map((i) => i.href)).size, items.every((i) => i.icon)], [20, 20, true]);
is("the panel on the left and the link to every feature are there", nav.includes("{menu.feature.title}") && nav.includes('href="/platform" onClick={closeAll}') && nav.includes("Every feature on one page, with its plan"), true);

part("One short line each");
is("no phrase longer than the longest measured on one line (34 characters)", items.filter((i) => i.description.length > 34).map((i) => i.description), []);
is("no name longer than 27 characters", items.filter((i) => i.label.length > 27).map((i) => i.label), []);
is("the phrases the review checked against the feature pages", ["Daily, weekly, monthly or yearly.", "Your photo, links and products.", "Contact fields and deal stages.", "Modules that open over time."].every((d) => items.some((i) => i.description === d)), true);
is("the link to every feature sits in its own block, so the arrow link's negative margin cannot reach the demo card", nav.includes('<div className="mt-4">\n                        <Link href="/platform"'), true);
is("each phrase ends as a sentence", items.filter((i) => !/[.]$/.test(i.description)).map((i) => i.label), []);

part("Sizes and the window");
is("each row is at least 44 px tall", nav.includes('className="flex min-h-11 items-center gap-3 rounded-[var(--r-md)] px-3 py-1.5'), true);
is("the phrase stays at 14 px", nav.includes('<span className="block text-sm leading-[1.125rem] text-ink-mute">{entry.description}</span>'), true);
is("the cap is the window less the header and a margin", nav.includes("max-h-[calc(100dvh-8rem)]") && !nav.includes("max-h-[calc(100dvh-6rem)]"), true);

part("Still operable as before");
is("buttons with aria-expanded and aria-controls", /aria-expanded=\{openMenu === menu\.id\}/.test(nav) && nav.includes("aria-controls={`menu-${menu.id}`}"), true);
done();
