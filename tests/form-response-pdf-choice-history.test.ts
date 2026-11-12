/** Actual formatter and one bounded local PDF; no HTTP, provider or historical label invention. */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { parseForm, type Answers, type FieldType, type FormResponse } from "@/lib/forms";
import { responseDrawable, responsePdf, responseTexts, type ResponseSheet } from "@/lib/form-response-pdf";

const WARNING = "One or more saved choices are no longer listed in the current form.";
const options = [
  { id: "opt001", label: "Option A", outcome: "" },
  { id: "opt002", label: "Option B", outcome: "" },
];
const fetchBefore = globalThis.fetch;
let forbiddenFetches = 0;
before(() => {
  globalThis.fetch = (async () => { forbiddenFetches++; throw Error("No HTTP or provider operation is admitted"); }) as typeof fetch;
});
after(() => {
  globalThis.fetch = fetchBefore;
  assert.equal(forbiddenFetches, 0);
});

function sheet(type: FieldType, given: Answers[string] | undefined): ResponseSheet {
  const form = parseForm({
    id: "history001", name: "Choice history", offerList: false, updatedAt: 1,
    fields: [{ id: "choice", type, label: "Saved answer", required: false, options }],
  });
  assert.ok(form, "the real parser accepts the current definition");
  const response: FormResponse = {
    id: "a".repeat(32), at: 1_800_000_000, page: "history-page",
    answers: given === undefined ? {} : { choice: given }, outcome: "", joined: false,
  };
  return { form, response, storeName: "Synthetic shop", sentLine: "Synthetic submission", lang: "en" };
}

function paragraph(value: ResponseSheet): string {
  const texts = responseTexts(value);
  const at = texts.findIndex(item => item.role === "H2" && item.text === "Saved answer");
  assert.notEqual(at, -1);
  assert.equal(texts[at + 1]?.role, "P");
  return texts[at + 1].text;
}

const cases: { name: string; type: FieldType; given: Answers[string] | undefined; expected: string }[] = [
  { name: "one removed saved choice is explained", type: "choice", given: "gone01", expected: WARNING },
  { name: "partly removed choices retain known labels and explain the rest", type: "choices", given: ["opt001", "gone01"], expected: `Option A\n${WARNING}` },
  { name: "all removed choices are explained without invented labels", type: "choices", given: ["gone01", "gone02"], expected: WARNING },
  { name: "a known single choice keeps its current label", type: "choice", given: "opt001", expected: "Option A" },
  { name: "known multiple choices keep their current labels", type: "choices", given: ["opt001", "opt002"], expected: "Option A; Option B" },
  { name: "short text stays unchanged", type: "short", given: "A saved note", expected: "A saved note" },
  { name: "long text and its line break stay unchanged", type: "long", given: "First line\nSecond line", expected: "First line\nSecond line" },
  { name: "an email answer stays unchanged", type: "email", given: "reader@example.com", expected: "reader@example.com" },
  { name: "a stored numeric zero is rendered as zero", type: "scale", given: 0, expected: "0" },
  { name: "a genuinely missing answer retains the absence wording", type: "choice", given: undefined, expected: "No answer." },
  { name: "an empty string retains the absence wording", type: "choice", given: "", expected: "No answer." },
  { name: "an empty choice list retains the absence wording", type: "choices", given: [], expected: "No answer." },
];

for (const item of cases) test(item.name, () => {
  assert.equal(paragraph(sheet(item.type, item.given)), item.expected);
});

test("twelve partial historical answers remain drawable in one bounded local PDF", { timeout: 120_000 }, async t => {
  // Admit one generation and one parse before rendering: fixed source limits, 120 s,
  // at most 2 MiB and 16 pages locally. These are test bounds, not product limits.
  const MAX_LOCAL_PDF_BYTES = 2 * 1024 * 1024;
  const MAX_LOCAL_PAGES = 16;
  const current = Array.from({ length: 8 }, (_, i) => ({ id: `opt00${i}`, label: "W".repeat(79) + i, outcome: "" }));
  const form = parseForm({
    id: "historymax", name: "Choice history at the existing question and option limits", offerList: false, updatedAt: 1,
    fields: Array.from({ length: 12 }, (_, i) => ({
      id: `q${String(i).padStart(5, "0")}`, type: "choices", label: `Question ${i + 1} `.padEnd(160, "W"), required: false,
      options: current.map((option, j) => ({ ...option, id: `o${String(i).padStart(2, "0")}${String(j).padStart(3, "0")}` })),
    })),
  });
  assert.ok(form);
  assert.equal(form.fields.length, 12);
  assert.ok(form.fields.every(field => field.options.length === 8));
  const response: FormResponse = {
    id: "b".repeat(32), at: 1_800_000_000, page: "history-page",
    answers: Object.fromEntries(form.fields.map((field, i) => [field.id, [...field.options.slice(0, 7).map(option => option.id), `r${String(i).padStart(5, "0")}`]])), outcome: "", joined: false,
  };
  const value = { form, response, storeName: "Synthetic shop", sentLine: "Synthetic submission", lang: "en" };
  assert.equal(await responseDrawable(value), true);
  const bytes = await responsePdf(value);
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= MAX_LOCAL_PDF_BYTES);
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPageCount();
  assert.ok(pages >= 1 && pages <= MAX_LOCAL_PAGES);
  assert.ok(pdf.catalog.has(PDFName.of("StructTreeRoot")));
  t.diagnostic(JSON.stringify({ generations: 1, bytes: bytes.byteLength, pages, forbiddenFetches }));
  const paragraphs = responseTexts(value).filter(item => item.role === "P").map(item => item.text);
  assert.equal(paragraphs.filter(text => text.includes(WARNING)).length, 12);
  for (const text of paragraphs.filter(text => text.includes(WARNING))) {
    assert.ok(current.slice(0, 7).every(option => text.includes(option.label)));
    assert.equal(/r\d{5}/.test(text), false);
  }
});
