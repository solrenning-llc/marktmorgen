/**
 * "Getting your store ready" (484 [IT1], checklist unit 1; added 2 November
 * 2026): at most five steps to the first sale, each checked off from the store's
 * own records, then the rest, never more than five at a time; nothing taken
 * away; collapsible with its title, progress and next step in sight.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { StudioStart, type StartStep } from "@/components/studio-start";
import { FIRST_SALE_KEYS, MAX_START_STEPS, startList, startProgressWords } from "@/lib/studio-start-rules";
import { done, is, part } from "./check";

const step = (key: string, isDone = false): StartStep => ({ key, title: `Title ${key}`, hint: `Hint ${key}`, done: isDone, href: `#${key}` });
/** Every step the studio can list, in its order (app/studio/page.tsx). */
const ALL = ["address", "details", "look", "product", "publish", "stripe", "plan", "test", "recovery", "share"];
const steps = (doneKeys: string[] = ["address"], keys = ALL) => keys.map((k) => step(k, doneKeys.includes(k)));
const keys = (list: { key: string }[]) => list.map((s) => s.key);

part("The steps to the first sale");
is("at most five, in the order of the first sale", [keys(startList(steps()).steps), startList(steps()).phase, MAX_START_STEPS], [[...FIRST_SALE_KEYS], "first-sale", 5]);
is("without Stripe and the checkout where the studio does not list them", keys(startList(steps(["address"], ["address", "details", "look", "product", "publish", "recovery", "share"])).steps), ["product", "publish", "share"]);
is("'Your address' is never shown, done or not", [startList(steps([])).steps.some((s) => s.key === "address"), startList(steps(ALL.filter((k) => k !== "details"))).steps.some((s) => s.key === "address")], [false, false]);
is("the check marks are the store's own, never set here", startList(steps(["address", "product", "stripe"])).steps.map((s) => s.done), [true, false, true, false, false]);
is("one step to the first sale still open keeps them, whatever else is done", keys(startList(steps(ALL.filter((k) => k !== "share"))).steps), [...FIRST_SALE_KEYS]);
is("a step done before the ones to the first sale does not jump ahead", keys(startList(steps(["address", "details", "look", "recovery"])).steps), [...FIRST_SALE_KEYS]);

part("Then the rest");
const after = startList(steps(["address", ...FIRST_SALE_KEYS]));
is("once the first sale's are done: the rest, in their order", [after.phase, keys(after.steps)], ["after", ["details", "look", "test", "recovery"]]);
const many = Array.from({ length: 8 }, (_, i) => step(`extra${i}`, i % 2 === 0));
const crowded = startList([...steps(["address", ...FIRST_SALE_KEYS]), ...many]);
is("never more than five at a time, the open ones first chosen, shown in their order", [crowded.steps.length, crowded.steps.filter((s) => !s.done).length, keys(crowded.steps)], [5, 5, ["details", "look", "test", "recovery", "extra1"]]);
is("everything done: the first sale's, all checked (the list then hides itself)", [startList(steps(ALL)).phase, keys(startList(steps(ALL)).steps), startList(steps(ALL)).steps.every((s) => s.done)], ["first-sale", [...FIRST_SALE_KEYS], true]);
is("nothing listed: nothing shown", startList([]).steps, []);
is("the progress in words, for each part", [startProgressWords("first-sale", 2, 5, true), startProgressWords("after", 1, 4, true)], ["2 of 5 steps to your first sale done. Everything saves as you go, so you can stop and come back.", "The steps to your first sale are done. 1 of 4 more steps done."]);
const NO_SALE = ["address", "details", "look", "product", "publish", "recovery", "share"];
is("a sale needs Stripe and the checkout: only with both listed", [startList(steps()).toSale, startList(steps(["address"], NO_SALE)).toSale, startList(steps(["address"], ALL.filter((k) => k !== "plan"))).toSale], [true, false, false]);
is("without them, never a word of a first sale", [startProgressWords("first-sale", 1, 3, false), startProgressWords("after", 0, 3, false)], ["1 of 3 first steps done. Everything saves as you go, so you can stop and come back.", "The first steps are done. 0 of 3 more steps done."]);

part("The rendered list");
const render = (list: StartStep[], activation?: Parameters<typeof StudioStart>[0]["activation"], launchChecklist?: string) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(StudioStart, { steps: list, activation, launchChecklist })));
const html = render(steps(["address", "product"]));
const items = [...html.matchAll(/<li /g)].length;
is("five steps, the progress in words and as a bar of five", [items, html.includes("1 of 5 steps to your first sale done."), /aria-valuemax="5"/.test(html), /aria-valuenow="1"/.test(html), /aria-valuetext="1 of 5"/.test(html)], [5, true, true, true, true]);
is("the next step to do is the main action", /<a class="btn btn-primary[^"]*" href="#publish">Next: Title publish/.test(html), true);
is("collapsible, open at first, its summary saying what pressing does", [/<details class="group\/start[^"]*" open="">/.test(html), html.includes("Show the steps"), html.includes("Hide the steps")], [true, true, true]);
const title = html.indexOf('id="start-title"'), bar = html.indexOf('role="progressbar"'), disclosure = html.indexOf("<details"), next = html.indexOf("Next: ");
is("the title, progress and next step stay outside what collapses", [title < disclosure, bar < disclosure, next < disclosure], [true, true, true]);
is("a step done is said in words, not only by a check", html.includes("(done)"), true);
is("everything done and nothing to say: no list", [render(steps(ALL)), render([])], ["", ""]);
is("everything done with the first offer's timing: the list stays to say it", render(steps(ALL), { state: "published", minutes: 12 } as never).includes("First offer published 12 minutes"), true);
const later = render(steps(["address", ...FIRST_SALE_KEYS]));
is("the rest, once the first sale's are done", [later.includes('data-start-phase="after"'), later.includes("The steps to your first sale are done. 0 of 4 more steps done."), [...later.matchAll(/<li /g)].length], [true, true, 4]);

const noSale = render(steps(["address", "product", "publish", "share"], NO_SALE));
is("a store that cannot sell yet is never told its first sale's steps are done", [noSale.includes("first sale"), noSale.includes("The first steps are done. 0 of 3 more steps done."), /aria-label="More steps done"/.test(noSale)], [false, true, true]);
is("while those three are open, still no first sale", [render(steps(["address"], NO_SALE)).includes("first sale"), render(steps(["address"], NO_SALE)).includes("0 of 3 first steps done.")], [false, true]);
const saved = render(steps(["address"]), { state: "waiting", minutes: 3 } as never, "Saved line one");
const summaries = [...saved.matchAll(/<summary class="([^"]*)"/g)].map((m) => m[1]);
is("the saved launch checklist inside, each disclosure with its own words, no second marker, no motion asked for", [summaries.length, saved.includes("Review the saved launch checklist"), saved.includes("Saved line one"), summaries.every((c) => c.includes("list-none") && c.includes("[&amp;::-webkit-details-marker]:hidden")), (saved.match(/transition-transform(?! motion-reduce)/g) ?? []).length], [2, true, true, true, 0]);
is("the first offer's timing stays outside what collapses", saved.indexOf("data-activation-timing") < saved.indexOf("<details"), true);

part("Nothing taken away");
const page = readFileSync("app/studio/page.tsx", "utf8");
const listed = [...page.slice(page.indexOf("const startSteps: StartStep[]"), page.indexOf("const connectTestMode")).matchAll(/key: "([a-z]+)",\s*title:/g)].map((m) => m[1]);
is("the studio still lists every step to the component, which picks", [listed, page.includes("<StudioStart steps={startSteps}")], [ALL, true]);
const recovery = readFileSync("components/recovery-address-manager.tsx", "utf8");
is("each step not shown first keeps its own place in the studio", [page.includes('id="details"'), page.includes('id="look"'), recovery.includes('id="account-recovery"'), page.includes("<RecoveryAddressManager")], [true, true, true, true]);

done();
