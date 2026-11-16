/**
 * "Did you mean …?" on "Contact email (optional)" when a form response becomes an opportunity (308 [TC1], unit 7;
 * components/form-response-deal.tsx, components/email-input.tsx): the address the respondent typed is shown to the
 * creator, who can take the suggested fix before saving the opportunity.
 *
 * It keeps autoComplete off (someone else's address, never the creator's own offered), its value in the draft and
 * the opportunity's own check of the address, and gains an id with a label that points at it instead of wrapping
 * it, so the line never joins the field's name.
 *
 * Left plain, with the reason: the deals board's field is read-only while a deal is locked and marked invalid
 * beside its own error, which EmailInput does not draw; the workflow preview's "Or start from someone on your list"
 * sits inside the sequence editor's form, where EmailInput's one-time hold of a likely slip would hold the
 * sequence's own Save for an address that is never saved.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const FIELDS: [string, string][] = [["components/form-response-deal.tsx", "form-deal-email"]];

part("The contact email suggests a fix for a likely slip");
for (const [file, id] of FIELDS) {
  const text = read(file);
  const uses = [...text.matchAll(/<EmailInput\b[\s\S]*?\/>/g)].map((m) => m[0]);
  is(`${file}: one EmailInput, id ${id}`, [uses.length, uses[0]?.includes(`id="${id}"`)], [1, true]);
  is(`${file}: no plain email input left`, /<input[^>]*type="email"/.test(text), false);
  is(`${file}: someone else's address: autoComplete off`, /autoComplete="off"/.test(uses[0] ?? ""), true);
  is(`${file}: in English, in the site's look`, !/language=|\bstore\b/.test(uses[0] ?? ""), true);
  is(`${file}: its label points at it and does not wrap it`, text.includes(`htmlFor="${id}"`) && !/<label(?:(?!<\/label>)[\s\S])*<EmailInput\b/.test(text), true);
}
const deal = read("components/form-response-deal.tsx");
is("the opportunity keeps the address in its draft", /<EmailInput[^>]*value=\{draft\.email\}[^>]*onChange=\{\(email\) => setDraft\(\{ \.\.\.draft, email \}\)\}/.test(deal), true);
is("the opportunity's own check of the address is kept", deal.includes('setError("Enter a valid contact email or leave it empty.")'), true);
is("the workflow preview's lookup stays plain, inside the sequence editor's form", /<input className="field mt-1" type="email" autoComplete="off" value=\{lookup\}/.test(read("components/workflow-tools.tsx")), true);
is("the deals board's field stays plain, read-only while locked", /<input id=\{dealFieldId\("email"\)\}[^>]*readOnly=\{locked\}[^>]*type="email" autoComplete="off"/.test(read("components/deals-board.tsx")), true);

part("No other field shares its id");
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everyFile(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
const sources = [...everyFile("app"), ...everyFile("components")].map((file) => [file, read(file)] as const);
for (const [file, id] of FIELDS) {
  const elsewhere = sources.filter(([other, text]) => other !== join(...file.split("/")) && new RegExp(`id="${id}"|htmlFor="${id}"`).test(text)).map(([other]) => other);
  is(`${id}: only in ${file}`, elsewhere, []);
}

done();
