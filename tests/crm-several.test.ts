/**
 * 639 [GL7](2): a contact field of several choices, kept one per line in the
 * field's own order, ticked on the contact's record one box at a time.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIELD_TYPES, fieldValue, hasChoices, parseFields, severalPicked, severalValue, type CrmField } from "@/lib/crm-rules";
import { flowConfigurationIssues, type FlowReviewContext } from "@/lib/flow-review";
import type { Flow } from "@/lib/flows";
import { PersonFields } from "@/components/person-fields";
import { done, is, part } from "./check";

const field: CrmField = { id: "int001", name: "Interested in", type: "several", options: ["Coaching", "Course", "Templates"] };

part("The kind and its choices");
is("a kind a store can pick", FIELD_TYPES.find((t) => t.type === "several")?.label, "Several of a few choices");
is("it has choices, as one choice does", [hasChoices("several"), hasChoices("choice"), hasChoices("text")], [true, true, false]);
is("kept with at least two choices, like one choice", [parseFields([{ id: "int001", name: "Interested in", type: "several", options: ["Coaching", "Course"] }]).length, parseFields([{ id: "int002", name: "Lonely", type: "several", options: ["Only"] }]).length], [1, 0]);

part("A value");
is("as a list: kept one per line, in the field's order", fieldValue(field, ["Templates", "Coaching"]), "Coaching\nTemplates");
is("as lines of text, the same", fieldValue(field, "Templates\nCoaching"), "Coaching\nTemplates");
is("one choice alone, as a workflow sets it", fieldValue(field, "Course"), "Course");
is("each once", fieldValue(field, ["Course", "Course"]), "Course");
is("none picked clears it", [fieldValue(field, []), fieldValue(field, "")], ["", ""]);
is("one not among the choices: refused, nothing kept", [fieldValue(field, ["Course", "Webinar"]), severalValue(field, 42)], [null, null]);
is("read back as the choices picked", severalPicked("Coaching\nTemplates"), ["Coaching", "Templates"]);

part("A workflow step that sets it");
const flow = { id: "main", name: "Welcome", trigger: "joined", productId: null, active: false, createdAt: 1, steps: [] } as unknown as Flow;
const step = (value: string) => ({ ...flow, steps: [{ id: "step1", delayHours: 0, subject: "Hello", body: "Welcome", action: { do: "field" as const, field: "int001", value } }] } as Flow);
const context: FlowReviewContext = { products: [], courses: [], forms: [], fields: [field], stages: [], flows: [] };
is("one of its choices passes", flowConfigurationIssues(step("Course"), context), []);
is("one that is not is named", flowConfigurationIssues(step("Webinar"), context).some((i) => i.includes("incompatible with contact field “Interested in”")), true);

part("On the contact's record");
const html = renderToStaticMarkup(createElement(PersonFields, { person: "p".repeat(16), fields: [field], initial: { int001: "Coaching\nTemplates" }, generation: 0 }));
is("a group named by the field", /<fieldset[^>]*>\s*<legend[^>]*>Interested in<\/legend>/.test(html), true);
is("one box each, named by its choice", (html.match(/type="checkbox"/g) ?? []).length === 3 && ["Coaching", "Course", "Templates"].every((o) => html.includes(`<span>${o}</span>`)), true);
is("the picked ones checked", (html.match(/checked=""/g) ?? []).length, 2);
is("each box a target of 44 px at least", (html.match(/min-h-11/g) ?? []).length >= 3, true);

part("Where the store's fields are made");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("its choices are typed like one choice's", board.includes("{hasChoices(field.type) ? (") && board.includes("options: hasChoices(f.type) ? optionsText.split"), true);

done();
