/**
 * "Bring in a sequence" in the studio (544 [SQ9], unit 2; the mail route's
 * "flow-import", components/sequence-import-box.tsx and the sequence editor
 * in components/email-studio.tsx; added 2 November 2026). Checked:
 *
 *   - the template the studio offers reads back, through the same reader, as
 *     its two example emails, only its preview text reported;
 *   - the box has a labeled file field with its help tied to it, takes CSV
 *     files only, offers the template for download, and says nothing is sent;
 *   - the mail route only reads the file (never saves, sends or switches
 *     anything on) and needs what saving a sequence needs;
 *   - what is read opens in the sequence editor as a new sequence, with each
 *     email's wait in days when it is whole days, unsaved, so leaving the
 *     page asks first; a new sequence is saved paused.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSequenceCsv } from "@/lib/sequence-import";
import { SEQUENCE_TEMPLATE, sequenceTemplateCsv } from "@/lib/sequence-template";
import { SequenceImportBox, reportWords } from "@/components/sequence-import-box";
import { done, is, part } from "./check";

part("The template reads back");
const template = readSequenceCsv(sequenceTemplateCsv());
is(
  "its two example emails and their waits; only its preview text is reported, as not kept yet",
  template.ok ? [template.steps.map((s) => [s.delayHours, s.subject]), template.report] : template,
  [[[0, "Welcome! Here is your guide"], [72, "A tip for your first week"]], [{ line: 2, column: "preview", reason: "Preview text is not kept yet: a sequence's email has no place for it." }]],
);
is("its header is the template's columns", sequenceTemplateCsv().split("\n")[0], SEQUENCE_TEMPLATE.map((c) => `"${c}"`).join(","));

part("The box");
const html = renderToStaticMarkup(createElement(SequenceImportBox, { disabled: false, onRead: () => {}, describe: () => null }));
const id = /<label for="([^"]+)"/.exec(html)?.[1] ?? "";
is(
  "a labeled file field for CSV files, its help tied to it",
  [Boolean(id), html.includes(`id="${id}"`) && html.includes('type="file"'), html.includes('accept=".csv,text/csv"'), /aria-describedby="[^"]+-help"/.test(html)],
  [true, true, true, true],
);
is("the template offered for download as a CSV file", [html.includes('download="sequence-template.csv"'), html.includes('href="data:text/csv;charset=utf-8,')], [true, true]);
is("it says nothing is sent, and what is taken out", [html.includes("Nothing is sent."), html.includes("merge fields are taken out and listed")], [true, true]);
is("the button waits for a file", /<button[^>]*disabled=""[^>]*>Read the file<\/button>/.test(html), true);
is("its report's place is always there, so what is put in it is announced", html.includes('role="status" aria-live="polite"'), true);
is("a report line reads as words", [reportWords({ line: 4, column: "body", reason: "The body is empty." }), reportWords({ line: 0, column: "file", reason: "Only the first 100 rows were read." })], ["Line 4, body: The body is empty.", "The file: Only the first 100 rows were read."]);
const box = readFileSync("components/sequence-import-box.tsx", "utf8");
is(
  "a refusal is said in the studio's words, never \"try again\" for signing in or a plan; the same file can be picked again",
  [box.includes('describe(data?.error ?? "") ?? FAILED'), box.includes('if (input.current) input.current.value = "";')],
  [true, true],
);

part("The route only reads");
const route = readFileSync("app/api/store/mail/route.ts", "utf8");
const action = route.slice(route.indexOf('if (action === "flow-import") {'), route.indexOf('if (action === "flow-activate") {'));
is("it needs what saving a sequence needs", route.includes('"flow-import": "send",'), true);
is("it reads the file and answers; nothing saved, sent or switched on", [action.includes("readSequenceCsv(csv)"), /saveFlow|setFlowActive|sendEmail|writeFlows/.test(action)], [true, false]);

part("The editor");
const studio = readFileSync("components/email-studio.tsx", "utf8");
const opened = studio.slice(studio.indexOf("function openImported("), studio.indexOf("function openDraft("));
is(
  "what is read opens as a new sequence, waits in days when whole, unsaved so leaving asks first",
  [opened.includes("...toDraft(null, products),"), opened.includes('s.delayHours % 24 === 0 ? "days" : "hours"'), opened.includes("setDraftBaseline(null);"), studio.includes("<SequenceImportBox disabled={locked} onRead={openImported} describe={(code) => MESSAGES[code] ?? null} />")],
  [true, true, true, true],
);
is("a new sequence is saved paused, whatever is sent", studio.includes("active: draft.id ? draft.active : false,"), true);
is(
  "the report stays in the editor until it is saved or closed, and its heading takes the focus",
  [opened.includes("setImported(report);"), studio.includes("<h3 ref={importedHeading} tabIndex={-1}"), studio.includes("if (imported) importedHeading.current?.focus();"), (studio.match(/setImported\(null\);/g) ?? []).length],
  [true, true, true, 2],
);
is("the studio's words are passed for a refusal", studio.includes("describe={(code) => MESSAGES[code] ?? null}"), true);

done();
