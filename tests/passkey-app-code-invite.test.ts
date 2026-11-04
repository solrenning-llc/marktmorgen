/**
 * The studio's invitation to add an app's code beside passkeys (owner,
 * C3-96 item 2, 04/11/2026): only for an account with passkeys and no app,
 * at most once a browser session, from what the studio already reads, in
 * every language a store can speak, and accessible.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_CODE_INVITE_SEEN, AppCodeInvite, claimShowing } from "@/components/app-code-invite";
import {
  APP_CODE_INVITE_HREF,
  APP_CODE_INVITE_WORDS,
  appCodeInviteWords,
  inviteLanguage,
  showAppCodeInvite,
} from "@/lib/app-code-invite-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

part("Who is invited");
is("passkeys and no app: invited", showAppCodeInvite({ passkeys: 1, appOn: false, locked: false }), true);
is("several passkeys and no app: invited", showAppCodeInvite({ passkeys: 3, appOn: false, locked: false }), true);
is("passkeys and the app already on: never invited", showAppCodeInvite({ passkeys: 2, appOn: true, locked: false }), false);
is("the app on and no passkey: never invited", showAppCodeInvite({ passkeys: 0, appOn: true, locked: false }), false);
is("no passkey and no app: never invited", showAppCodeInvite({ passkeys: 0, appOn: false, locked: false }), false);
is("a locked session has its own notice and is not invited", showAppCodeInvite({ passkeys: 1, appOn: false, locked: true }), false);

part("At most once a browser session");
function sessionStore() {
  const kept = new Map<string, string>();
  return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), kept };
}
const session = sessionStore();
is("first page of the session shows it", claimShowing(() => session), true);
is("and remembers it under its own key", session.kept.get(APP_CODE_INVITE_SEEN), "1");
is("a later page of the same session does not", claimShowing(() => session), false);
is("nor a third", claimShowing(() => session), false);
is("a new session shows it again", claimShowing(() => sessionStore()), true);
is("storage that cannot be reached never hides it", claimShowing(() => { throw new Error("SecurityError"); }), true);
is(
  "storage that refuses to keep it never hides it",
  claimShowing(() => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } })),
  true,
);

part("Nothing is drawn on the server, so the server never guesses the session or the language");
is("server markup holds only the focus anchor", renderToStaticMarkup(createElement(AppCodeInvite)), '<div tabindex="-1" class="outline-none"></div>');

part("Every language a store speaks has every word, written by hand");
const keys = ["title", "body", "link", "close"] as const;
is("one entry for each store language, no more", Object.keys(APP_CODE_INVITE_WORDS).sort(), [...LANGUAGE_CODES].sort());
for (const code of LANGUAGE_CODES) {
  const words = appCodeInviteWords(code);
  is(`${code}: every word present`, keys.every((key) => typeof words[key] === "string" && words[key].trim().length > 0), true);
  if (code !== "en") is(`${code}: not the English copied over`, keys.filter((key) => words[key] === APP_CODE_INVITE_WORDS.en[key]), []);
  is(`${code}: the reason names the email being taken over and the app`, /e-?mail|correo|Postfach/i.test(words.body) && /app|autenticador|application/i.test(words.body), true);
  is(`${code}: no urgency or fear words`, /\b(now|urgent|hurry|immediately|danger|hacked|ahora|maintenant|jetzt|subito|nu meteen|agora)\b|!/i.test(`${words.title} ${words.body} ${words.link}`), false);
}
is("English link says its purpose", APP_CODE_INVITE_WORDS.en.link, "Add an app code");
is("no generic link text in any language", LANGUAGE_CODES.filter((code) => /\b(?:click|here|ici|hier|qui|hiervoor)\b|aquí|clique|klik/i.test(APP_CODE_INVITE_WORDS[code].link)), []);

part("Language of the browser, or English");
is("pt-BR is Portuguese", inviteLanguage(["pt-BR", "en-US"]), "pt");
is("the first language a store speaks wins", inviteLanguage(["ja-JP", "de-AT", "fr"]), "de");
is("upper case tags are read", inviteLanguage(["NL"]), "nl");
is("none of them: English", inviteLanguage(["ja", "zh-CN"]), "en");
is("nothing at all: English", inviteLanguage(undefined), "en");
is("empty list: English", inviteLanguage([]), "en");

part("The studio draws it from what it already reads, and links to the app's own section");
const page = read("app/studio/page.tsx");
is(
  "rendered only under the rule, from the passkeys and two-step status already loaded",
  page.includes("{store && showAppCodeInvite({ passkeys: passkeys.length, appOn: twoStep.on, locked: lockedTill > 0 }) ? <AppCodeInvite /> : null}"),
  true,
);
is("drawn nowhere else on the page", page.split("<AppCodeInvite").length - 1, 1);
const component = read("components/app-code-invite.tsx");
const words = read("lib/app-code-invite-words.ts");
is("no server read or fetch of its own", /fetch\(|redis|@\/lib\/(?:passkeys|two-step|second-step-gate)/i.test(component + words), false);
is("the link goes to Two-step login", APP_CODE_INVITE_HREF, "#two-step");
is("Two-step login has that anchor", read("components/two-step-manager.tsx").includes('<section id="two-step"'), true);
is("the once-a-session mark is kept in sessionStorage", component.includes("claimShowing(() => window.sessionStorage)"), true);

part("Accessibility");
is("a region named by its heading", component.includes('aria-labelledby="app-code-invite-title"') && component.includes('id="app-code-invite-title"'), true);
is("its language is marked (3.1.2)", component.includes("lang={language}"), true);
is("never live, never takes the focus", /role="(?:status|alert)"|aria-live|autoFocus|\.focus\(\);\s*\}, \[/.test(component), false);
is("close button has an accessible name", component.includes("aria-label={words.close}"), true);
is("close button is at least 44 by 44 px", component.includes("h-11 w-11"), true);
is("the link is at least 44 px high", component.includes("min-h-11"), true);
is("closing puts the focus where the note was", component.includes("after.current?.focus()"), true);
is("information is in words, not color", component.includes("text-ink") && !/text-(?:danger|warn|success)/.test(component), true);
done();
