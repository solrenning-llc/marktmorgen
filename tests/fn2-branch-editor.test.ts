/**
 * 526 [FN2], unit 5: the creator builds and edits a conditional path in the
 * studio's funnel editor, by click or keyboard, with no dragging (WCAG 2.5.7).
 * Fails on:
 *   - no way to add a conditional path at a chosen place, or to edit a saved one;
 *   - a tag rule with no word, more than 4 rules, or "bought" with no product
 *     step just before it let through;
 *   - a page or product already in the funnel let in again;
 *   - a new branch sent with an id, or an edited one not kept as it was;
 *   - the rules without a fieldset and a legend, a field without its label, or
 *     an error not said next to its field and tied to it.
 * The browser checks mirror lib/funnel-branch-rules.ts; the server stays the authority.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { MAX_FUNNEL_PAGES, type PageFunnelStep } from "@/lib/page-funnel";
import { parseBranch } from "@/lib/funnel-branch-rules";
import { BRANCH_EXPLAIN, BRANCH_WORDS, addRule, checkBranchDraft, editBranchDraft, newBranchDraft, removeRule } from "@/lib/funnel-branch-draft";
import { stepsForSave } from "@/lib/funnel-split-draft";
import { FunnelBranchEditor } from "@/components/funnel-branch-editor";
import { POST as saveRoute } from "@/app/api/store/page-funnels/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setSitePages } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const OWNER = "brancheditor@example.com";

const page = (id: string) => ({ kind: "page" as const, id });
const choice = (id: string) => ({ kind: "page" as const, id, title: `Page ${id}`, note: "" });
const choices = ["p1", "p2", "p3", "p4", "p5", "p6"].map(choice);
const noop = () => {};

async function main(): Promise<void> {
  part("Adding a conditional path at a chosen place");
  const steps: PageFunnelStep[] = [page("p1"), page("p2")];
  const fresh = newBranchDraft(steps, choices, 1);
  is("a new path starts with one rule and a default, on the first two pages not in the funnel", fresh && [fresh.at, fresh.editing, fresh.rules, fresh.otherwise], [1, null, [{ if: "phone", value: "", to: "page:p3" }], "page:p4"]);
  const placed = fresh ? checkBranchDraft(fresh, steps, choices) : null;
  is("it goes where the creator chose: after step 1", placed?.ok ? placed.steps.map((s) => s.kind) : null, ["page", "branch", "page"]);
  is("or at the start", fresh && (checkBranchDraft({ ...fresh, at: 0 }, steps, choices) as { steps: PageFunnelStep[] }).steps[0].kind, "branch");
  is("with fewer than two pages left, none can be added", newBranchDraft(choices.slice(0, 5).map((c) => page(c.id)), choices, 0), null);

  part("Rules");
  const tagged = fresh ? { ...fresh, rules: [{ if: "campaign" as const, value: "  Spring-Sale ", to: "page:p3" }] } : null;
  const taggedOk = tagged ? checkBranchDraft(tagged, steps, choices) : null;
  is("a tag word is kept cleaned, the way visits are counted", taggedOk?.ok ? taggedOk.steps[1] : null, { kind: "branch", id: "", rules: [{ if: "campaign", value: "spring-sale", to: page("p3") }], otherwise: page("p4") });
  const empty = tagged ? checkBranchDraft({ ...tagged, rules: [{ ...tagged.rules[0], value: " !! " }] }, steps, choices) : null;
  is("a tag rule with no word is refused at its field", empty && !empty.ok ? empty.problems.map((p) => [p.field, p.index, p.message]) : null, [["value", 0, BRANCH_WORDS.value]]);
  const offer = fresh ? checkBranchDraft({ ...fresh, rules: [{ if: "bought", value: "", to: "page:p3" }] }, steps, choices) : null;
  is("bought with no product just before is refused, with why", offer && !offer.ok ? offer.problems.map((p) => [p.field, p.message]) : null, [["if", BRANCH_WORDS.offer]]);
  const afterProduct: PageFunnelStep[] = [{ kind: "product", id: "prod000001" }];
  const declined = newBranchDraft(afterProduct, choices, 1);
  is("declined right after a product is fine", declined ? checkBranchDraft({ ...declined, rules: [{ if: "declined", value: "", to: declined.rules[0].to }] }, afterProduct, choices).ok : null, true);
  const four = fresh ? [1, 2, 3].reduce((d) => addRule(d, steps, choices), fresh) : null;
  is("adding stops at four rules", four ? [four.rules.length, addRule(four, steps, choices).rules.length] : null, [3, 3]);
  const roomy = newBranchDraft([], choices, 0);
  const max = roomy ? [1, 2, 3, 4].reduce((d) => addRule(d, [], choices), roomy) : null;
  is("with room, four rules and no more", max?.rules.length, 4);
  is("removing stops at one rule", fresh ? removeRule(fresh, 0).rules.length : null, 1);

  part("Each page or product once in the whole funnel");
  const repeat = fresh ? checkBranchDraft({ ...fresh, otherwise: "page:p1" }, steps, choices) : null;
  is("a default already a step is refused, at its field", repeat && !repeat.ok ? repeat.problems.map((p) => [p.field, p.message]) : null, [["otherwise", "Page p1 is already in this funnel. Choose another page or product."]]);
  const twice = fresh ? checkBranchDraft({ ...fresh, otherwise: "page:p3" }, steps, choices) : null;
  is("the same page twice in the path is refused", twice && !twice.ok ? twice.problems.map((p) => [p.field, p.message]) : null, [["otherwise", BRANCH_WORDS.repeat]]);
  const fullIds = Array.from({ length: MAX_FUNNEL_PAGES - 1 }, (_, i) => `f${i}`);
  const over = checkBranchDraft({ editing: null, at: 0, id: "", rules: [{ if: "phone", value: "", to: "page:p1" }], otherwise: "page:p2" }, fullIds.map(page), [...fullIds.map(choice), ...choices]);
  is("a path that takes the funnel past 20 pages is refused with the count", over.ok ? null : over.problems.find((p) => p.field === "pages")?.message, `This funnel would have ${MAX_FUNNEL_PAGES + 1} pages. A funnel can have ${MAX_FUNNEL_PAGES} at most. Remove a step or a rule.`);

  part("Editing a saved path, and sending it");
  const saved: PageFunnelStep[] = [page("p1"), { kind: "branch", id: "branchaaaa", rules: [{ if: "source", value: "news", to: page("p2") }], otherwise: page("p3") }];
  const edit = editBranchDraft(saved, 1);
  is("a saved path opens with its rules, default and id", edit && [edit.editing, edit.id, edit.rules, edit.otherwise], [1, "branchaaaa", [{ if: "source", value: "news", to: "page:p2" }], "page:p3"]);
  is("a step that is not one is not opened as one", editBranchDraft(saved, 0), null);
  const kept = edit ? checkBranchDraft(edit, saved, choices) : null;
  is("edited unchanged, it stays the same in its place", kept?.ok ? kept.steps : null, saved);
  const sent = placed?.ok ? stepsForSave(placed.steps) : [];
  is("a new path is sent without an id, and passes the server's own rules", [sent[1] && "id" in (sent[1] as object), parseBranch(sent[1]) !== null], [false, true]);
  is("a saved path keeps its id when sent", (stepsForSave(saved)[1] as { id?: string }).id, "branchaaaa");

  redis.clear();
  await claimHandle(OWNER, "brancheditor", "Branch Editor", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  if (!course.ok) throw new Error("no product");
  await setSitePages(OWNER, ["p1", "p2", "p3"].map((id) => ({ id: `${id}aaaaaaaa`, slug: `${id}-x`, title: id, nav: false, target: "", from: 0 })));
  const session = await openSession(OWNER);
  const save = async (funnel: unknown) =>
    (await saveRoute(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ funnel }) }))).json();
  const real = [{ kind: "product" as const, id: course.product.id, title: "Course", note: "" }, ...["p1", "p2", "p3"].map((id) => ({ kind: "page" as const, id: `${id}aaaaaaaa`, title: id, note: "" }))];
  const start: PageFunnelStep[] = [{ kind: "product", id: course.product.id }];
  const made = newBranchDraft(start, real, 1);
  const madeSteps = made ? checkBranchDraft({ ...made, rules: [{ if: "declined", value: "", to: made.rules[0].to }, { if: "campaign", value: "Spring", to: "page:p3aaaaaaaa" }] }, start, real) : null;
  const first = madeSteps?.ok ? await save({ name: "Round trip", steps: stepsForSave(madeSteps.steps) }) : null;
  const back = first?.funnel?.steps as PageFunnelStep[] | undefined;
  is("the real save route keeps a path made in the editor", back && back[1].kind === "branch" ? [back[1].rules.map((r) => r.if), /^[a-z0-9]{10}$/.test(back[1].id)] : first, [["declined", "campaign"], true]);
  const reopened = back ? editBranchDraft(back, 1) : null;
  const again = reopened ? checkBranchDraft(reopened, back!, real) : null;
  const second = again?.ok ? await save({ id: first.funnel.id, name: "Round trip", slug: first.funnel.slug, steps: stepsForSave(again.steps) }) : null;
  is("edited unchanged, it comes back the same, same id and since", second && [second.funnel.steps, second.funnel.since], [back, first?.funnel?.since]);

  part("The form a creator sees");
  const markup = tagged ? renderToStaticMarkup(createElement(FunnelBranchEditor, { draft: tagged, steps, choices, onChange: noop, onApply: noop, onCancel: noop })) : "";
  is("the rules are in a fieldset with a legend, each rule its own", /<fieldset[^>]*>\s*<legend[^>]*>Rules, checked in order/.test(markup) && /<legend[^>]*>Rule 1<\/legend>/.test(markup), true);
  is("each field has a label", ["If", "Tag word", "Then go to", "Everyone else goes to", "Where it goes"].every((label) => markup.includes(`>${label}</span>`)), true);
  is("the tag word field explains itself in place", /aria-describedby="[^"]*value-0-hint"/.test(markup) && markup.includes("utm_campaign=spring-sale"), true);
  is("the place to put it can be chosen without dragging", markup.includes("After step 1"), true);
  is("it says what a conditional path is, and that nothing is kept", markup.includes(BRANCH_EXPLAIN) && /Nothing about the visitor is kept/.test(BRANCH_EXPLAIN), true);
  is("a review of where visitors go comes before the button", markup.indexOf("Visitors who reach this step go to") > 0 && markup.indexOf("Everyone else: Page p4") < markup.indexOf("Use this conditional path"), true);
  is("buttons are full size, not small", (markup.match(/class="btn[^"]*"/g) ?? []).length >= 3 && !/class="btn[^"]*btn-sm/.test(markup), true);
  const wrong = tagged ? renderToStaticMarkup(createElement(FunnelBranchEditor, { draft: { ...tagged, rules: [{ ...tagged.rules[0], value: "" }] }, steps, choices, onChange: noop, onApply: noop, onCancel: noop })) : "";
  is("an error is said in words next to its field, tied to it", /aria-invalid="true"[^>]*aria-describedby="[^"]*value-0-error/.test(wrong) && wrong.includes(`Error: ${BRANCH_WORDS.value}`), true);
  is("and the button that would use a wrong path is turned off", /<button[^>]*disabled=""[^>]*>Use this conditional path/.test(wrong), true);

  part("The funnel editor uses it");
  const editor = readFileSync("components/page-funnel-editor.tsx", "utf8");
  is("there is a button to add a conditional path", /Add a conditional path/.test(editor), true);
  is("a saved path has a button to edit it", /Edit conditional path/.test(editor), true);
  is("the funnel cannot be saved while a path is half edited", /disabled=\{locked \|\| splitDraft !== null \|\| branchDraft !== null/.test(editor), true);
  is("the editor explains the refusal in plain words", /\n\s*branch: "[^"]{20,}",/.test(editor), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
