/**
 * Every table of the studio's memberships page (app/studio/memberships) that
 * scrolls sideways on a phone can be reached and scrolled by keyboard
 * (WCAG 2.1.1), and each scrolling region has a name of its own, never the
 * same one as the section it is in (two identical landmarks, WCAG 1.3.1).
 *
 * Found walking the studio on main (Claude 1, 14/11/2026), axe at 320 px:
 * scrollable-region-focusable on "By membership", landmark-unique on
 * "Who stays". The table of why members cancel had the same gap; it shows
 * only once someone has answered, so the synthetic store did not draw it.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

function main(): void {
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  const scrolling = [...page.matchAll(/<div className="[^"]*\boverflow-x-auto\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  const sections = new Set([...page.matchAll(/<section aria-labelledby="([^"]+)"/g)].map((m) => m[1]));

  part("Each table that scrolls sideways");
  is("there are tables that scroll", scrolling.length >= 6, true);
  is("each takes keyboard focus", scrolling.filter((tag) => !tag.includes("tabIndex={0}")), []);
  is("each is a named region", scrolling.filter((tag) => !tag.includes('role="region"') || !/aria-label(ledby)?=/.test(tag)), []);
  is(
    "none is named by its section's own heading",
    scrolling.filter((tag) => sections.has(/aria-labelledby="([^"]+)"/.exec(tag)?.[1] ?? "")),
    [],
  );
  done();
}

main();
