/**
 * "Make a copy" of a form (582 [KB3], unit 1; added 10 November 2026): the
 * copy opens in the editor as a new, unsaved form with every question,
 * branch, result and point of the original and none of its answers, id or
 * schedule; it is named "Copy of …" without stacking, within a form name's
 * length, and never twice the same; it is offered only while the store has
 * room for one more form, and says so when it has not; once saved through the
 * same store rules as a new form, it is a form of its own and the original is
 * untouched.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FormsEditor } from "@/components/forms-editor";
import { COPY_PREFIX, canCopy, copyBase, copyName, formCopy } from "@/lib/form-copy";
import { END, MAX_FORM_NAME, MAX_FORMS, newFormId, parseForm, tierIssues, type FormDef } from "@/lib/forms";
import { readForm, writeForm } from "@/lib/form-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const quiz: FormDef = parseForm({
  id: "quizorig01",
  name: "Which course fits you",
  fields: [
    { id: "email0", type: "email", label: "Your email", required: true, options: [] },
    {
      id: "pick00",
      type: "choice",
      label: "Where are you now?",
      required: true,
      options: [
        { id: "opta00", label: "Starting", outcome: "", next: "late00", points: 1, category: "cat000" },
        { id: "optb00", label: "Selling", outcome: "", next: END, points: 5, category: "cat000" },
      ],
    },
    { id: "late00", type: "long", label: "What is in your way?", required: false, options: [] },
  ],
  button: "See my result",
  doneHeading: "",
  doneBody: "",
  outcomes: [
    { id: "out000", title: "Begin here", body: "The first course.", product: "", min: 0, max: 2 },
    { id: "out001", title: "Grow", body: "The second course.", product: "", min: 3, max: 5 },
  ],
  offerList: true,
  scoring: "points",
  categories: [{ id: "cat000", name: "Stage" }],
  updatedAt: 1_800_000_000,
  opensAt: 1_700_000_000,
  closesAt: 1_700_100_000,
})!;

async function main() {
  part("The copy's name");
  is("Copy of the name", copyName("Application", []), "Copy of Application");
  is("a copy of a copy is not Copy of Copy of", [copyName("Copy of Application", []), copyName("copy of  Copy of Application (3)", [])], ["Copy of Application", "Copy of Application"]);
  is("a name already in the store gets the next number, compared without case", [copyName("Application", ["Application", "copy of application"]), copyName("Application", ["Copy of Application", "Copy of Application (2)"])], ["Copy of Application (2)", "Copy of Application (3)"]);
  const long = "A".repeat(MAX_FORM_NAME);
  const longCopy = copyName(long, [`${COPY_PREFIX}${long}`.slice(0, MAX_FORM_NAME)]);
  is("never longer than a form's name may be: the original's name is shortened, never the number", [copyName(long, []).length <= MAX_FORM_NAME, longCopy.length <= MAX_FORM_NAME, longCopy.endsWith(" (2)"), copyName(long, []).startsWith(COPY_PREFIX)], [true, true, true, true]);
  is("an empty name still makes a name the server keeps", [copyName("   ", []), copyBase(" Copy of ")], ["Copy of form", ""]);

  part("What the copy holds");
  const copy = formCopy(quiz, [quiz.name]);
  is("a new form: no id, never changed yet", [copy.id, copy.updatedAt], ["", 0]);
  is("named as a copy", copy.name, "Copy of Which course fits you");
  is("every question, option, branch, point and category the same", [JSON.stringify(copy.fields) === JSON.stringify(quiz.fields), JSON.stringify(copy.categories) === JSON.stringify(quiz.categories), copy.scoring], [true, true, "points"]);
  is("every result, its words and its score range the same", JSON.stringify(copy.outcomes) === JSON.stringify(quiz.outcomes), true);
  is("the button, the after-sending words and the list box the same", [copy.button, copy.doneHeading, copy.doneBody, copy.offerList], [quiz.button, quiz.doneHeading, quiz.doneBody, quiz.offerList]);
  is("not the original's open and close times", ["opensAt" in copy, "closesAt" in copy], [false, false]);
  copy.fields[1].options[0].label = "Changed";
  copy.outcomes[0].title = "Changed";
  is("a deep copy: editing it leaves the original as it was", [quiz.fields[1].options[0].label, quiz.outcomes[0].title, quiz.opensAt], ["Starting", "Begin here", 1_700_000_000]);
  const fresh = formCopy(quiz, []);
  const saved = parseForm({ ...fresh, id: newFormId(), updatedAt: 1 })!;
  is("the server's own reader keeps the copy whole, and its score ranges still pass", [JSON.stringify(saved.fields) === JSON.stringify(quiz.fields), JSON.stringify(saved.outcomes) === JSON.stringify(quiz.outcomes), tierIssues(saved).length], [true, true, 0]);

  part("Saved through the store's own rules");
  redis.clear();
  const sid = "form-copy-test";
  await writeForm(sid, quiz);
  const copyId = newFormId();
  is("the copy is saved as a form of its own", await writeForm(sid, { ...saved, id: copyId }), true);
  is("and the original is untouched, under its own id", [(await readForm(sid, quiz.id))?.name, (await readForm(sid, quiz.id))?.opensAt, (await readForm(sid, copyId))?.name], [quiz.name, quiz.opensAt, "Copy of Which course fits you"]);
  const key = "nl:forms:" + sid;
  for (let n = 2; n < MAX_FORMS; n++) await redis.pipeline([["HSET", key, `filler${String(n).padStart(4, "0")}`, "{}"]]);
  is("at the store's most forms, a copy is refused like any new form", await writeForm(sid, { ...saved, id: newFormId() }), false);

  part("In the studio");
  is("offered only while there is room for one more form", [canCopy(0), canCopy(MAX_FORMS - 1), canCopy(MAX_FORMS)], [true, true, false]);
  const render = (count: number) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: { push() {}, refresh() {}, prefetch() {} } as never },
        createElement(FormsEditor, { saved: Array.from({ length: count }, (_, i) => ({ form: { ...quiz, id: `quiz${String(i).padStart(6, "0")}`, name: `${quiz.name} ${i}` }, total: 0, latest: [] })) as never, products: [], exportBase: "/api/store/forms/export?id=" }),
      ),
    );
  const one = render(1);
  is("each form has its button, named with the form for a screen reader", [one.includes(">Make a copy</button>"), one.includes(`aria-label="Make a copy of ${quiz.name} 0"`)], [true, true]);
  is("and no full-store notice while there is room", one.includes("data-forms-full"), false);
  const full = render(MAX_FORMS);
  is("a full store shows no copy button, never a dead one", full.includes(">Make a copy</button>"), false);
  is("and says why, and what to do", full.includes(`This store has ${MAX_FORMS} forms, the most it can keep. Remove one to make a new form or a copy.`), true);
  const source = readFileSync("components/forms-editor.tsx", "utf8");
  is(
    "the copy opens unsaved in the editor, focus on its name, with a note that names the original",
    [
      source.includes("onClick={() => openNew(formCopy(form, saved.map((s) => s.form.name)), form.name)}"),
      source.includes("setCopiedFrom(from);"),
      source.includes('{copiedFrom !== null && !draft.id ? ('),
      source.includes("none of the answers: those stay with the original"),
      source.includes("requestAnimationFrame(() => nameField.current?.focus());"),
    ],
    [true, true, true, true, true],
  );
  is("editing a saved form or canceling forgets the note", [source.includes("setCopiedFrom(null); setDraft(structuredClone(form));"), source.includes("setDraft(null); setError(null); setCopiedFrom(null);")], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
