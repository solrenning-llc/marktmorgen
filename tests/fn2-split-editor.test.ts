/**
 * 526 [FN2], unit 4: the creator builds and edits a split test in the studio's
 * funnel editor ("Pages in order", components/page-funnel-editor.tsx), by
 * click or keyboard, with no dragging (WCAG 2.5.7). Fails on:
 *   - no way to add a split test at a chosen place, or to edit a saved one;
 *   - shares that do not add up to 100 let through, or a total said without
 *     its words ("Total: 90%. The shares must add up to 100%.");
 *   - fewer than 2 or more than 4 destinations let through;
 *   - a page or product already in the funnel let in again;
 *   - more than 20 pages in a funnel let through to the server;
 *   - an edited split not sent in the shape the save route keeps as it is;
 *   - the destinations without a fieldset, a legend, and a label for each
 *     share that names its page.
 * The browser checks mirror lib/funnel-split-rules.ts; the server stays the authority.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { MAX_FUNNEL_PAGES, type PageFunnelStep } from "@/lib/page-funnel";
import { parseSplit } from "@/lib/funnel-split-rules";
import {
  SPLIT_EXPLAIN,
  addDestination,
  checkSplitDraft,
  editSplitDraft,
  newSplitDraft,
  removeDestination,
  setEqual,
  stepsForSave,
  totalWords,
} from "@/lib/funnel-split-draft";
import { FunnelSplitEditor } from "@/components/funnel-split-editor";
import { POST as saveRoute } from "@/app/api/store/page-funnels/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSitePages } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const OWNER = "spliteditor@example.com";

const page = (id: string) => ({ kind: "page" as const, id });
const choice = (id: string) => ({ kind: "page" as const, id, title: `Page ${id}`, note: "" });
const choices = ["p1", "p2", "p3", "p4", "p5", "p6"].map(choice);

async function main(): Promise<void> {
  part("Adding a split test at a chosen place");
  const steps: PageFunnelStep[] = [page("p1"), page("p2")];
  const fresh = newSplitDraft(steps, choices, 1);
  is("a new split starts with the first two pages not in the funnel, split equally", fresh && [fresh.at, fresh.editing, fresh.options, fresh.equal], [1, null, ["page:p3", "page:p4"], true]);
  const placed = fresh ? checkSplitDraft(fresh, steps, choices) : null;
  is("it goes where the creator chose: after step 1", placed?.ok ? placed.steps.map((s) => s.kind) : null, ["page", "split", "page"]);
  is("equal shares are whole and add up to 100", placed?.ok ? (placed.steps[1] as { options: { share: number }[] }).options.map((o) => o.share) : null, [50, 50]);
  const first = newSplitDraft(steps, choices, 0);
  const atStart = first ? checkSplitDraft(first, steps, choices) : null;
  is("or at the start", atStart?.ok ? atStart.steps[0].kind : null, "split");
  is("with fewer than two pages left to choose, no split can be added", newSplitDraft([page("p1"), page("p2"), page("p3"), page("p4"), page("p5")], choices, 0), null);

  part("Equal or chosen shares");
  const three = fresh ? addDestination(fresh, steps, choices) : null;
  is("a third destination: equal shares 34, 33, 33", three ? (checkSplitDraft(three, steps, choices) as { steps: { options?: { share: number }[] }[] }).steps[1].options?.map((o) => o.share) : null, [34, 33, 33]);
  const custom = fresh ? { ...setEqual(fresh, false), shares: ["70", "30"] } : null;
  const customOk = custom ? checkSplitDraft(custom, steps, choices) : null;
  is("chosen shares that add up to 100 are kept", customOk?.ok ? (customOk.steps[1] as { options: { share: number }[] }).options.map((o) => o.share) : null, [70, 30]);
  is("leaving equal fills in the equal shares to change", fresh ? setEqual(fresh, false).shares : null, ["50", "50"]);
  const short = custom ? checkSplitDraft({ ...custom, shares: ["60", "30"] }, steps, choices) : null;
  is("a total that is not 100 is refused with the exact words", short && !short.ok ? short.problems.find((p) => p.field === "total")?.message : null, "Total: 90%. The shares must add up to 100%.");
  is("the total is said in words as it changes", [custom ? totalWords({ ...custom, shares: ["60", "30"] }) : "", custom ? totalWords(custom) : ""], ["Total: 90%. The shares must add up to 100%.", "Total: 100%. The shares add up to 100%."]);
  const bad = custom ? checkSplitDraft({ ...custom, shares: ["100", "0"] }, steps, choices) : null;
  is("a share outside 1 to 99, or not whole, is refused at its field", bad && !bad.ok ? bad.problems.filter((p) => p.field === "share").map((p) => [p.index, p.message]) : null, [[0, "Type a whole number from 1 to 99."], [1, "Type a whole number from 1 to 99."]]);
  is("so is a share with a decimal", custom && !checkSplitDraft({ ...custom, shares: ["50.5", "49.5"] }, steps, choices).ok, true);

  part("Two to four destinations");
  is("one destination is refused", fresh ? checkSplitDraft({ ...fresh, options: ["page:p3"], shares: ["100"] }, steps, choices).ok : null, false);
  is("and its words say why", fresh ? (checkSplitDraft({ ...fresh, options: ["page:p3"], shares: ["100"] }, steps, choices) as { problems: { field: string; message: string }[] }).problems.find((p) => p.field === "count")?.message : null, "A split test needs 2 to 4 pages or products.");
  is("five destinations are refused", fresh ? checkSplitDraft({ ...fresh, options: ["page:p3", "page:p4", "page:p5", "page:p6", "page:p1"], shares: ["20", "20", "20", "20", "20"] }, [], choices).ok : null, false);
  is("removing a destination stops at two", fresh ? removeDestination(fresh, 0).options : null, ["page:p3", "page:p4"]);
  const four = three ? addDestination(three, steps, choices) : null;
  is("adding stops at four", four ? addDestination(four, steps, choices).options.length : null, 4);

  part("Each page or product once in the whole funnel");
  const repeat = fresh ? checkSplitDraft({ ...fresh, options: ["page:p3", "page:p1"] }, steps, choices) : null;
  is("a destination already a step is refused, at its field", repeat && !repeat.ok ? repeat.problems.map((p) => [p.field, p.index, p.message]) : null, [["option", 1, "Page p1 is already in this funnel. Choose another page or product."]]);
  const twice = fresh ? checkSplitDraft({ ...fresh, options: ["page:p3", "page:p3"] }, steps, choices) : null;
  is("the same destination twice is refused", twice && !twice.ok ? twice.problems.map((p) => [p.field, p.index]) : null, [["option", 1]]);

  part("Twenty pages at most, each destination counted");
  const full: PageFunnelStep[] = Array.from({ length: MAX_FUNNEL_PAGES - 1 }, (_, i) => page(`f${i}`));
  const many = [...full.map((s) => ({ kind: s.kind, id: (s as { id: string }).id, title: (s as { id: string }).id, note: "" })), ...choices];
  const tooMany = { at: full.length, editing: null, id: "", options: ["page:p1", "page:p2"], equal: true, shares: ["50", "50"] };
  const over = checkSplitDraft(tooMany, full, many);
  is("a split that takes the funnel past 20 pages is refused with the count", over.ok ? null : over.problems.find((p) => p.field === "pages")?.message, `This funnel would have ${MAX_FUNNEL_PAGES + 1} pages. A funnel can have ${MAX_FUNNEL_PAGES} at most. Remove a step or a destination.`);
  is("with room for one page only, no split can be added", newSplitDraft(full, many, 0), null);

  part("Editing a saved split");
  const saved: PageFunnelStep[] = [page("p1"), { kind: "split", id: "splitaaaaa", options: [{ ...page("p2"), share: 70 }, { ...page("p3"), share: 30 }] }];
  const edit = editSplitDraft(saved, 1);
  is("a saved split opens with its pages, its shares and its id", edit && [edit.editing, edit.id, edit.options, edit.equal, edit.shares], [1, "splitaaaaa", ["page:p2", "page:p3"], false, ["70", "30"]]);
  is("a saved equal split opens as equal", editSplitDraft([{ kind: "split", id: "splitbbbbb", options: [{ ...page("p2"), share: 34 }, { ...page("p3"), share: 33 }, { ...page("p4"), share: 33 }] }], 0)?.equal, true);
  is("a step that is not a split is not opened as one", editSplitDraft(saved, 0), null);
  const kept = edit ? checkSplitDraft(edit, saved, choices) : null;
  is("its own pages are not counted as used elsewhere, and it stays in its place", kept?.ok ? kept.steps : null, saved);
  const moved = edit ? checkSplitDraft({ ...edit, shares: ["60", "40"] }, saved, choices) : null;
  is("new shares replace it in place", moved?.ok ? (moved.steps[1] as { id: string; options: { share: number }[] }).options.map((o) => o.share) : null, [60, 40]);

  part("Sent as the save route keeps it");
  const sent = placed?.ok ? stepsForSave(placed.steps) : [];
  is("a new split is sent without an id, so the server gives it one", sent[1] && "id" in (sent[1] as object), false);
  is("what is sent passes the server's own rules", parseSplit(sent[1]) !== null, true);
  is("a saved split keeps its id when sent", (stepsForSave(saved)[1] as { id?: string }).id, "splitaaaaa");

  redis.clear();
  await claimHandle(OWNER, "spliteditor", "Split Editor", "");
  await ensureStatsId(OWNER);
  await setSitePages(OWNER, ["p1", "p2", "p3"].map((id) => ({ id: `${id}aaaaaaa`, slug: `${id}-x`, title: id, nav: false, target: "", from: 0 })));
  const session = await openSession(OWNER);
  const save = async (funnel: unknown) =>
    (await saveRoute(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ funnel }) }))).json();
  const real = ["p1", "p2", "p3"].map((id) => ({ kind: "page" as const, id: `${id}aaaaaaa`, title: id, note: "" }));
  const start: PageFunnelStep[] = [{ kind: "page", id: "p1aaaaaaa" }];
  const made = newSplitDraft(start, real, 1);
  const madeSteps = made ? checkSplitDraft({ ...setEqual(made, false), shares: ["65", "35"] }, start, real) : null;
  const first1 = madeSteps?.ok ? await save({ name: "Round trip", steps: stepsForSave(madeSteps.steps) }) : null;
  const back = first1?.funnel?.steps as PageFunnelStep[] | undefined;
  is("the real save route keeps a split made in the editor", back && [back[1].kind, (back[1] as { options: { share: number }[] }).options.map((o) => o.share)], ["split", [65, 35]]);
  const reopened = back ? editSplitDraft(back, 1) : null;
  const again = reopened ? checkSplitDraft(reopened, back!, real) : null;
  const second = again?.ok ? await save({ id: first1.funnel.id, name: "Round trip", slug: first1.funnel.slug, steps: stepsForSave(again.steps) }) : null;
  is("edited unchanged, it comes back the same, same id and since", second && [second.funnel.steps, second.funnel.since], [back, first1?.funnel?.since]);

  part("The form a creator sees");
  const markup = fresh
    ? renderToStaticMarkup(createElement(FunnelSplitEditor, { draft: setEqual(fresh, false), steps, choices, onChange: () => {}, onApply: () => {}, onCancel: () => {} }))
    : "";
  is("the destinations are in a fieldset with a legend", /<fieldset[^>]*>\s*<legend[^>]*>[^<]*Pages to split visitors between/.test(markup), true);
  is("the way to split is a fieldset with a legend, equal or chosen", /<legend[^>]*>How to share visitors<\/legend>/.test(markup) && markup.includes("Split equally") && markup.includes("Set the shares myself"), true);
  is("each share has a label naming its page", markup.includes("Share for Page p3, in percent") && markup.includes("Share for Page p4, in percent"), true);
  is("each destination's choice is labelled with its version", markup.includes(">Version A<") && markup.includes(">Version B<"), true);
  is("the total is said in a live region", /aria-live="polite"[^>]*>Total: 100%\. The shares add up to 100%\./.test(markup), true);
  is("the place to put it can be chosen without dragging", markup.includes("Where it goes") && markup.includes("After step 1"), true);
  is("it says what a split test is, and how the winner is decided", markup.includes(SPLIT_EXPLAIN) && /net sales after refunds/.test(SPLIT_EXPLAIN) && /never by clicks/.test(SPLIT_EXPLAIN), true);
  is("a review of what the visitor gets comes before the button", markup.indexOf("Visitors who reach this step go to") > 0 && markup.indexOf("Visitors who reach this step go to") < markup.indexOf("Use this split test"), true);
  is("the buttons are at least 44 px tall", (markup.match(/class="btn[^"]*"/g) ?? []).length >= 3 && !/class="btn[^"]*btn-sm/.test(markup) ? true : markup, true);
  const wrong = custom ? renderToStaticMarkup(createElement(FunnelSplitEditor, { draft: { ...custom, shares: ["60", "x"] }, steps, choices, onChange: () => {}, onApply: () => {}, onCancel: () => {} })) : "";
  is("an error is said in words next to its field, tied to it", /aria-invalid="true"[^>]*aria-describedby="[^"]*share-1-error/.test(wrong) && wrong.includes("Type a whole number from 1 to 99."), true);
  is("and the button that would use a wrong split is turned off", /<button[^>]*disabled=""[^>]*>Use this split test/.test(wrong), true);

  part("The funnel editor uses it");
  const editor = readFileSync("components/page-funnel-editor.tsx", "utf8");
  is("there is a button to add a split test", /Add a split test/.test(editor), true);
  is("a saved split has a button to edit it", /Edit split test/.test(editor), true);
  is("the save sends the steps through stepsForSave", /steps: stepsForSave\(draft\.steps\)/.test(editor), true);
  is("the funnel cannot be saved while a split test is half edited", /disabled=\{locked \|\| splitDraft !== null/.test(editor), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
