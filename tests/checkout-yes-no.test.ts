/**
 * A yes or no question at checkout (lib/checkout-fields.ts, 387 [TB13] unit 1).
 *
 * Stripe's payment page has no checkbox among its custom fields (only a short
 * answer, a number and a list), so a yes or no question is a list of exactly
 * two choices, "Yes" and "No". What is checked:
 *
 *   - the studio's reading: it needs a label, keeps every limit the other
 *     questions have, takes no choices from the creator (the two are fixed),
 *     and may be required or optional;
 *   - what is stored is read safely, with the same fixed choices whatever was
 *     saved beside it;
 *   - at checkout it is sent as Stripe's list with "Yes" and "No", with
 *     nothing picked for the buyer, in its own place among the questions;
 *   - the answer is read back from the session as "Yes" or "No", and an
 *     optional question left empty adds nothing;
 *   - the words never promise a checkbox, and say that the answer never signs
 *     anyone up for emails.
 */
import { readFileSync } from "node:fs";
import {
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  MAX_FIELD_LABEL_LENGTH,
  YES_NO_CHOICES,
  YES_NO_NOTE,
  applyCheckoutFields,
  parseFields,
  readAnswers,
  readFields,
} from "@/lib/checkout-fields";
import { checkoutQuestionWords } from "@/lib/public-explanations";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("A kind the creator can pick");
  is("listed with the others", (FIELD_TYPES as readonly string[]).includes("yes_no"), true);
  is("named in plain words", (FIELD_TYPE_NAMES as Record<string, string>).yes_no, "Yes or no");
  is("its two choices are fixed", YES_NO_CHOICES, ["Yes", "No"]);
  is("never named a checkbox", /checkbox/i.test((FIELD_TYPE_NAMES as Record<string, string>).yes_no ?? "checkbox"), false);

  part("Read from the studio");
  is(
    "a label and the creator's required-or-optional choice are kept, choices sent with it are ignored",
    readFields([{ label: "  Is this a gift?  ", type: "yes_no", optional: true, options: "Maybe\nLater" }]),
    [{ label: "Is this a gift?", type: "yes_no", optional: true, options: [] }],
  );
  is("required unless the creator says", readFields([{ label: "Is this a gift?", type: "yes_no" }]), [{ label: "Is this a gift?", type: "yes_no", optional: false, options: [] }]);
  is("a label is needed", readFields([{ label: " ", type: "yes_no" }]), { reason: "label", at: 0 });
  is("the label keeps Stripe's limit", readFields([{ label: "x".repeat(MAX_FIELD_LABEL_LENGTH + 1), type: "yes_no" }]), { reason: "label_long", at: 0 });
  is(
    "counts as one of the three questions",
    readFields([{ label: "A", type: "yes_no" }, { label: "B", type: "text" }, { label: "C", type: "numeric" }, { label: "D", type: "yes_no" }]),
    { reason: "too_many" },
  );

  part("Read from storage");
  is(
    "the same fixed choices whatever was saved",
    parseFields([{ label: "Is this a gift?", type: "yes_no", optional: false, options: ["Sure", "Nope", "Maybe"] }]),
    [{ label: "Is this a gift?", type: "yes_no", optional: false, options: [] }],
  );
  is("an unlabeled one is dropped, like any other question", parseFields([{ label: "", type: "yes_no" }]), []);

  part("At checkout, Stripe's two-choice list");
  const body = new URLSearchParams();
  applyCheckoutFields(body, [
    { label: "Size", type: "dropdown", optional: false, options: ["S", "M"] },
    { label: "Is this a gift?", type: "yes_no", optional: true, options: [] },
  ]);
  is("its own place among the questions", body.get("custom_fields[1][key]"), "question2");
  is("the creator's label", body.get("custom_fields[1][label][custom]"), "Is this a gift?");
  is("sent as Stripe's list, the kind Stripe has", body.get("custom_fields[1][type]"), "dropdown");
  is("optional as the creator chose", body.get("custom_fields[1][optional]"), "true");
  is(
    "exactly Yes and No",
    [0, 1, 2].map((j) => [body.get(`custom_fields[1][dropdown][options][${j}][label]`), body.get(`custom_fields[1][dropdown][options][${j}][value]`)]),
    [["Yes", "yes"], ["No", "no"], [null, null]],
  );
  is("nothing is picked for the buyer", [...body.keys()].some((key) => key.includes("default_value")), false);
  is("the list before it keeps its own choices", body.get("custom_fields[0][dropdown][options][1][label]"), "M");
  const required = new URLSearchParams();
  applyCheckoutFields(required, [{ label: "Do you agree to the class rules?", type: "yes_no", optional: false, options: [] }]);
  is("a required one must be answered before paying", required.get("custom_fields[0][optional]"), "false");

  part("Read back with the sale");
  const asked = (value: string | null) => ({
    custom_fields: [
      {
        label: { custom: "Is this a gift?" },
        type: "dropdown",
        dropdown: { value, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
      },
    ],
  });
  is("a no reads as No", readAnswers(asked("no")), [{ label: "Is this a gift?", value: "No" }]);
  is("a yes reads as Yes", readAnswers(asked("yes")), [{ label: "Is this a gift?", value: "Yes" }]);
  is("left empty, nothing is added", readAnswers(asked(null)), []);

  part("Words that match what it does");
  is("the note says what the buyer sees", /Yes and No/.test(YES_NO_NOTE) && /Nothing is picked/i.test(YES_NO_NOTE), true);
  is("the note says it never signs anyone up for emails", /never signs anyone up for (your )?emails/i.test(YES_NO_NOTE), true);
  is("the note promises no checkbox", /checkbox/i.test(YES_NO_NOTE), false);
  const editor = readFileSync("components/checkout-fields-editor.tsx", "utf8");
  is("the studio shows the note under a yes or no question", editor.includes("YES_NO_NOTE") && editor.includes('row.type === "yes_no"'), true);
  const row = checkoutQuestionWords();
  is("the public comparison names it", row.includes("a yes or no choice"), true);
  is("and still says there is no checkbox question", row.endsWith("No checkbox question"), true);
  const help = readFileSync("lib/help-content.ts", "utf8");
  is("the help answer names it", help.includes("a yes or no question"), true);
  const features = readFileSync("lib/feature-pages.ts", "utf8");
  is("the checkout page's card names it", /title: "Questions at checkout", body: "[^"]*a yes or no question/.test(features), true);
  // Pre-review of 387 [TB13] unit 1, LEVE: the list of what the checkout does not do yet, and the mission page's list of
  // what is not built, named every kind of question but this one.
  const limitsLine = features.split("\n").find((l) => l.includes('"Questions are '));
  is("the checkout page's limits name it, and still no checkbox question", [/yes or no/.test(limitsLine ?? ""), /no checkbox question/.test(limitsLine ?? "")], [true, true]);
  const mission = readFileSync("app/mission/page.tsx", "utf8").split("\n").find((l) => l.includes('"Checkbox questions at checkout'));
  is("the mission page's list names it, and still no checkbox", [/yes or no/.test(mission ?? ""), /but not a checkbox/.test(mission ?? "")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
