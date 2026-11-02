/**
 * The right keyboard and autofill on every email field (487 [IT4], item 2;
 * added 1 November 2026; docs/ease-patterns-audit.md).
 *
 * An email field opens the email keyboard by its type. What it may fill in
 * by itself depends on whose address it is: the person's own address takes
 * autocomplete="email", and someone else's address (a deal's contact, who a
 * store moves to, someone on the list) takes "off", so the browser is not
 * asked to offer the creator's own address there. Every email <input>, and
 * every <EmailField> and <EmailInput> (whose own default is "email"), says
 * which it is.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is } from "./check";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
};

/** Each tag of these names, whole: braces counted, so an arrow's "=>" inside it never ends it. */
function tags(source: string, name: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = [];
  for (const m of source.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    let depth = 0;
    let i = m.index ?? 0;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ tag: source.slice(m.index, i + 1), line: source.slice(0, m.index).split("\n").length });
  }
  return out;
}

const isEmail = (tag: string) => /\btype=(?:"email"|'email'|\{[^}]*["']email["'][^}]*\})/.test(tag);


const missing: string[] = [];
let inputs = 0;
let components = 0;
let controlled = 0;
for (const file of [...walk("app"), ...walk("components")]) {
  const source = readFileSync(file, "utf8");
  for (const { tag, line } of tags(source, "input")) {
    if (!isEmail(tag)) continue;
    inputs += 1;
    if (/\bautoComplete=/.test(tag)) continue;
    missing.push(`${file}:${line}`);
  }
  if (file !== "components/email-field.tsx") {
    for (const { tag, line } of tags(source, "EmailField")) {
      components += 1;
      if (!/\bautoComplete=/.test(tag)) missing.push(`${file}:${line} (EmailField)`);
    }
  }
  if (file !== "components/email-input.tsx") {
    for (const { tag, line } of tags(source, "EmailInput")) {
      controlled += 1;
      if (!/\bautoComplete=/.test(tag)) missing.push(`${file}:${line} (EmailInput)`);
    }
  }
}
// 308 [TC1], unit 3, moved 10 of the audit's 25 inputs to EmailField (4) and EmailInput (6), and EmailInput has one of its own.
is("the email fields the audit counted: 16 inputs (two with a type chosen in code), 21 EmailFields and 6 EmailInputs", [inputs, components, controlled], [16, 21, 6]);
is("every one says whose address it is (autocomplete)", missing, []);
is("someone else's address is not offered the creator's own", ["components/form-response-deal.tsx", "components/deals-board.tsx", "components/workflow-tools.tsx"].every((f) => /type="email" autoComplete="off"/.test(readFileSync(f, "utf8"))), true);
is("nor is the address a store moves to (\"Move to\")", /type="email"\s+name="email"\s+autoComplete="off"/.test(readFileSync("app/studio/page.tsx", "utf8")), true);
done();
