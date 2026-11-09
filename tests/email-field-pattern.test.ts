/**
 * The browser refuses an address before sending when the server would
 * (AX274; WCAG 3.3.1 A, 3.3.7 A). Audit R21, root of finding C.
 *
 * `type=email` follows the HTML spec, which takes "dana@acme" (no dot after
 * the at sign); the server's rule (lib/auth.ts EMAIL_PATTERN, used by the
 * store's contact, join, orders and free-product forms) refuses it, and the
 * answer page of a plain form cannot give back what was typed, so a message
 * of up to 2,000 characters was lost. EmailField (components/email-field.tsx)
 * now carries the server's rule as its `pattern`, so the browser stops the
 * send and says why, with the typed words still in the form, script or not.
 * It cannot import lib/auth.ts (a browser bundle must not take the server's
 * code), so this test keeps the two rules equal.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailField } from "@/components/email-field";
import { EMAIL_PATTERN } from "@/lib/auth";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

/** The WHATWG "valid e-mail address" production that input type=email checks. */
const HTML_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const unescape = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function input(html: string): string {
  return html.match(/<input\b[^>]*>/)?.[0] ?? "";
}
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
}

function main(): void {
  part("The field carries the server's rule");
  const store = input(renderToStaticMarkup(createElement(EmailField, { id: "contact-email", name: "email", className: "st-field", required: true, language: "en" })));
  const pattern = attr(store, "pattern");
  is("a store field has a pattern", pattern !== null, true);
  is("it is the server's EMAIL_PATTERN, without the anchors the browser adds", `^${pattern}$`, EMAIL_PATTERN.source);
  const site = input(renderToStaticMarkup(createElement(EmailField, { id: "library-email", name: "email", className: "field", store: false })));
  is("a field on the site's own pages has the same pattern", attr(site, "pattern"), pattern);

  part("As a browser reads it (anchored, with the v flag)");
  let browser: RegExp | null = null;
  try {
    browser = new RegExp(`^(?:${pattern ?? "(?!)"})$`, "v");
  } catch {
    browser = null;
  }
  is("the pattern compiles with the v flag, as browsers compile it", browser !== null, true);
  const samples = ["dana@acme", "dana@acme.com", "dana.lee+shop@mail.example.co.uk", "dana@@acme.com", "dana acme@x.io", "@acme.com", "dana@.com", "dana@acme.", "x@y.z", "dana@acme..com", " dana@acme.com"];
  is("it gives the server's answer for every sample", samples.map((s) => browser?.test(s) ?? null), samples.map((s) => EMAIL_PATTERN.test(s)));
  is("so the address the browser's type=email takes but the server refuses is stopped before it is sent", [HTML_EMAIL.test("dana@acme"), EMAIL_PATTERN.test("dana@acme"), browser?.test("dana@acme") ?? null], [true, false, false]);
  is("and a usual address still goes through", browser?.test("dana@acme.com") ?? null, true);

  part("The browser says why, in the store's language");
  const titles = LANGUAGE_CODES.map((language) => attr(input(renderToStaticMarkup(createElement(EmailField, { name: "email", className: "st-field", language }))), "title"));
  is("the English hint is plain and gives an example", titles[LANGUAGE_CODES.indexOf("en")], "Type the whole address, like name@example.com");
  is("every store language has its own hint, each with the example", [new Set(titles).size, titles.every((t) => t?.includes("name@example.com"))], [LANGUAGE_CODES.length, true]);

  part("Nothing else about the field changes");
  is("still type=email, required, 254 at most, named and labeled as before", [attr(store, "type"), /\srequired=""/.test(store), attr(store, "maxLength"), attr(store, "name"), attr(store, "id")], ["email", true, "254", "email", "contact-email"]);
  is("the component still imports nothing from the server (lib/auth.ts)", /from "@\/lib\/auth"/.test(readFileSync("components/email-field.tsx", "utf8")), false);

  done();
}

main();
