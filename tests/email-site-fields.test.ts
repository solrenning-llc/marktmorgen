/**
 * "Did you mean …?" on the site's and the studio's email fields (308 [TC1],
 * unit 3; components/email-input.tsx, with components/email-field.tsx for
 * plain forms). Checked:
 *
 *   - every email field named in the unit asks through EmailInput (kept in
 *     the form's own state) or EmailField (posted by the browser), with no
 *     plain email input left in those files, and with its id kept;
 *   - none sits inside a label that wraps it, so the line never becomes
 *     part of the field's name; the two-step hint stays tied to its field;
 *   - the store's chat and assistant say the line in the store's language
 *     and look; the studio and site in English, in the site's look;
 *   - EmailInput draws the parent's value, no description while there is
 *     nothing to suggest, an empty polite region, and holds the first send
 *     of a likely slip once, before the form's own handler;
 *   - the research form keeps its own 200-character cap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailInput } from "@/components/email-input";
import { EmailField } from "@/components/email-field";
import { LIMITS } from "@/lib/creator-research";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

/** Each file, the component its email field uses, and the field's id. */
const FIELDS: [string, "EmailInput" | "EmailField", string][] = [
  ["components/team-manager.tsx", "EmailInput", "invite-email"],
  ["components/recovery-address-manager.tsx", "EmailInput", "account-recovery-email"],
  ["components/two-step-manager.tsx", "EmailInput", "two-step-backup"],
  ["components/affiliate-studio.tsx", "EmailInput", "partner-email"],
  ["components/store-chat.tsx", "EmailInput", "store-chat-email"],
  ["components/store-assistant.tsx", "EmailInput", "store-assistant-email"],
  ["components/creator-research-form.tsx", "EmailField", "email"],
  ["app/library/page.tsx", "EmailField", "library-email"],
  ["app/privacy/delete/page.tsx", "EmailField", "erase-email"],
  ["app/affiliate/page.tsx", "EmailField", "hub-email"],
];

function main(): void {
  part("Every field in the unit");
  for (const [file, kind, id] of FIELDS) {
    const text = read(file);
    const uses = [...text.matchAll(new RegExp(`<${kind}\\b[\\s\\S]*?\\/>`, "g"))].map((m) => m[0]);
    is(`${file}: one ${kind}, id ${id}`, [uses.length, uses[0]?.includes(`id="${id}"`)], [1, true]);
    is(`${file}: no plain email input left`, /<input[^>]*type="email"/.test(text), false);
    is(`${file}: its label points at it and does not wrap it`, new RegExp(`htmlFor="${id}"`).test(text) && !new RegExp(`<label(?:(?!</label>)[\\s\\S])*<${kind}\\b`).test(text), true);
    const store = file.includes("store-chat") || file.includes("store-assistant");
    is(`${file}: ${store ? "in the store's language and look" : "in English, in the site's look"}`, store ? /language=\{language\} store \/>/.test(uses[0] ?? "") : !/language=/.test(uses[0] ?? "") && (kind === "EmailInput" || /store=\{false\}/.test(uses[0] ?? "")), true);
  }
  is("the two-step hint is still read with its field", read("components/two-step-manager.tsx").includes('describedBy="two-step-backup-hint"') && read("components/two-step-manager.tsx").includes('id="two-step-backup-hint"'), true);
  is("the controlled fields keep the parent's state", ["setEmail", "setAddress", "setBackup"].every((setter) => FIELDS.some(([file]) => read(file).includes(`onChange={${setter}}`))), true);
  // The lost-email page (app/signin/lost) waits on the open PR that holds it.
  is("the embed keeps its fixed-height plain field", /<input id="embed-join-email" type="email"/.test(read("app/embed/[handle]/join/page.tsx")), true);
  const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everyFile(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
  const sources = [...everyFile("app"), ...everyFile("components")].map((file) => [file, read(file)] as const);
  for (const [file, , id] of FIELDS) {
    if (id === "email") continue;
    const elsewhere = sources.filter(([other, text]) => other !== file && new RegExp(`id="${id}"|htmlFor="${id}"`).test(text)).map(([other]) => other);
    is(`${id}: no other field in the site has this id (its label and "Use …" would reach that one)`, elsewhere, []);
  }

  part("What EmailInput draws");
  const html = renderToStaticMarkup(createElement(EmailInput, { id: "invite-email", value: "dana@gmial.com", onChange: () => {}, className: "field", required: true, autoComplete: "off" }));
  is("an email input showing the parent's value", /<input id="invite-email" type="email" required="" maxLength="254" autoComplete="off" class="field" value="dana@gmial.com"\/>/.test(html), true);
  is("no description before the field is left, even with a likely slip", html.includes("aria-describedby"), false);
  is("its line, an empty polite region until then", html.includes('<div id="invite-email-suggestion" aria-live="polite" data-email-suggestion="true"></div>'), true);
  const described = renderToStaticMarkup(createElement(EmailInput, { id: "two-step-backup", value: "", onChange: () => {}, className: "field", describedBy: "two-step-backup-hint" }));
  is("a hint of its own stays described", described.includes('aria-describedby="two-step-backup-hint"'), true);
  const input = read("components/email-input.tsx");
  is("the line joins the description only while it says something", input.includes('aria-describedby={[describedBy ?? "", left && suggestEmail(value) !== null ? line : ""].filter(Boolean).join(" ") || undefined}'), true);
  is("the first send of a likely slip waits once, before the form's own handler", /if \(!holdForSuggestion\(typed, shown\.current\)\) return;\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*shown\.current = typed;/.test(input) && input.includes('window.addEventListener("submit", onSubmit, true)'), true);
  is("only its own form's send, and never while it is not drawn", input.includes("if (!own?.form || event.target !== own.form) return;") && input.includes("if (own.getClientRects().length === 0) return;"), true);
  is("leaving the field, or the browser refusing its shape, shows the line", input.includes("setLeft(true);\n        }}") && input.includes("onInvalid={() => setLeft(true)}"), true);
  for (const [name, source] of [["EmailInput", input], ["EmailField", read("components/email-field.tsx")]] as const) {
    is(`${name}: pressing the form's send button does not push it down before the click lands`, source.includes('if (to instanceof HTMLButtonElement && to.type === "submit" && to.form === event.currentTarget.form) return;'), true);
    is(`${name}: a line already seen is never held for again`, source.includes("if (left && suggestEmail(value) !== null) shown.current = value;"), true);
  }
  is("\"Use …\" hands the address to the parent, the only change ever made", input.includes("onUse={onChange}"), true);

  part("The research form's cap");
  const research = renderToStaticMarkup(createElement(EmailField, { id: "email", name: "email", className: "field", maxLength: LIMITS.email, store: false }));
  is("kept at what its server keeps", [LIMITS.email, research.includes(`maxLength="${LIMITS.email}"`)], [200, true]);
}

main();
done();
