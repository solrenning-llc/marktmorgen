/**
 * 766 [STN13], unit 1: one search box for the whole studio (products, the
 * store's own pages and the studio's tools; a buyer by their full address).
 * The rules, the typing scheduler, the box's markup and what one search may
 * cost. The route itself, with a store, a team and Redis, is in
 * tests/stn13-studio-search-route.test.ts.
 */
import { readFileSync } from "node:fs";
import {
  ANSWERS_KEPT,
  MAX_QUERY,
  MIN_QUERY,
  PER_GROUP,
  SEARCHES_PER_DAY,
  SEARCHES_PER_MINUTE,
  SEARCH_DELAY_MS,
  type SearchAnswer,
  answerSentence,
  cleanQuery,
  hasAt,
  isAddress,
  matchRank,
  pickMatches,
  searchScheduler,
} from "@/lib/studio-search-rules";
import { STUDIO_SEARCH_UNITS } from "@/lib/studio-allowance-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { LOCKED_UNTIL_STAR_COMMANDS, ORIGIN_PER_BYTE, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("What is searched for");
  is("fewer than two letters is no search", [cleanQuery(""), cleanQuery(" a "), cleanQuery(42)], [null, null, null]);
  is("spaces are tidied", cleanQuery("  notion   planner "), "notion planner");
  is(`more than ${MAX_QUERY} characters is no search`, cleanQuery("x".repeat(MAX_QUERY + 1)), null);
  is(`exactly ${MAX_QUERY} is one`, cleanQuery("x".repeat(MAX_QUERY))?.length, MAX_QUERY);
  is("the limits", [MIN_QUERY, MAX_QUERY, SEARCH_DELAY_MS >= 300, PER_GROUP, SEARCHES_PER_MINUTE, SEARCHES_PER_DAY], [2, 80, true, 8, 20, 200]);
  is("an address is told apart", [isAddress("ana@example.com"), isAddress("ana@"), isAddress("ana example"), hasAt("ana@"), hasAt("ana")], [true, false, false, true, false]);

  part("What matches, and in which order");
  is("exact first, then the start, then every word, then the sentence", [
    matchRank({ title: "Notion Planner" }, "notion planner"),
    matchRank({ title: "Notion Planner Pro" }, "notion planner"),
    matchRank({ title: "The Planner for Notion" }, "notion planner"),
    matchRank({ title: "Inbox", extra: "Answer the chat on your store" }, "chat"),
    matchRank({ title: "Inbox", extra: "Answer the chat" }, "zebra"),
  ], [0, 1, 2, 3, -1]);
  is("accents and case do not matter", [matchRank({ title: "Café Crème" }, "cafe creme"), matchRank({ title: "YOGA" }, "yo")], [0, 1]);
  const items = ["The Planner", "Planner", "Planner Pro", "Old planner", "Cooking"].map((title, i) => ({ id: String(i), title }));
  is("best first, the creator's order when equal", pickMatches(items, "planner", (it) => ({ title: it.title })).map((it) => it.title), ["Planner", "Planner Pro", "The Planner", "Old planner"]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: `Guide ${i}` }));
  is(`at most ${PER_GROUP} a group`, pickMatches(many, "guide", (it) => ({ title: it.title })).length, PER_GROUP);

  part("The sentence read out once per answer");
  const answer: SearchAnswer = {
    groups: [
      { id: "products", title: "Products", state: "ok", missing: 0, results: [{ id: "a", title: "A", detail: "", href: "/a" }, { id: "b", title: "B", detail: "", href: "/b" }] },
      { id: "pages", title: "Your pages", state: "ok", missing: 0, results: [] },
      { id: "tools", title: "Tools", state: "ok", missing: 0, results: [{ id: "t", title: "T", detail: "", href: "/t" }] },
    ],
  };
  is("counts in words", answerSentence(answer, "a"), "3 results: 2 products, 1 tool.");
  is("nothing found", answerSentence({ groups: [{ id: "tools", title: "Tools", state: "ok", missing: 0, results: [] }] }, "zebra"), "Nothing matches “zebra”.");
  const unread: SearchAnswer = { groups: [{ id: "products", title: "Products", state: "unknown", missing: 0, results: [] }, { id: "tools", title: "Tools", state: "ok", missing: 0, results: [] }] };
  is("an unread group is never 'nothing'", answerSentence(unread, "zebra"), "We could not search your products just now. Try again in a moment.");
  const partial: SearchAnswer = { groups: [{ id: "products", title: "Products", state: "partial", missing: 2, results: [{ id: "a", title: "A", detail: "", href: "/a" }] }] };
  is("a partial group says how many were left out", answerSentence(partial, "a"), "1 result: 1 product. 2 products could not be searched yet. Open Sales pages once and they can be.");

  part("Typing does not read per key");
  const timers = fakeTimers();
  const runs: string[] = [];
  const answers: string[] = [];
  const scheduler = searchScheduler<{ ok: boolean; q: string }>({
    run: async (q) => {
      runs.push(q);
      return { ok: true, q };
    },
    answer: (q) => answers.push(q),
    failed: () => {},
    ok: (value) => value.ok,
    timers,
  });
  for (const prefix of ["no", "not", "noti", "notio", "notion"]) {
    scheduler.type(prefix);
    await timers.advance(SEARCH_DELAY_MS - 50);
  }
  await timers.advance(SEARCH_DELAY_MS);
  is("six letters typed quickly: one search", runs, ["notion"]);
  scheduler.type("notion");
  await timers.advance(SEARCH_DELAY_MS * 2);
  is("the same words again: answered from memory, no search", [runs.length, answers.at(-1)], [1, "notion"]);
  scheduler.type(null);
  await timers.advance(SEARCH_DELAY_MS * 2);
  is("cleared: no search", runs.length, 1);
  for (let i = 0; i < ANSWERS_KEPT + 5; i += 1) {
    scheduler.type(`word ${i}`);
    await timers.advance(SEARCH_DELAY_MS);
  }
  scheduler.type("word 0");
  await timers.advance(SEARCH_DELAY_MS);
  is(`only ${ANSWERS_KEPT} answers are kept`, runs.filter((q) => q === "word 0").length, 2);
  const aborted: boolean[] = [];
  const slow = searchScheduler<{ ok: boolean }>({
    run: (_q, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => aborted.push(true));
      timers.set(() => resolve({ ok: true }), 5_000);
    }),
    answer: () => answers.push("slow"),
    failed: () => {},
    ok: (value) => value.ok,
    timers,
  });
  slow.type("first");
  await timers.advance(SEARCH_DELAY_MS);
  slow.type("second");
  is("a new word stops the search still waiting", aborted, [true]);
  slow.stop();
  await timers.advance(10_000);
  is("an answer that came too late is not shown", answers.includes("slow"), false);

  part("The box");
  const box = readFileSync("components/studio-search.tsx", "utf8");
  for (const piece of ['"use client"', 'role="combobox"', 'aria-autocomplete="list"', "aria-activedescendant", "aria-expanded", "aria-controls", 'role="listbox"', 'role="group"', 'role="option"', "aria-selected", 'aria-live="polite"', "min-h-[44px]", "motion-reduce", "useSyncExternalStore", '"ArrowDown"', '"ArrowUp"', '"Home"', '"End"', '"Enter"', '"Escape"', "searchScheduler", "/api/store/studio-search", "/api/store/person", "x-nimbus-store", "Search the studio"])
    is(`the box has ${piece}`, box.includes(piece), true);
  for (const piece of ["autoPlay", "<video", "<iframe", "fixed ", "absolute", '"Tab"', "setInterval", "console."])
    is(`the box has no ${piece}`, box.includes(piece), false);
  const header = readFileSync("components/studio-header.tsx", "utf8");
  is("the studio's top bar draws it, below the bar, with the role's buyers right", header.includes("<StudioSearch") && header.includes('buyers={can(role, "orders")}') && header.indexOf("</header>") < header.indexOf("<StudioSearch"), true);
  is("no video in the top bar", ["autoPlay", "<video", "<iframe"].some((piece) => header.includes(piece)), false);
  const terms = readFileSync("app/terms/page.tsx", "utf8");
  is("the Terms say what a search counts as", terms.includes("STUDIO_SEARCH_UNITS") && terms.includes("a search in the studio counts as"), true);

  part("What one search may cost");
  // The search's own work at its worst: the studio request's commands, one HMGET of every card (a card is at most
  // 600 bytes with its id and framing, the ids sent are 42 bytes each) and the two counters (two commands each), the
  // answer sent on, under the heavy shape.
  const base = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  const worst = request("heavy", base + 1 + 4, 50_000 + MAX_PRODUCTS * 600 + MAX_PRODUCTS * 42) + 20_000 * ORIGIN_PER_BYTE;
  is(`${STUDIO_SEARCH_UNITS} studio requests pay for the dearest search`, STUDIO_SEARCH_UNITS * UNIT_COST.studio >= worst, true);
  is("a search is two of them", STUDIO_SEARCH_UNITS, 2);
  done();
}

/** Timers moved by hand: set, clear and advance, with promises let run between. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const waiting = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      const id = next++;
      waiting.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id: unknown) => {
      waiting.delete(id as number);
    },
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        const due = [...waiting.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        waiting.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
