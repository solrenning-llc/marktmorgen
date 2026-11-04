/**
 * The store pages' email fields offer "Did you mean …?" (308 [TC1], unit 2;
 * components/email-field.tsx). Checked:
 *
 *   - every email field a buyer types into on a store's plain forms is an
 *     EmailField, in the store's language, with its name, id and look kept;
 *   - the field still posts what is in it, under the same name;
 *   - the first send of a likely slip waits once, and only once;
 *   - the line is in the store's own look.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailField } from "@/components/email-field";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

/** Each store form, and the fields (by name) it must ask through EmailField. */
const FIELDS: [string, string[]][] = [
  ["app/[handle]/orders/page.tsx", ["email"]],
  ["app/[handle]/manage/page.tsx", ["email"]],
  ["app/[handle]/affiliates/page.tsx", ["email", "paypal"]],
  ["app/[handle]/left/page.tsx", ["email", "email"]],
  ["app/[handle]/course/[product]/page.tsx", ["email"]],
  ["app/[handle]/podcast/[product]/page.tsx", ["email"]],
  ["app/[handle]/group/[group]/page.tsx", ["email"]],
  ["components/community-parts.tsx", ["email"]],
  ["components/store-join-box.tsx", ["email"]],
  ["components/store-contact-box.tsx", ["email"]],
  ["components/store-product.tsx", ["gift_to", "email", "email", "email"]],
  ["components/assistant-reminder-box.tsx", ["remind_email"]],
];

function main(): void {
  part("Every store form's email field");
  for (const [file, names] of FIELDS) {
    const text = read(file);
    const found = [...text.matchAll(/<EmailField\b[^>]*?\bname="([a-z_]+)"[^>]*?\/>/g)].map((m) => m[1]);
    is(`${file}: ${names.join(", ")}`, found.sort(), [...names].sort());
    is(`${file}: no plain email input left`, /<input[^>]*type="email"/.test(text), false);
    is(`${file}: in the store's language`, [...text.matchAll(/<EmailField\b[^>]*?\/>/g)].every((m) => /language=\{(store\.language|lang)\}/.test(m[0])), true);
  }

  part("What it draws");
  const html = renderToStaticMarkup(createElement(EmailField, { id: "orders-email", name: "email", className: "st-field", required: true, placeholder: "you@example.com", language: "fr" }));
  is("an email input with the same id, name and look, left to the browser (what is typed before the scripts load is kept)", /<input id="orders-email" type="email" required="" maxLength="254" autoComplete="email" placeholder="you@example.com" class="st-field" name="email" value=""\/>/.test(html) && !/value=\{value\}/.test(/<input[\s\S]*?\/>/.exec(read("components/email-field.tsx"))?.[0] ?? "value={value}") && read("components/email-field.tsx").includes("defaultValue={defaultValue}"), true);
  is("no description while there is nothing to suggest (the line joins it only while it says something)", read("components/email-field.tsx").includes('aria-describedby={[describedBy ?? "", left && suggestEmail(value) !== null ? line : ""].filter(Boolean).join(" ") || undefined}'), true);
  is("then its line, an empty polite region", html.includes('<div id="orders-email-suggestion" aria-live="polite" data-email-suggestion="true"></div>'), true);
  const kept = renderToStaticMarkup(createElement(EmailField, { name: "paypal", className: "st-field", defaultValue: "pay@example.com" }));
  is("a field with a saved address starts with it", kept.includes('value="pay@example.com"'), true);
  const field = read("components/email-field.tsx");
  is("the first send of a likely slip waits once, before any other listener", /if \(!holdForSuggestion\(typed, shown\.current\)\) return;\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*shown\.current = typed;/.test(field) && field.includes('window.addEventListener("submit", onSubmit, true)'), true);
  is("a hidden field holds nothing back", field.includes("if (own.getClientRects().length === 0) return;"), true);
  is("what was typed before the scripts loaded is read once they do", field.includes("setValue(own.value);"), true);
  is("no email field sits inside a label that wraps it (its name would take the line in)", FIELDS.every(([file]) => !/<label[^>]*>\s*<span[^>]*>[^<]*<\/span>\s*<EmailField/.test(read(file))), true);
  is("the embed's fixed-height frame keeps a plain field", /<input id="embed-join-email" type="email"/.test(read("app/embed/[handle]/join/page.tsx")), true);
  is("a button beside a field is not stretched by the line", ["app/[handle]/course/[product]/page.tsx", "components/community-parts.tsx", "components/store-join-box.tsx"].every((file) => read(file).includes("sm:flex-row sm:items-start")), true);
  is("and a send the browser stops for a bad shape shows the line too", field.includes("onInvalid={() => setLeft(true)}"), true);
  is("the line in the store's own look", /store \? "st-note mt-2 text-sm/.test(read("components/email-suggestion.tsx")) && /store \? "st-btn-ghost"/.test(read("components/email-suggestion.tsx")), true);
}

main();
done();
