/**
 * "Did you mean …?" on the studio's "Move to" field (308 [TC1], unit 5; components/email-field.tsx).
 *
 * The account's sign-in address moves only when the link sent to the new address is opened (app/api/store/address),
 * so a slip there sends that link to an inbox the creator does not hold, and the move never happens. The field now
 * suggests the fix for a likely slip and holds the first send once, as every other email field does. It keeps its
 * name, required, autoComplete off (the browser must not offer the address being left) and its example; it gains an
 * id of its own with a label that points at it and no longer wraps it, so the line never joins the field's name.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const studio = readFileSync("app/studio/page.tsx", "utf8");
const form = studio.slice(studio.indexOf('action="/api/store/address"'), studio.indexOf("Send the link there"));

part("The account move suggests a fix for a likely slip");
const fields = [...form.matchAll(/<EmailField\b[\s\S]*?\/>/g)].map((m) => m[0]);
is("the move form has its EmailField", fields.length, 1);
is("no plain email input left in the move form", /<input[^>]*type="email"/.test(form), false);
const field = fields[0] ?? "";
is("it posts the address as email, required", /name="email"/.test(field) && /\brequired\b/.test(field), true);
is("the browser does not offer the address being left", /autoComplete="off"/.test(field), true);
is("its example is kept", field.includes('placeholder="you@somewhere-else.com"'), true);
is("in English, in the site's look", !/language=/.test(field) && /store=\{false\}/.test(field), true);
is("its id, with a label that points at it and does not wrap it", /id="account-move-email"/.test(field) && form.includes('htmlFor="account-move-email"') && !/<label(?:(?!<\/label>)[\s\S])*<EmailField\b/.test(form), true);
is("the label still says where it moves", /<label[^>]*htmlFor="account-move-email"[^>]*>\s*Move to\s*<\/label>/.test(form), true);

part("No other field shares its id");
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everyFile(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []));
const elsewhere = [...everyFile("app"), ...everyFile("components")].filter((file) => file !== join("app", "studio", "page.tsx") && /id="account-move-email"|htmlFor="account-move-email"/.test(readFileSync(file, "utf8")));
is("account-move-email: only on the studio page", elsewhere, []);

done();
