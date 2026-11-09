/**
 * Every email field on the site refuses, before sending, what the server's
 * address rule refuses (AX274; WCAG 3.3.1 A, 3.3.7 A). Follows #3328, which
 * gave EmailField the rule (tests/email-field-pattern.test.ts); the review of
 * #3328 found 13 plain `type="email"` inputs and 2 with the type chosen in
 * code still without it, so the browser took "dana@acme" and the server
 * refused it after the send (on a plain form, with what was typed lost).
 *
 * The rule lives once, in lib/email-address-rule.ts (no server code, so a
 * browser bundle may take it), and is lib/auth.ts EMAIL_PATTERN without its
 * anchors. It is the loosest rule any form's server uses, so it never refuses
 * an address a server would keep; a server with a stricter rule
 * (lib/forms.ts, components/signin-form.tsx) still answers in its own words.
 *
 * This test reads every .tsx under app/ and components/ and fails when an
 * email input does not carry the rule and its hint, so a new one cannot come
 * back without it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailInput } from "@/components/email-input";
import { EMAIL_PATTERN } from "@/lib/auth";
import { EMAIL_ADDRESS_RULE, wholeAddress } from "@/lib/email-address-rule";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** Each `<input …>` tag in a file, from `<input` to the `/>` that closes it (JSX braces counted). */
function inputs(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf("<input");
  while (at !== -1) {
    let depth = 0;
    let end = at;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === "/" && text[end + 1] === ">") break;
    }
    out.push(text.slice(at, end + 2));
    at = text.indexOf("<input", end);
  }
  return out;
}

const unescape = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
}

function main(): void {
  part("One rule, the server's");
  is("the rule is lib/auth.ts EMAIL_PATTERN without the anchors the browser adds", `^${EMAIL_ADDRESS_RULE}$`, EMAIL_PATTERN.source);
  const browser = new RegExp(`^(?:${EMAIL_ADDRESS_RULE})$`, "v");
  is("as a browser reads it, it refuses \"dana@acme\" and takes \"dana@acme.com\"", [browser.test("dana@acme"), browser.test("dana@acme.com")], [false, true]);
  is("the module takes no server code", /from "@\/lib\/(auth|redis|stripe)/.test(readFileSync("lib/email-address-rule.ts", "utf8")), false);
  is("EmailField takes the rule and the hints from it, not a copy of its own", [/from "@\/lib\/email-address-rule"/.test(readFileSync("components/email-field.tsx", "utf8")), /SERVER_ADDRESS_RULE\s*=/.test(readFileSync("components/email-field.tsx", "utf8"))], [true, false]);
  const hints = LANGUAGE_CODES.map((code) => wholeAddress(code));
  is("a hint in every store language, each with the example", [new Set(hints).size, hints.every((h) => h.includes("name@example.com"))], [LANGUAGE_CODES.length, true]);
  is("an unknown or missing language is said in English", [wholeAddress(), wholeAddress("xx")], ["Type the whole address, like name@example.com", "Type the whole address, like name@example.com"]);

  part("Every email input on the site carries it");
  const all = [...files("app"), ...files("components")].sort();
  const plain: string[] = [];
  const chosen: string[] = [];
  const missing: string[] = [];
  for (const file of all) {
    if (file === join("components", "email-field.tsx")) continue;
    const text = readFileSync(file, "utf8");
    for (const tag of inputs(text)) {
      const fixed = /\stype="email"/.test(tag);
      const coded = /\stype=\{[^}]*"email"[^}]*\}/.test(tag);
      if (!fixed && !coded) continue;
      (fixed ? plain : chosen).push(file);
      const pattern = fixed ? /\spattern=\{EMAIL_ADDRESS_RULE\}/.test(tag) : /\spattern=\{[^}]*"email" \? EMAIL_ADDRESS_RULE : undefined\}/.test(tag);
      const title = fixed ? /\stitle=\{wholeAddress\(/.test(tag) : /\stitle=\{[^}]*"email" \? wholeAddress\(/.test(tag);
      if (!pattern || !title) missing.push(file);
    }
  }
  is("the 13 plain email inputs the review of #3328 counted, and the 2 whose type is chosen in code", [plain.length, chosen.length], [13, 2]);
  is("none without the server's rule and its hint", missing, []);

  part("As drawn");
  const studio = renderToStaticMarkup(createElement(EmailInput, { value: "", onChange: () => {}, className: "field" }));
  const tag = studio.match(/<input\b[^>]*>/)?.[0] ?? "";
  is("the studio's EmailInput sends the rule and the English hint", [attr(tag, "pattern"), attr(tag, "title")], [EMAIL_ADDRESS_RULE, "Type the whole address, like name@example.com"]);
  const store = renderToStaticMarkup(createElement(EmailInput, { value: "", onChange: () => {}, className: "st-field", language: "de", store: true }));
  is("on a store page, in the store's language", attr(store.match(/<input\b[^>]*>/)?.[0] ?? "", "title"), "Geben Sie die vollständige Adresse ein, etwa name@example.com");

  done();
}

main();
