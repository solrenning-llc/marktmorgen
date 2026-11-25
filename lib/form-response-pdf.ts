/**
 * One answer to a form as a PDF a screen reader can read (639 [GL7](26),
 * unit 2; PDF/UA, AX274): for the creator to keep or print an application.
 * The form's name is the heading; each question is a heading of its own with
 * the answer under it, in the order asked; then the result, the score and
 * whether they asked to hear from the creator, as the studio shows them.
 * Tagged through lib/tagged-pdf.ts, over as many pages as it takes.
 *
 * The letters are the certificate's (Noto Sans, lib/certificate-pdf.ts); an
 * answer in a script they do not cover is not drawn as boxes: `canDraw` says
 * no and the studio's list and spreadsheet stay the way to read it.
 */
import { canDraw } from "@/lib/certificate-pdf";
import { taggedSheetPdf } from "@/lib/tagged-pdf-sheet";
import { answerText, isScored, type Answers, type FormDef, type FormField, type FormResponse } from "@/lib/forms";

export { wrap } from "@/lib/tagged-pdf-sheet";

export type ResponseSheet = { form: FormDef; response: FormResponse; storeName: string; sentLine: string; lang: string };

function responseAnswerText(field: FormField, given: Answers[string] | undefined): string {
  const text = answerText(field, given);
  if (field.type === "choice" || field.type === "choices") {
    const saved = Array.isArray(given) ? given : typeof given === "string" && given !== "" ? [given] : [];
    if (saved.some(id => !field.options.some(option => option.id === id))) {
      const warning = "One or more saved choices are no longer listed in the current form.";
      return text ? `${text}\n${warning}` : warning;
    }
  }
  return text || "No answer.";
}

/** The texts the file would draw, in order: what `canDraw` is asked about before anything is made. */
export function responseTexts(sheet: ResponseSheet): { role: "H1" | "H2" | "P"; text: string }[] {
  const { form, response } = sheet;
  const out: { role: "H1" | "H2" | "P"; text: string }[] = [{ role: "H1", text: form.name }, { role: "P", text: sheet.sentLine }];
  for (const field of form.fields) {
    out.push({ role: "H2", text: field.label }, { role: "P", text: responseAnswerText(field, response.answers[field.id]) });
  }
  const outcome = form.outcomes.find((o) => o.id === response.outcome);
  if (outcome) out.push({ role: "H2", text: "Result" }, { role: "P", text: outcome.title });
  if (isScored(form) && typeof response.score === "number") out.push({ role: "H2", text: "Score" }, { role: "P", text: String(response.score) });
  out.push({ role: "H2", text: "Asked to hear from you by email" }, { role: "P", text: response.joined ? "Yes" : "No" });
  return out;
}

/** Whether every letter can be drawn; when not, no file is made. */
export async function responseDrawable(sheet: ResponseSheet): Promise<boolean> {
  return canDraw(...responseTexts(sheet).map((t) => t.text), sheet.storeName);
}

/** The answer as a tagged PDF, US Letter, portrait, as many pages as it takes (lib/tagged-pdf-sheet.ts). */
export async function responsePdf(sheet: ResponseSheet): Promise<Uint8Array> {
  return taggedSheetPdf(responseTexts(sheet), { title: `${sheet.form.name} — ${sheet.sentLine}`, author: sheet.storeName, producer: sheet.storeName, lang: sheet.lang });
}
