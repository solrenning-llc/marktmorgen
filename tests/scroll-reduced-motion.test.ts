/**
 * WCAG 2.3.3 Animation from Interactions (AAA, AX274 item 4): a smooth scroll started by a press is motion, and a
 * person who asked their system for less motion must not get it. The stylesheet's `scroll-behavior: auto` under
 * prefers-reduced-motion does not reach a script that asks for `behavior: "smooth"`, so the numbers page (moving to a
 * section) and the page editor (moving to a block) still glided for them on 13 November 2026.
 *
 * scrollBehavior() (lib/scroll-motion.ts) says "auto" when less motion is asked for, "smooth" otherwise, and outside
 * a browser; every smooth scroll of those two files goes through it.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { scrollBehavior } from "@/lib/scroll-motion";

part("scrollBehavior follows the person's motion setting");
const set = (reduce: boolean) => {
  (globalThis as { window?: unknown }).window = { matchMedia: (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)" }) };
};
set(true);
is("less motion asked for: an instant scroll", scrollBehavior(), "auto");
set(false);
is("no preference: a smooth scroll", scrollBehavior(), "smooth");
delete (globalThis as { window?: unknown }).window;
is("outside a browser: smooth, as before (nothing scrolls there)", scrollBehavior(), "smooth");

part("No smooth scroll in the numbers page or the page editor ignores it");
for (const file of ["components/stats-panel.tsx", "components/page-editor.tsx"]) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no behavior: "smooth" written out`, /behavior:\s*"smooth"/.test(text), false);
  is(`${file}: scrolls with scrollBehavior()`, text.includes("behavior: scrollBehavior()"), true);
}
done();
