/**
 * A first product made inside Marktmorgen, unit 1 (490 [PP1],
 * lib/first-product.ts; added 1 November 2026, corrected the same day after
 * an independent review). Checked:
 *
 *   - four formats, each asking at most five questions, every one by buttons;
 *     where there is no AI draft (Store), only the questions that change the
 *     outline are asked;
 *   - every answer asked changes the outline, and the outline keeps the
 *     answers it was made from;
 *   - the outline follows the answers (as many parts as the button says; a
 *     checklist's groups add up and none is empty), and an answer the creator
 *     did not see marked is never used;
 *   - the outline holds only structure and the creator's own words: no
 *     number but its own counters, no figure, study, testimonial or promised
 *     result;
 *   - the price: the field starts empty; three starting points in US dollars
 *     only, none marked, under words that say where they come from.
 */
import { FIRST_FORMATS, FIRST_MAX_QUESTIONS, FORMAT_INFO, PRICE_WORDS, answered, defaultAnswers, outlineFor, placeholderTitle, questionsFor, startingPoints, type FirstFormat } from "@/lib/first-product";
import { done, is, part } from "./check";

/** Words a draft must never carry unless the creator wrote them. */
const PROMISE = /(guarantee|proven|proof|promise|study|studies|research|percent|%|testimonial|results?\b|earn|income|money|profit|double|triple|million|thousand|secret|best|fastest|\$\s?\d|\bsix[- ]figure)/i;
/** Numbers, once the outline's own counters ("Step 3", "Item 12") are taken out. */
const numberIn = (text: string) => /\d/.test(text.replace(/\b(Step|Item|Exercise|Section) \d+\b/g, ""));

function main(): void {
  part("The formats and their questions");
  is("four formats", [...FIRST_FORMATS], ["guide", "checklist", "workbook", "template"]);
  for (const format of FIRST_FORMATS) {
    const info = FORMAT_INFO[format];
    is(`${format}: at most ${FIRST_MAX_QUESTIONS} questions, each with two to four buttons`, info.questions.length <= FIRST_MAX_QUESTIONS && info.questions.every((q) => q.choices.length >= 2 && q.choices.length <= 4), true);
    is(`${format}: no question asked twice, no button twice`, new Set(info.questions.map((q) => q.id)).size === info.questions.length && info.questions.every((q) => new Set(q.choices.map((c) => c.id)).size === q.choices.length), true);
    is(`${format}: one free field, with a label and an example`, [info.know.endsWith("?"), info.example.length > 20, info.what.length > 20], [true, true, true]);
    is(`${format}: without AI, only what changes the outline is asked, the length always`, questionsFor(format, false).every((q) => !q.forAi) && questionsFor(format, false).some((q) => q.id === "length"), true);
    is(`${format}: with AI, everything`, questionsFor(format, true).length, info.questions.length);
    is(`${format}: the screen starts from the marked first buttons`, answered(format, {}), defaultAnswers(format));
  }

  part("Every answer asked without AI changes the outline");
  for (const format of FIRST_FORMATS) {
    for (const question of questionsFor(format, false)) {
      const drawn = new Set(question.choices.map((choice) => JSON.stringify(outlineFor(format, { [question.id]: choice.id }).parts.concat())));
      const groups = new Set(question.choices.map((choice) => JSON.stringify(outlineFor(format, { [question.id]: choice.id }).groups)));
      is(`${format}, ${question.id}: each button makes a different outline`, Math.max(drawn.size, groups.size), question.choices.length);
    }
  }
  is("the outline keeps its answers", outlineFor("workbook", { answers: "boxes", length: "long" }).answers, { reader: "new", length: "long", tone: "friendly", answers: "boxes" });

  part("The outline follows the answers");
  is("a medium guide: who it is for, five steps, a summary", outlineFor("guide", { length: "medium", ending: "summary" }).parts.map((p) => p.heading), ["Who this is for", "Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Summary"]);
  is("a long guide with no ending page: eight steps", outlineFor("guide", { length: "long", ending: "none" }).parts.length, 9);
  for (const groups of ["stages", "topics"]) {
    for (const length of ["short", "medium", "long"]) {
      const outline = outlineFor("checklist", { length, groups });
      const sizes = outline.groups.map((_, g) => outline.parts.filter((p) => p.group === g).length);
      const total = Number(/\d+/.exec(FORMAT_INFO.checklist.questions.find((q) => q.id === "length")!.choices.find((c) => c.id === length)!.label)?.[0]);
      is(`checklist, ${groups}, ${length}: three named groups, adding up to ${total}, none empty, as even as can be`, [outline.groups.length, sizes.reduce((a, b) => a + b, 0), Math.min(...sizes) > 0, Math.max(...sizes) - Math.min(...sizes) <= 1], [3, total, true, true]);
    }
  }
  is("the stages are named; the topics are named for the creator to rename", [outlineFor("checklist", { groups: "stages" }).groups, outlineFor("checklist", { groups: "topics" }).groups], [["Before", "During", "After"], ["Topic one", "Topic two", "Topic three"]]);
  is("one list: no groups, items numbered through", (() => {
    const outline = outlineFor("checklist", { length: "short", groups: "one" });
    return [outline.groups, outline.parts.every((p) => p.group === undefined), outline.parts.at(-1)?.heading];
  })(), [[], true, "Item 10"]);
  is("a workbook's room for answers is in what each exercise asks", ["lines", "boxes", "both"].map((answers) => outlineFor("workbook", { answers }).parts[1].ask), [
    "The question or task, then lines for the reader's answer.",
    "The question or task, then boxes for the reader to fill in.",
    "The question or task, then lines and boxes for the reader's answer.",
  ]);
  for (const format of FIRST_FORMATS) {
    const lengths = FORMAT_INFO[format].questions.find((q) => q.id === "length")!.choices;
    for (const choice of lengths) {
      const shown = Number(/\d+/.exec(choice.label)?.[0]);
      const kind = format === "guide" ? "text" : format === "checklist" ? "item" : format === "workbook" ? "exercise" : "field";
      const made = outlineFor(format, { length: choice.id }).parts.filter((p) => p.kind === kind && (format !== "guide" || p.heading.startsWith("Step"))).length;
      is(`${format}, ${choice.id}: as many parts as the button says (${shown})`, made, shown);
    }
  }
  is("an answer not among the buttons is not used: the marked first button is", answered("guide", { length: "huge", tone: "<script>" }), defaultAnswers("guide"));

  part("Only structure and the creator's own words");
  is("the creator's title is kept, trimmed", outlineFor("guide", {}, "  Sunday dinners in two hours  ").title, "Sunday dinners in two hours");
  is("a long title is cut by letters, never inside an emoji", Array.from(outlineFor("guide", {}, `${"a".repeat(119)}🍲🍲`).title), [...Array.from("a".repeat(119)), "🍲"]);
  is("without one, a placeholder that asks for it", [outlineFor("workbook", {}).title, placeholderTitle("workbook")], ["Your workbook's title", "Your workbook's title"]);
  is("what the creator typed is kept as their notes, as typed", outlineFor("guide", {}, "", "  I cook on Sundays.  ").notes, "I cook on Sundays.");
  for (const format of FIRST_FORMATS as readonly FirstFormat[]) {
    for (const length of ["short", "medium", "long"]) {
      for (const extra of [{}, { groups: "stages" }, { answers: "both" }, { use: "type" }, { ending: "next" }]) {
        const outline = outlineFor(format, { length, ...extra });
        const text = [outline.title, ...outline.groups, ...outline.parts.map((p) => `${p.heading} ${p.ask}`)].join(" ");
        is(`${format}, ${length}, ${JSON.stringify(extra)}: no number, figure, study, testimonial or promised result`, [numberIn(text), PROMISE.test(text)], [false, false]);
      }
    }
    const info = FORMAT_INFO[format];
    const own = [info.name, info.what, info.know, ...info.questions.flatMap((q) => [q.ask, ...q.choices.map((c) => c.label.replace(/^(Short|Medium|Long): \d+ /, ""))])].join(" ");
    is(`${format}: its own words carry none either`, [numberIn(own), PROMISE.test(own)], [false, false]);
    is(`${format}: its example promises nothing and has no figure`, [numberIn(info.example), PROMISE.test(info.example)], [false, false]);
  }

  part("The price");
  is("three starting points in US dollars, inside $4 to $35, rising", startingPoints("usd"), [900, 1900, 2900]);
  is("none in any other currency: no conversion is made up", ["eur", "mxn", "jpy", "gbp"].map(startingPoints), [[], [], [], []]);
  is("the words say where they come from, and that the creator chooses", [PRICE_WORDS.range, PRICE_WORDS.points], ["Suggested range: $4 to $35. You choose.", "Starting points from Marktmorgen, not what other sellers charge"]);
  is("and claim nothing about other sellers", /typical|most creators|market|average/i.test(Object.values(PRICE_WORDS).join(" ")), false);
}

main();
done();
