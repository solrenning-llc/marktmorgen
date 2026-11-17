/**
 * The "someone bought" card never disappears from under the visitor reading
 * or using it (WCAG 2.2.1, and 2.2.3 at AAA: no time limit on what a person
 * is reading or operating; AGENTS.md AX274 Part A item 4).
 *
 * components/recent-sales.tsx shows a store's latest real purchases, one card
 * at a time, each for seven seconds. Before this change the card was taken
 * away at the seventh second whatever the visitor was doing: a person with
 * the pointer on it, reading slowly, or with the keyboard focus on its link
 * or its close button lost the card, and the focus with it.
 *
 * Now a card stays while the pointer is over it or the focus is inside it,
 * and is taken away a full seven seconds after the person leaves it; the
 * cards after it follow from then, each still once a visit. Closing it still
 * ends them for the visit.
 *
 * The real component runs through tests/client-hooks.ts with a synthetic
 * clock in place of window.setTimeout, so its own timers decide what is
 * shown. Not checked here: a real browser's pointer and focus events, and a
 * keyboard user who has not reached the card before its seven seconds end
 * (the card is extra; every product it names is on the page it sits on).
 */
import { RecentSales } from "@/components/recent-sales";
import type { RecentSale } from "@/lib/recent-sales-rules";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Timer = { id: number; at: number; run: () => void };
let now = 0;
let next = 1;
let timers: Timer[] = [];
const kept = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (run: () => void, ms: number) => {
    const id = next++;
    timers.push({ id, at: now + ms, run });
    return id;
  },
  clearTimeout: (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  },
  sessionStorage: {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  },
};

const SALES: RecentSale[] = [
  { product: "first-guide", title: "The first guide", at: 1_800_000_000, country: "US" },
  { product: "second-guide", title: "The second guide", at: 1_800_000_000, country: "CA" },
];

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

async function main() {
  const start = async () => {
    now = 0;
    timers = [];
    kept.clear();
    const view = await mount(RecentSales as (p: Parameters<typeof RecentSales>[0]) => unknown, {
      sales: SALES, handle: "maple", language: "en", locale: "en-US",
    });
    const card = () => find(view.tree(), (n) => n.type === "aside")[0] as Node | undefined;
    const title = () => {
      const link = find(card(), (n) => n.type === "a")[0];
      return link ? String((find(link, (n) => n.type === "span")[0]?.props?.children) ?? "") : null;
    };
    const at = async (ms: number) => {
      for (;;) {
        const due = timers.filter((t) => t.at <= ms).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.run();
        await view.settle();
      }
      now = ms;
    };
    const fire = async (name: string, event: unknown = {}) => {
      const handler = card()?.props?.[name] as ((e: unknown) => void) | undefined;
      if (!handler) throw new Error(`the card has no ${name}`);
      handler(event);
      await view.settle();
    };
    return { view, card, title, at, fire };
  };

  part("Nobody touches it: unchanged");
  {
    const c = await start();
    await c.at(4_999);
    is("nothing before the fifth second", c.card(), undefined);
    await c.at(5_000);
    is("the first card at the fifth second", c.title(), "The first guide");
    await c.at(12_000);
    is("gone seven seconds later", c.card(), undefined);
    await c.at(21_000);
    is("the second card after the pause", c.title(), "The second guide");
    await c.at(28_000);
    is("gone in its turn", c.card(), undefined);
    await c.at(120_000);
    is("never again: once a visit, no loop", [c.card(), timers.length], [undefined, 0]);
  }

  part("The pointer is on it");
  {
    const c = await start();
    await c.at(6_000);
    await c.fire("onPointerEnter");
    await c.at(60_000);
    is("it stays while the pointer is over it, well past seven seconds", c.title(), "The first guide");
    await c.fire("onPointerLeave");
    await c.at(66_999);
    is("still there just under seven seconds after the pointer left", c.title(), "The first guide");
    await c.at(67_000);
    is("taken away a full seven seconds after", c.card(), undefined);
    await c.at(76_000);
    is("the next card follows after the usual pause", c.title(), "The second guide");
  }

  part("The keyboard focus is inside it");
  {
    const c = await start();
    await c.at(6_000);
    await c.fire("onFocus");
    await c.at(40_000);
    is("it stays while the focus is on its link or close button", c.title(), "The first guide");
    const inside = {};
    await c.fire("onBlur", { currentTarget: { contains: (n: unknown) => n === inside }, relatedTarget: inside });
    await c.at(80_000);
    is("moving from its link to its close button keeps it", c.title(), "The first guide");
    await c.fire("onPointerEnter");
    await c.fire("onBlur", { currentTarget: { contains: () => false }, relatedTarget: null });
    await c.at(120_000);
    is("focus gone but the pointer still on it: it stays", c.title(), "The first guide");
    await c.fire("onPointerLeave");
    await c.at(127_000);
    is("both gone: taken away seven seconds later", c.card(), undefined);
  }

  part("Closing still ends it for the visit");
  {
    const c = await start();
    await c.at(5_000);
    await c.fire("onFocus");
    const close = find(c.card(), (n) => n.type === "button")[0];
    (close?.props?.onClick as () => void)();
    await c.view.settle();
    is("closed at once", c.card(), undefined);
    await c.at(200_000);
    is("no other card that visit", c.card(), undefined);
    is("remembered for the visit", kept.get("nl:recent-closed:maple"), "1");
  }

  done();
}

void main();
