/**
 * "Did you mean …?" on the studio's buyer lookup (308 [TC1], unit 6; components/email-input.tsx).
 *
 * People → "A buyer's email address" opens that buyer's page. A slip ("dana@gmial.com") finds nobody and still
 * counts against the hour's lookups (FINDS_PER_HOUR in app/api/store/person/route.ts). The field now suggests the
 * fix for a likely slip, and the first send of one waits once, before the form's own handler sends the lookup, as
 * every other email field does. It keeps its required, autoComplete off (the creator's own address is never offered
 * for a buyer's), its example and its value in the form's state; it gains an id with a label that points at it and
 * no longer wraps it, so the line never joins the field's name.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonFind } from "@/components/person-find";
import { done, is, part } from "./check";

const source = readFileSync("components/person-find.tsx", "utf8");

part("The lookup suggests a fix for a likely slip");
const uses = [...source.matchAll(/<EmailInput\b[\s\S]*?\/>/g)].map((m) => m[0]);
is("one EmailInput, id person-find-email", [uses.length, uses[0]?.includes('id="person-find-email"')], [1, true]);
is("no plain email input left", /<input[^>]*type="email"/.test(source), false);
const field = uses[0] ?? "";
is("required, with the creator's own address never offered", /\brequired\b/.test(field) && /autoComplete="off"/.test(field), true);
is("its example and its value in the form's state", field.includes('placeholder="name@example.com"') && /value=\{email\}/.test(field) && /onChange=\{setEmail\}/.test(field), true);
is("in English, in the site's look", !/language=|\bstore\b/.test(field), true);
is("its label points at it and does not wrap it", source.includes('htmlFor="person-find-email"') && !/<label(?:(?!<\/label>)[\s\S])*<EmailInput\b/.test(source), true);

part("What the page draws");
const html = renderToStaticMarkup(createElement(PersonFind, { initial: "dana@gmial.com" }));
is("the field, named by its label", /<label[^>]*for="person-find-email"[^>]*>[\s\S]*A buyer&#x27;s email address[\s\S]*<\/label>/.test(html) && /<input id="person-find-email" type="email" required=""/.test(html), true);
is("the address it was opened with", html.includes('value="dana@gmial.com"'), true);
is("an empty polite region for the line, nothing said before the field is left", html.includes('<div id="person-find-email-suggestion" aria-live="polite" data-email-suggestion="true"></div>'), true);
is("the button that sends it is still the form's own", /<button type="submit"[^>]*>Open their page<\/button>/.test(html), true);

part("No other field shares its id");
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everyFile(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
const elsewhere = [...everyFile("app"), ...everyFile("components")].filter((file) => file !== join("components", "person-find.tsx") && /id="person-find-email"|htmlFor="person-find-email"/.test(readFileSync(file, "utf8")));
is("person-find-email: only in the lookup", elsewhere, []);

done();
