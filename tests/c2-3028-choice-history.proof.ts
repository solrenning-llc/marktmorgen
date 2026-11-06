/** Independent local formatter controls; opt-in, no PDF or persistence operation. */
import assert from "node:assert/strict";
import { parseForm, type Answers, type FormResponse } from "@/lib/forms";
import { responseTexts } from "@/lib/form-response-pdf";

const WARNING = "One or more saved choices are no longer listed in the current form.";

export function auditChoiceHistory() {
  const failures: { name: string; message: string }[] = [];
  let checks = 0;
  const check = (name: string, run: () => void) => {
    checks++;
    try { run(); } catch (error) { failures.push({ name, message: String(error) }); }
  };
  const form = parseForm({ id: "review0001", name: "Synthetic review", updatedAt: 1, offerList: false,
    fields: [
      { id: "choice", type: "choices", label: "A choice", required: false, options: [
        { id: "opt001", label: "Café", outcome: "" }, { id: "opt002", label: "Other label", outcome: "" },
      ] },
      { id: "second", type: "short", label: "Other question", required: false, options: [] },
    ] });
  assert.ok(form);
  const render = (given: Answers[string] | undefined) => {
    const answers = Object.freeze({ ...(given === undefined ? {} : { choice: given }), second: "Unchanged note" });
    const response: FormResponse = Object.freeze({ id: "c".repeat(32), at: 1_800_000_000, page: "review-page", answers, outcome: "", joined: true });
    const before = JSON.stringify(response);
    const texts = responseTexts({ form, response, storeName: "Synthetic shop", sentLine: "Synthetic submission", lang: "en" });
    assert.equal(JSON.stringify(response), before, "formatting must never rewrite recorded evidence");
    assert.deepEqual(texts.slice(-4), [
      { role: "H2", text: "Other question" }, { role: "P", text: "Unchanged note" },
      { role: "H2", text: "Asked to hear from you by email" }, { role: "P", text: "Yes" },
    ]);
    assert.equal(texts[2].role, "H2");
    assert.equal(texts[3].role, "P");
    return texts[3].text;
  };
  for (const [name, value, expected] of [
    ["unknown first preserves subsequent known labels", ["gone01", "opt001", "opt002"], `Café; Other label\n${WARNING}`],
    ["unknown last preserves preceding known labels", ["opt002", "opt001", "gone01"], `Other label; Café\n${WARNING}`],
    ["unknown in the middle preserves both current labels", ["opt001", "gone01", "opt002"], `Café; Other label\n${WARNING}`],
    ["several retired selections produce one explanation", ["gone01", "gone02", "gone03"], WARNING],
    ["duplicate retired selections produce one explanation", ["gone01", "gone01"], WARNING],
    ["duplicate known labels retain the prior formatter behavior", ["opt001", "opt001", "gone01"], `Café; Café\n${WARNING}`],
    ["a legacy single string in a multiple-choice field is explained", "gone01", WARNING],
    ["a frozen known-only list remains unchanged", ["opt002", "opt001"], "Other label; Café"],
    ["numeric historical zero remains visible", 0, "0"],
    ["missing answer remains distinct from a retired choice", undefined, "No answer."],
    ["empty answer remains distinct from a retired choice", "", "No answer."],
    ["empty stored list remains genuine absence", [], "No answer."],
  ] as const) {
    check(name, () => {
      const given = typeof value === "object" && value !== null ? Object.freeze([...value]) as unknown as string[] : value;
      const text = render(given);
      assert.equal(text, expected);
      assert.equal(/gone0[123]/.test(text), false, "do not expose retired IDs as recovered labels");
    });
  }
  return { checks, failures, pdfGenerations: 0, applicationCommands: 0 };
}
