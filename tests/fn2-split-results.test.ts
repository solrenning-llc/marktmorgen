/**
 * 526 [FN2], unit 3: the numbers of a funnel's split test, per version, and
 * the verdict of the existing winner rule (lib/ab-decision.ts, 377 [TB3]).
 * Units 1 and 2 are tests/fn2-split-rules.test.ts and tests/fn2-split-funnel.test.ts.
 *
 * What fails here:
 *   - the versions of a split counted together, or a visit to version A
 *     counted for version B;
 *   - the step's own count of a split no longer the people who opened any of
 *     its versions (each once), or a funnel without a split counted any
 *     differently;
 *   - a count that could not be read shown as 0 instead of unavailable;
 *   - a verdict that does not come from abDecision with the real figures, a
 *     winner named with too little data, or money made up where none is
 *     counted;
 *   - the studio's split row without the side-by-side figures, their labels,
 *     or the verdict;
 *   - the reads per version taken without the studio requests that pay for them.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { readFunnelInput, type PageFunnel, type SplitStep } from "@/lib/page-funnel";
import {
  FUNNEL_COUNT_BYTES_PER_STEP,
  countFunnelDone,
  countFunnelStep,
  funnelCountsBytes,
  funnelHere,
  readFunnelCounts,
  readFunnelCountsStrict,
  readSplitCountsStrict,
  splitCountUnits,
  writePageFunnel,
} from "@/lib/page-funnel-store";
import { abDecision, type AbVersion } from "@/lib/ab-decision";
import { SPLIT_MONEY_NOTE, splitView } from "@/lib/funnel-split-results";
import { SplitResults } from "@/components/funnel-split-results";
import { POST as hitRoute } from "@/app/api/store/hit/route";
import { addProduct, claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const NOW = 1_760_000_000;
const OWNER = "splitresults@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

const page = (id: string) => ({ kind: "page" as const, id });
const product = (id: string) => ({ kind: "product" as const, id });
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

async function main(): Promise<void> {
  redis.clear();

  part("Counting each version apart");
  const steps = [page("landing001"), { kind: "split" as const, id: "splitaaaaa", options: [{ ...page("versiona01"), share: 50 }, { ...page("versionb01"), share: 50 }] }, product("course0001")];
  const funnel: PageFunnel = { id: "abcdefghij", name: "Launch", slug: "launch", on: true, since: NOW, steps };
  const plain: PageFunnel = { ...funnel, id: "plainplain", steps: [page("landing001"), product("course0001")] };
  const sid = "split-results";
  await countFunnelStep(sid, funnel, 1, "visitor-1", page("versiona01"));
  await countFunnelStep(sid, funnel, 1, "visitor-1", page("versiona01"));
  await countFunnelStep(sid, funnel, 1, "visitor-2", page("versiona01"));
  await countFunnelStep(sid, funnel, 1, "visitor-3", page("versionb01"));
  // The same person drawn version B on a later visit.
  await countFunnelStep(sid, funnel, 1, "visitor-1", page("versionb01"));
  await countFunnelDone(sid, funnel, 1, "visitor-3", page("versionb01"));
  is("each version's people and sign-ups, kept apart", await readSplitCountsStrict(sid, funnel), [null, [{ version: "a", seen: 2, done: 0 }, { version: "b", seen: 2, done: 1 }], null]);
  is("the split's own step: everyone who opened any version, each once", (await readFunnelCountsStrict(sid, funnel))[1], { seen: 3, done: 1 });
  is("the lenient read agrees", await readFunnelCounts(sid, funnel), await readFunnelCountsStrict(sid, funnel));

  part("Nothing counted where the version is not known");
  await countFunnelStep(sid, funnel, 1, "visitor-9");
  await countFunnelStep(sid, funnel, 1, "visitor-9", page("landing001"));
  await countFunnelDone(sid, funnel, 1, "visitor-9", product("course0001"));
  is("a split counted without one of its pages counts nothing", [(await readSplitCountsStrict(sid, funnel))[1], (await readFunnelCountsStrict(sid, funnel))[1]], [[{ version: "a", seen: 2, done: 0 }, { version: "b", seen: 2, done: 1 }], { seen: 3, done: 1 }]);

  part("A funnel without a split counts as before");
  const before = redis.pipeline;
  const sent: (string | number)[][][] = [];
  redis.pipeline = async (commands) => {
    sent.push(commands as (string | number)[][]);
    return before.call(redis, commands);
  };
  try {
    await countFunnelStep(sid, plain, 0, "visitor-1");
    await countFunnelDone(sid, plain, 1, "visitor-1", product("course0001"));
    await readFunnelCountsStrict(sid, plain);
  } finally {
    redis.pipeline = before;
  }
  is("the same keys and commands as before splits", sent, [
    [["PFADD", `nl:pfunnel:seen:${sid}:plainplain:${NOW}:0`, "visitor-1"], ["EXPIRE", `nl:pfunnel:seen:${sid}:plainplain:${NOW}:0`, 400 * 86_400]],
    [["PFADD", `nl:pfunnel:done:${sid}:plainplain:${NOW}:1`, "visitor-1"], ["EXPIRE", `nl:pfunnel:done:${sid}:plainplain:${NOW}:1`, 400 * 86_400]],
    [["PFCOUNT", `nl:pfunnel:seen:${sid}:plainplain:${NOW}:0`], ["PFCOUNT", `nl:pfunnel:done:${sid}:plainplain:${NOW}:0`], ["PFCOUNT", `nl:pfunnel:seen:${sid}:plainplain:${NOW}:1`], ["PFCOUNT", `nl:pfunnel:done:${sid}:plainplain:${NOW}:1`]],
  ]);
  is("no reads per version and no studio requests for them", [await readSplitCountsStrict(sid, plain), splitCountUnits(plain)], [[null, null], 0]);
  is("the counts' room: two counts a page, a split's every page", [funnelCountsBytes(plain), funnelCountsBytes(funnel)], [2 * FUNNEL_COUNT_BYTES_PER_STEP, 4 * FUNNEL_COUNT_BYTES_PER_STEP]);

  part("Counts that cannot be read stay unknown");
  const original = redis.pipeline;
  try {
    for (const replies of [[], [0, 0, 0], Array(4), [0, 0, 0, 0, 0]]) {
      redis.pipeline = async () => replies;
      let failed = false;
      try { await readSplitCountsStrict(sid, funnel); } catch { failed = true; }
      is("an incomplete or extra reply is unknown, never 0: " + JSON.stringify(replies), failed, true);
    }
    for (const odd of [null, "", "x", -1, 1.5, "1e2", {}, true]) {
      redis.pipeline = async (commands) => commands.map(() => odd);
      let failed = false;
      try { await readSplitCountsStrict(sid, funnel); } catch { failed = true; }
      is("an odd count is unknown, never 0: " + String(odd), failed, true);
    }
    redis.pipeline = async () => { throw new Error("down"); };
    let failed = false;
    try { await readSplitCountsStrict(sid, funnel); } catch { failed = true; }
    is("a failed read is unknown", failed, true);
    failed = false;
    try { await readSplitCountsStrict(null, funnel); } catch { failed = true; }
    is("a store without its numbers' id is unknown", failed, true);
  } finally {
    redis.pipeline = original;
  }

  part("The studio requests that pay for the reads per version");
  const four: PageFunnel = { ...funnel, steps: Array.from({ length: 10 }, (_, i) => ({ kind: "split" as const, id: `split${String(i).padStart(5, "0")}`, options: [{ ...page(`pa${i}`), share: 50 }, { ...page(`pb${i}`), share: 50 }] })) };
  is("one studio request for ten versions' two reads; the dearest funnel, twenty versions, two", [splitCountUnits(funnel), splitCountUnits(four)], [1, 2]);

  part("The verdict comes from the winner rule, with only real figures");
  const split = steps[1] as SplitStep;
  const kinds = [{ product: false, free: false }, { product: false, free: false }];
  const counts = [{ version: "a", seen: 2, done: 0 }, { version: "b", seen: 2, done: 1 }];
  const later = (NOW + 40 * 86_400) * 1000;
  const view = splitView({ step: split, titles: ["Offer A", "Offer B"], kinds, counts, since: NOW, now: later });
  const fed = abDecision({ versions: [{ id: "a", visitors: 2 }, { id: "b", visitors: 2 }] as unknown as AbVersion[], startedAt: NOW * 1000, now: later, shares: [0.5, 0.5] });
  is("the rows, side by side, from the counts", view.rows, [
    { version: "a", label: "Version A", title: "Offer A", seen: 2, done: 0 },
    { version: "b", label: "Version B", title: "Offer B", seen: 2, done: 1 },
  ]);
  is("the words are abDecision's own for what is real", [view.words, view.result, view.winner], [fed.words, "no_clear_winner_yet", null]);
  is("no money is made up: the note says what the rule still needs", view.note, SPLIT_MONEY_NOTE);
  const paid = splitView({ step: { ...split, options: [{ ...product("prodaaaa01"), share: 50 }, { ...product("prodbbbb01"), share: 50 }] }, titles: ["A", "B"], kinds: [{ product: true, free: false }, { product: true, free: false }], counts: [{ version: "a", seen: 5000, done: 300 }, { version: "b", seen: 5000, done: 10 }], since: NOW, now: later });
  is("however far ahead in sales, no winner without the money after refunds", [paid.result, paid.winner], ["no_clear_winner_yet", null]);
  const unread = splitView({ step: split, titles: ["Offer A", "Offer B"], kinds, counts: null, since: NOW, now: later });
  is("unread counts: unavailable in every row, and no winner", [unread.rows.map((row) => [row.seen, row.done]), unread.result, unread.winner], [[[null, null], [null, null]], "no_clear_winner_yet", null]);
  is("unread counts: the rule says it could not read them", unread.words, abDecision({ versions: [{ id: "a" }, { id: "b" }] as unknown as AbVersion[], startedAt: NOW * 1000, now: later, shares: [0.5, 0.5] }).words);

  part("The studio row: the figures side by side, and the verdict");
  const shown = html(createElement(SplitResults, { view, step: 2 }));
  is("a table with a caption and header cells", [shown.includes("<table"), /<caption[^>]*>[^<]*Split test results, step 2/.test(shown), (shown.match(/<th[^>]*scope="col"/g) ?? []).length >= 3, (shown.match(/<th[^>]*scope="row"/g) ?? []).length], [true, true, true, 2]);
  is("each version's numbers in words with their labels", [shown.includes("Version A"), shown.includes("Offer B"), shown.includes("People who opened it"), shown.includes("Signed up or paid")], [true, true, true, true]);
  is("the verdict and the note in text", [shown.includes(view.words.replace(/'/g, "&#x27;")), shown.includes(SPLIT_MONEY_NOTE)], [true, true]);
  const unshown = html(createElement(SplitResults, { view: unread, step: 2 }));
  is("unread counts are said, never 0", [(unshown.match(/Count unavailable/g) ?? []).length, />0</.test(unshown)], [4, false]);
  is("no winner badge while the rule names none", [shown.includes("Winner"), unshown.includes("Winner")], [false, false]);

  part("In a store: the beacon and the sign-up count the version the person is on");
  await claimHandle(OWNER, "splitres", "Split Results", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  if (!course.ok) throw new Error("no product");
  await setSitePages(OWNER, [
    { id: "landing001", slug: "start", title: "Start", nav: false, target: "", from: 0 },
    { id: "versiona01", slug: "offer-a", title: "Offer A", nav: false, target: "", from: 0 },
    { id: "versionb01", slug: "offer-b", title: "Offer B", nav: false, target: "", from: 0 },
  ]);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const input = readFunnelInput({ name: "Launch", steps: [page("landing001"), { kind: "split", options: [page("versiona01"), page("versionb01")] }, product(course.product.id)] }, [], NOW);
  if (!input.ok) throw new Error("not read");
  const saved = await writePageFunnel(statsId, input.funnel, [], ROOM);
  const hit = (body: Record<string, string>, ip: string) =>
    hitRoute(new NextRequest("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": PHONE, "x-forwarded-for": ip }, body: JSON.stringify(body) }));
  await hit({ h: "splitres", k: "f", f: saved.id, t: "g", id: "versiona01" }, "198.51.100.1");
  await hit({ h: "splitres", k: "f", f: saved.id, t: "g", id: "versiona01" }, "198.51.100.2");
  await hit({ h: "splitres", k: "f", f: saved.id, t: "g", id: "versionb01" }, "198.51.100.3");
  const here = await funnelHere(store, saved.id, "page", "versionb01");
  is("a page in a split says which of its pages it is", here?.place, page("versionb01"));
  is("the beacon counts the version opened", (await readSplitCountsStrict(statsId, saved))[1], [{ version: "a", seen: 2, done: 0 }, { version: "b", seen: 1, done: 0 }]);
  const sources = ["app/api/store/form/route.ts", "app/api/store/free/route.ts", "app/[handle]/thanks/page.tsx"].map((file) => readFileSync(file, "utf8"));
  is("every sign-up and sale counted passes the page it was on", sources.map((source) => /countFunnelDone\([^;]*\.place\)/.test(source)), [true, true, true]);

  part("The studio page");
  const studio = readFileSync("app/studio/funnels/page.tsx", "utf8");
  is("reads per version only after taking the studio requests for them", [/countStudio\(store, null, splitUnits\)/.test(studio), studio.indexOf("countStudio(store, null, splitUnits)") < studio.indexOf("readSplitCountsStrict(")], [true, true]);
  const editor = readFileSync("components/page-funnel-editor.tsx", "utf8");
  is("the saved split's row draws the results", /<SplitResults view=\{step\.split\}/.test(editor), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
