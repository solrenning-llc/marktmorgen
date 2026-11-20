/**
 * "See campaign results" in the studio's promotion planner
 * (components/promotion-planner.tsx) scrolls without a glide for a person
 * whose device asks for less motion (WCAG 2.3.3, AAA; AGENTS.md AX274 Part A
 * item 4). It passed behavior "smooth" to scrollIntoView, and an explicit
 * behavior in script is not overridden by the site's CSS rule for reduced
 * motion, so the page glided for everyone.
 *
 * The real component runs through tests/client-hooks.ts; the button's own
 * handler is pressed with the device setting on and off, and the scroll it
 * asks for is recorded. Not checked here: a real browser's scrolling.
 */
import { PromotionPlanner } from "@/components/promotion-planner";
import type { StatsData } from "@/lib/stats";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

const row = { views: 100, sales: 1, cents: 12345, checkouts: 2 };
const data = {
  sales: "ok", partial: false, currency: "usd", days: [{ date: "2026-10-16" }],
  products: [{ id: "a", title: "A", d7: row, d30: row, d90: row }],
  channels: { d7: [{ source: "x", visits: 100, cents: 12345, sales: 1 }], d30: [], d90: [] },
} as unknown as StatsData;

let reduce = false;
const asked: unknown[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = { matchMedia: (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" && reduce }) };
g.document = { getElementById: (id: string) => (id === "numbers-posts" ? { scrollIntoView: (options: unknown) => asked.push(options) } : null) };

async function main() {
  const view = await mount(PromotionPlanner as (p: Parameters<typeof PromotionPlanner>[0]) => unknown, {
    data, range: "d7", products: [{ id: "a", title: "Guide", url: "https://shop.example/p/guide" }],
  });
  const button = find(view.tree(), (n) => n.type === "button" && texts(n).join("") === "See campaign results")[0];
  const press = () => (button?.props?.onClick as () => void)();

  part("See campaign results");
  is("the button is found", Boolean(button), true);
  reduce = true;
  press();
  is("less motion asked for: the page jumps, with no glide", asked.at(-1), { behavior: "auto", block: "start" });
  reduce = false;
  press();
  is("no such setting: the page glides as before", asked.at(-1), { behavior: "smooth", block: "start" });
  done();
}

void main();
