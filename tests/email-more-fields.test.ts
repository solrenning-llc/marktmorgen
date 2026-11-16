/**
 * "Did you mean …?" on the email fields the earlier units left (308 [TC1], unit 4; components/email-input.tsx for
 * fields kept in the form's own state, components/email-field.tsx for forms the browser posts):
 *
 *   - the lost-email page (app/signin/lost), where a slip means the recovery link goes nowhere;
 *   - the buyer's email when signing a creator's agreement, in the store's language and look;
 *   - the report form (a notice that cannot be answered when its address is wrong), keeping its 300-character cap;
 *   - the buyer's email the creator types for a payment request and for an agreement or proposal, where a slip
 *     sends the request to a stranger or to nobody.
 *
 * Each keeps its id (the "Change" links and the e2e walk reach the field by it), sits outside its label so the line
 * never becomes part of the field's name, and no plain email input is left in the file. The same suggestion and
 * the same one-time hold of the first send as every other field (tests/email-site-fields.test.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

/** Each file, the component its email field uses, the field's id, and whether it is on a store's own page. */
const FIELDS: [string, "EmailInput" | "EmailField", string, boolean][] = [
  ["app/signin/lost/page.tsx", "EmailField", "lost-email", false],
  ["app/[handle]/sign/[agreement]/page.tsx", "EmailField", "sign-email", true],
  ["components/report-form.tsx", "EmailInput", "report-email", false],
  ["components/payment-requests-studio.tsx", "EmailInput", "pr-email", false],
  ["components/agreements-studio.tsx", "EmailInput", "ag-email", false],
];

part("Every field in the unit suggests a fix for a likely slip");
for (const [file, kind, id, store] of FIELDS) {
  const text = read(file);
  const uses = [...text.matchAll(new RegExp(`<${kind}\\b[\\s\\S]*?\\/>`, "g"))].map((m) => m[0]);
  is(`${file}: one ${kind}, id ${id}`, [uses.length, uses[0]?.includes(`id="${id}"`)], [1, true]);
  is(`${file}: no plain email input left`, /<input[^>]*type="email"/.test(text), false);
  is(`${file}: its label points at it and does not wrap it`, new RegExp(`htmlFor="${id}"`).test(text) && !new RegExp(`<label(?:(?!</label>)[\\s\\S])*<${kind}\\b`).test(text), true);
  is(
    `${file}: ${store ? "in the store's language and look" : "in English, in the site's look"}`,
    store ? /language=\{store\.language\}/.test(uses[0] ?? "") && !/store=\{false\}/.test(uses[0] ?? "") : !/language=/.test(uses[0] ?? "") && (kind === "EmailInput" ? !/\bstore\b/.test(uses[0] ?? "") : /store=\{false\}/.test(uses[0] ?? "")),
    true,
  );
  is(`${file}: still required`, /\brequired\b/.test(uses[0] ?? ""), true);
}

part("What each field kept");
const lost = read("app/signin/lost/page.tsx");
is("the lost-email page still posts the address as email", /<EmailField[^>]*name="email"/.test(lost), true);
const sign = read("app/[handle]/sign/[agreement]/page.tsx");
is("the agreement page still posts the address as email, in the store's field look", /<EmailField[^>]*name="email"[^>]*className="st-field mt-1"/.test(sign), true);
const report = read("components/report-form.tsx");
is("the report form keeps its own 300-character cap", /<EmailInput[^>]*maxLength=\{MAX_REPORT_CONTACT\}/.test(report), true);
is("and its value in the form's state", report.includes("onChange={(email) => setFields({ ...fields, email })}"), true);
for (const file of ["components/payment-requests-studio.tsx", "components/agreements-studio.tsx"]) {
  const text = read(file);
  is(`${file}: the creator's browser never offers their own address for the buyer's`, /<EmailInput[^>]*autoComplete="off"/.test(text), true);
  is(`${file}: the value stays in the form's state`, /<EmailInput[^>]*value=\{email\}[^>]*onChange=\{setEmail\}/.test(text), true);
}

part("No other field shares these ids");
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everyFile(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
const sources = [...everyFile("app"), ...everyFile("components")].map((file) => [file, read(file)] as const);
for (const [file, , id] of FIELDS) {
  const elsewhere = sources.filter(([other, text]) => other !== file && new RegExp(`id="${id}"|htmlFor="${id}"`).test(text)).map(([other]) => other);
  is(`${id}: no other field in the site has this id`, elsewhere, []);
}

done();
