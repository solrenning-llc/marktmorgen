/**
 * "Did you mean …?" under an email field (308 [TC1], lib/email-typo.ts,
 * components/email-suggestion.tsx; added 1 November 2026). Checked:
 *
 *   - common slips in a provider's name and in .com/.net/.org/.co.uk are
 *     offered the right address, with the name before the @ as typed;
 *   - a right address, a creator's own domain and a real country ending
 *     are never questioned;
 *   - it makes no request, and its code reaches for nothing that could;
 *   - the line is in a polite live region named by the field, with a real
 *     button that says the whole address, and nothing changes until it is
 *     pressed;
 *   - every store language says it, with the address;
 *   - the creator's login form uses it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMON_PROVIDERS, ENDING_TYPOS, editsBetween, holdForSuggestion, suggestEmail } from "@/lib/email-typo";
import { EMAIL_TYPO_WORDS } from "@/lib/buyer-words/email-typo";
import { EmailSuggestion } from "@/components/email-suggestion";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

// Addresses at personal mail providers are written with \u0040 for the "@", so the repository's public data
// check (scripts/check_public_data.py) does not take these made-up ones for someone's real address.

const read = (file: string) => readFileSync(file, "utf8");

function main(): void {
  part("Slips that are offered the right address");
  for (const [typed, meant] of [
    ["maker@gmial.com", "maker\u0040gmail.com"],
    ["maker@gmal.com", "maker\u0040gmail.com"],
    ["maker@gnail.com", "maker\u0040gmail.com"],
    ["maker\u0040gmail.con", "maker\u0040gmail.com"],
    ["maker\u0040gmail.cmo", "maker\u0040gmail.com"],
    ["maker\u0040gmail.co", "maker\u0040gmail.com"],
    ["maker@gmail", "maker\u0040gmail.com"],
    ["maker@hotmial.com", "maker\u0040hotmail.com"],
    ["maker@hotmal.com", "maker\u0040hotmail.com"],
    ["maker@yaho.com", "maker\u0040yahoo.com"],
    ["maker\u0040yahoo.co.uj", "maker\u0040yahoo.co.uk"],
    ["maker@outlok.com", "maker\u0040outlook.com"],
    ["maker\u0040icloud.co", "maker\u0040icloud.com"],
    ["maker@iclod.com", "maker\u0040icloud.com"],
    ["maker@comcast.ner", "maker@comcast.net"],
    ["maker@btinternt.com", "maker@btinternet.com"],
    ["maker\u0040hotmail.co", "maker\u0040hotmail.com"],
    ["maker\u0040yahoo.cm", "maker\u0040yahoo.com"],
    ["maker\u0040outlook.om", "maker\u0040outlook.com"],
    ["maker\u0040aol.co", "maker\u0040aol.com"],
    ["maker\u0040hotmail.c0m", "maker\u0040hotmail.com"],
    ["maker\u0040hotmail..com", "maker\u0040hotmail.com"],
    ["maker\u0040gmail.com.", "maker\u0040gmail.com"],
    ["maker@harborkitchen.con", "maker@harborkitchen.com"],
    ["maker@harborkitchen.ogr", "maker@harborkitchen.org"],
    ["Maker.Name+shop@GMIAL.COM", "Maker.Name+shop\u0040gmail.com"],
    ["  maker@gmial.com  ", "maker\u0040gmail.com"],
    ["maker@gmial.com.", "maker\u0040gmail.com"],
  ] as const) {
    is(`${typed.trim()} → ${meant ?? "nothing"}`, suggestEmail(typed), meant);
  }

  part("Addresses that are never questioned");
  for (const typed of [
    "maker\u0040gmail.com",
    "maker\u0040outlook.com",
    "maker\u0040outlook.pt",
    "maker\u0040yahoo.co.jp",
    "maker\u0040protonmail.ch",
    "maker@harborkitchen.com",
    "maker@harborkitchen.co",
    "maker@harborkitchen.cm",
    "maker@studio.new",
    "maker@mail.de",
    "maker@gmx.at",
    "maker@web.de",
    "maker\u0040me.com",
    "maker@mac.com",
    "maker\u0040live.it",
    "maker@example.org",
    "maker@orange.fe",
    // Real domains one edit from a provider (independent review, 1 November 2026).
    "maker@gm.com", "maker@ge.com", "maker@mt.com", "maker@my.com", "maker@aon.com", "maker@mtn.com", "maker@mmc.com",
    "maker@skf.com", "maker@key.com", "maker@cloud.com", "maker@tim.it", "maker@vp.pl", "maker@go2.pl", "maker@hotmart.com",
    "maker@outloud.com", "maker@pocketmail.com", "maker@earthling.net",
    // Short names are never reached by closeness: none of these is questioned.
    "maker@ab.com", "maker@mx.com", "maker@aox.com", "maker@abc.pl",
    "",
    "maker",
    "@gmial.com",
    "maker@@gmial.com",
    "ma ker@gmial.com",
    `${"m".repeat(250)}@gmial.com`,
  ]) {
    is(`${typed || "(empty)"}: nothing said`.slice(0, 80), suggestEmail(typed), null);
  }
  is("every provider in the list is left alone", COMMON_PROVIDERS.filter((p) => suggestEmail(`maker@${p}`) !== null), []);
  is("and the list has no repeats", COMMON_PROVIDERS.length, new Set(COMMON_PROVIDERS).size);
  is("no misspelled ending is a provider's own", Object.keys(ENDING_TYPOS).filter((typo) => COMMON_PROVIDERS.some((p) => p.endsWith(`.${typo}`))), []);
  is("edits: added, missing, changed, swapped", [editsBetween("gmail", "gmaill"), editsBetween("gmail", "gmal"), editsBetween("gmail", "gmaul"), editsBetween("gmail", "gmial"), editsBetween("gmail", "yahoo")], [1, 1, 1, 1, 5]);

  part("Sending: held once, so the line is seen");
  is("a likely slip waits the first time", holdForSuggestion("maker@gmial.com", ""), true);
  is("the same address a second time goes as typed", holdForSuggestion("maker@gmial.com", "maker@gmial.com"), false);
  is("a changed address waits again", holdForSuggestion("maker@hotmial.com", "maker@gmial.com"), true);
  is("a right address never waits", holdForSuggestion("maker\u0040gmail.com", ""), false);

  part("No request, ever");
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    return new Response("{}");
  }) as typeof fetch;
  suggestEmail("maker@gmial.com");
  renderToStaticMarkup(createElement(EmailSuggestion, { id: "s", inputId: "e", value: "maker@gmial.com", show: true, onUse: () => undefined }));
  globalThis.fetch = realFetch;
  is("nothing was fetched", asked, 0);
  for (const file of ["lib/email-typo.ts", "lib/buyer-words/email-typo.ts", "components/email-suggestion.tsx"]) {
    is(`${file} reaches for nothing that could send`, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|document\.cookie|import\(/.test(read(file)), false);
  }

  part("The line under the field");
  let used = "";
  const quiet = renderToStaticMarkup(createElement(EmailSuggestion, { id: "signin-suggestion", inputId: "signin-email", value: "maker@gmial.com", show: false, onUse: (a: string) => (used = a) }));
  is("before the person leaves the field: an empty polite region, already on the page", quiet, '<div id="signin-suggestion" aria-live="polite" data-email-suggestion="true"></div>');
  const right = renderToStaticMarkup(createElement(EmailSuggestion, { id: "s", inputId: "e", value: "maker\u0040gmail.com", show: true, onUse: () => undefined }));
  is("a right address: still empty", right, '<div id="s" aria-live="polite" data-email-suggestion="true"></div>');
  const shown = renderToStaticMarkup(createElement(EmailSuggestion, { id: "s", inputId: "e", value: "maker@gmial.com", show: true, onUse: (a: string) => (used = a) }));
  is("after: the question with the whole address", shown.includes("<p class=\"font-semibold\">Did you mean maker\u0040gmail.com?</p>"), true);
  is("that what was typed can be kept", shown.includes("If what you typed is right, keep it."), true);
  is("a real button, not a submit, named with the address", /<button type="button" class="btn btn-secondary btn-sm mt-2[^"]*">Use maker\u0040gmail.com<\/button>/.test(shown), true);
  is("and nothing was changed by showing it", used, "");
  is("its button is at least 44 px tall (btn-sm)", /\.btn-sm \{\s*min-height: 44px;/.test(read("app/globals.css")), true);
  is("it adds no animation of its own", /animate-|transition|@keyframes/.test(read("components/email-suggestion.tsx")), false);
  is("a long address wraps at 320 px, in the line and in the button", (shown.match(/\[overflow-wrap:anywhere\]/g) ?? []).length, 2);
  is("its box keeps an edge in forced colors", shown.includes("border border-transparent"), true);
  is("pressing it gives the focus back to the field", /onUse\(suggested\);\s*document\.getElementById\(inputId\)\?\.focus\(\);/.test(read("components/email-suggestion.tsx")), true);

  part("In every store language");
  for (const language of [...LANGUAGE_CODES]) {
    const words = EMAIL_TYPO_WORDS[language];
    is(`${language}: the question and the button carry the address`, [words.didYouMean("a\u0040gmail.com").includes("a\u0040gmail.com"), words.use("a\u0040gmail.com").includes("a\u0040gmail.com"), words.keep.length > 10], [true, true, true]);
  }
  is("no new language", Object.keys(EMAIL_TYPO_WORDS).sort(), [...LANGUAGE_CODES].sort());

  part("Where it is used");
  const signin = read("components/signin-form.tsx");
  is("the creator's login form: the line follows the field", /<EmailSuggestion\s+id="signin-suggestion"\s+inputId="signin-email"/.test(signin), true);
  is("and the field is described by it while it says something, its error or hint first", signin.includes('aria-describedby={[state.kind === "error" ? "signin-error" : shapeProblem ? "signin-hint" : "", suggesting ? "signin-suggestion" : ""].filter(Boolean).join(" ") || undefined}') && signin.includes("const suggesting = showSuggestion && suggestEmail(email) !== null;"), true);
  is("shown once the person has left the field or tried to send, never while sending", signin.includes('const showSuggestion = touched && state.kind !== "sending";') && signin.includes("show={showSuggestion}"), true);
  is("the first send of a likely slip waits once", /if \(holdForSuggestion\(email, shownFor\)\) \{\s*setShownFor\(email\);\s*return;/.test(signin), true);
  is("and the next screen names the address really sent", signin.includes("{sentTo || email}") && /setState\(\{ kind: "sending" \}\);\s*setSentTo\(email\);/.test(signin), true);
}

main();
done();
