/**
 * The questions someone starting out asks about keeping an account safe
 * (534 [FQ1], unit 21, lib/security-faq.ts; added 2 November 2026). Checked:
 * the studio's and the login page's own words, read from their files, in the
 * order the screen gives them; the Account section drawn once the store has
 * its address; no plan read by the routes or the libraries behind them; each
 * condition the screens set said in the answers (a fresh login first, the
 * emailed code only when the address was typed there, the recovery address's
 * button only when there is one, two-step login off); a login that came
 * through the recovery address told why no link is sent; no claim of being
 * safer than anyone; first in the page's own Questions block, no question
 * asked twice.
 */
import { readFileSync } from "node:fs";
import { SECURITY_WORDS, securityBeginnerQuestions } from "@/lib/security-faq";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = SECURITY_WORDS;
const tag = (text: string, end: string) => new RegExp(`>\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</${end}>`);

part("The studio's and the login page's own words");
const studio = read("app/studio/page.tsx");
const passkeys = read("components/passkey-manager.tsx");
const recovery = read("components/recovery-address-manager.tsx");
const twoStep = read("components/two-step-manager.tsx");
const code = read("app/signin/code/page.tsx");
is("the Account section in the jump list, holding all three", [studio.includes(`{ href: "#account", label: "${w.account}" }`), /<PasskeyManager[\s\S]*<RecoveryAddressManager[\s\S]*<TwoStepManager/.test(studio)], [true, true]);
is("drawn once the store has its address, as the studio says otherwise", [studio.indexOf('id="account"') > studio.indexOf("{store ? ("), /\) : \(\s*<div className="card mt-8 p-6 sm:p-8">\s*<p[^>]*>\s*Take your address\s*<\/p>/.test(studio)], [true, true]);
is("each section's heading and button", [tag(w.passkeys, "h3").test(passkeys), passkeys.includes(`"${w.addPasskey}"`), tag(w.remove, "button").test(passkeys), tag(w.recovery, "h3").test(recovery), tag(w.twoStep, "h3").test(twoStep), tag(w.turnOn, "button").test(twoStep), twoStep.includes(`"${w.confirm}"`)], [true, true, true, true, true, true, true]);
is("on screen: log in again before the form, Turn on before Turn it on, the emailed code only when the address is typed there", [twoStep.indexOf("MESSAGES.reauth") < twoStep.indexOf(`${w.turnOn}`), twoStep.indexOf(w.turnOn) < twoStep.indexOf(`"${w.confirm}"`), /recoveryShown \? null : \([\s\S]{0,300}Code sent to/.test(twoStep)], [true, true, true]);
is("codes shown once, the key to type, a code not emailed, not on every deployment, as the studio says", [twoStep.includes("They are shown this once."), twoStep.includes("or type the key into it"), twoStep.includes("The code could not be emailed to that address just now."), twoStep.includes("Two-step login is not available on this deployment yet.")], [true, true, true, true]);
is("a recovery code in place of the app's, a passkey needs no code, the recovery address's button only when there is one", [code.includes("Type one of the recovery codes you saved when you turned this on; each works once."), code.includes(", which needs no code."), /\) : backup \? \([\s\S]*label="Email my recovery address"/.test(code)], [true, true, true]);
is("a login through the recovery address is told why no link is sent", /"rescue-none": "There is no recovery address to send a link to for this login\./.test(code) && read("lib/two-step.ts").includes('if (held?.viaRecovery) return "none";'), true);
const behind = ["app/api/auth/passkey/route.ts", "app/api/auth/recovery-address/route.ts", "app/api/auth/two-step/route.ts", "lib/two-step.ts", "lib/passkeys.ts", "lib/recovery-address.ts"].map(read).join("\n");
is("no plan read behind them", /\bplanOf\(|planStanding|PLANS_ON_SALE|canSell\(|isPaidUp\(|canUse\(/.test(behind), false);

part("The answers");
const now = securityBeginnerQuestions();
is("four questions", now.map((x) => x.q), ["What do I need to do to keep my account safe?", "How do I turn on two-step login?", "Do these need a plan or a payment?", "What if I lose my phone?"]);
const steps = answer(now, "How do I turn on two-step login?");
is("two-step: the studio's words, in the screen's order, log in again first", (() => { const at = [`“${w.account}”`, `“${w.twoStep}”`, "log in again", `“${w.turnOn}”`, `“${w.confirm}”`].map((x) => steps.indexOf(x)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("two-step: the emailed code only when typed here, a code not emailed, not available", [steps.includes("if you typed the recovery address here"), steps.includes("could not be emailed"), steps.includes("not available yet")], [true, true, true]);
is("plan: none, nothing charged, once the address is taken", [answer(now, "Do these need a plan or a payment?").startsWith("No."), answer(now, "Do these need a plan or a payment?").includes("once you have taken your store's address")], [true, true]);
const lost = answer(now, "What if I lose my phone?");
is("lost phone: two-step off, a passkey on another device, the button only if kept", [lost.startsWith("With two-step login off, nothing changes"), lost.includes("a passkey kept on another device"), lost.includes(`If you kept a recovery address, the code page offers “${w.emailRecovery}”`)], [true, true, true]);
const all = now.map((x) => x.a).join(" ");
is("never every account, never that each one keeps people out", [/every account/i.test(all), /each makes it harder/i.test(all)], [false, false]);
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the six digits, no percent, no claim of being safer than anyone", [/\d/.test(all.split("six digits").join("")), /%|safest|most secure|guarantee|unhackable/i.test(all)], [false, false]);

part("On the security page");
const faq = (findPage("platform", "security")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
