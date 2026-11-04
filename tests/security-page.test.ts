/**
 * The public security page, /platform/security (247 [SP4], unit 1; added
 * 4 November 2026). It may say only what the code does today, so each of its
 * claims is pinned here to the mechanism it relies on: the page's own words
 * must still be there AND the code behind them must still exist. When a
 * mechanism goes away, this fails until the page stops saying it.
 *
 * Also checked: no badge, certification, superiority or absolute word; the
 * page says no system is free of faults; a glossary for its unusual words,
 * drawn as a description list; the full footer's Company column and the short
 * address /security lead to it; security.txt's policy is this page.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicPageView } from "@/components/topic-page";
import { SiteFooter } from "@/components/site-footer";
import { findPage } from "@/lib/site-pages";
import { MAX_IMAGE_BYTES, IMAGE_CONTENT_TYPES } from "@/lib/product-image";
import { MAX_FILE_BYTES, maxFileLabel } from "@/lib/product-file";
import { SESSION_COOKIE_OPTIONS } from "@/lib/auth";
import { fileHeaders } from "@/lib/request-guard";
import { isPublicAddress } from "@/lib/safe-fetch";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const page = findPage("platform", "security");
if (!page) throw new Error("the security page is missing from lib/feature-pages.ts");
const words = JSON.stringify(page);
const says = (phrase: string) => words.includes(phrase);

part("Payments and sign-in");
const checkout = read("lib/store-checkout.ts");
const account = read("lib/stripe-account.ts");
is("card payments on Stripe's own checkout, on the creator's account", [says("We never see a card number"), /onAccount\("POST", store\.stripeAccountId as string, "\/checkout\/sessions"/.test(checkout), account.includes("Stripe-Account")], [true, true, true]);
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
is("no card number field of our own", ["app", "components"].flatMap(sources).filter((file) => /cc-number|cardnumber/i.test(read(file))), []);
const auth = read("lib/auth.ts");
is("the emailed link: once, 15 minutes, kept only as a hash", [says("It works once and stops working after 15 minutes"), says("We keep only a hash of the link"), auth.includes("const LINK_TTL_SECONDS = 15 * 60;"), /\["GETDEL", key\]/.test(auth), /nl:auth:link:\$\{\(await sha256Hex\(/.test(auth)], [true, true, true, true, true]);
is("the session cookie: HttpOnly, encrypted connection on the live site, hashed, 30 days", [says("because it is HttpOnly"), says("sent only over an encrypted connection"), says("It ends after 30 days, or when you log out"), SESSION_COOKIE_OPTIONS.httpOnly, /secure: process\.env\.NODE_ENV === "production"/.test(auth), SESSION_COOKIE_OPTIONS.maxAge === 30 * 24 * 60 * 60, /nl:auth:session:\$\{\(await sha256Hex\(/.test(auth), /export async function endSession/.test(auth)], [true, true, true, true, true, true, true, true]);
is("passkeys and two-step login with recovery codes exist", [says("Passkeys, if you want them"), says("Two-step login"), says("Ten recovery codes"), existsSync("lib/passkeys.ts"), existsSync("lib/two-step.ts"), existsSync("app/api/auth/two-step/route.ts")], [true, true, true, true, true, true]);

part("Requests, files and bots");
const proxy = read("proxy.ts");
is("changes from another site refused", [says("Every request that changes something must come from this site"), /if \(fromAnotherSite\(request\) && !CROSS_SITE_POSTS\.has/.test(proxy)], [true, true]);
is("files served so they cannot run", [says("headers that stop a browser running anything inside it"), fileHeaders("text/html", "x.html")["Content-Security-Policy"].includes("sandbox"), fileHeaders("text/html", "x.html")["X-Content-Type-Options"], fileHeaders("text/html", "x.html")["Content-Disposition"].startsWith("attachment")], [true, true, "nosniff", true]);
const image = read("lib/uploaded-image.ts");
// Refused, not deleted (review of #2114): the check deletes nothing, since the path came from the browser; only the
// picture door drops what it took itself (lib/picture-door.ts, dropTakenPictures).
is("product and page pictures checked by their first bytes, JPEG or WebP, 1 MB, or refused", [says("A product or page picture you upload is checked by its first bytes"), says("a JPEG or a WebP, at most 1 MB, or it is refused"), says("or it is deleted"), MAX_IMAGE_BYTES, [...IMAGE_CONTENT_TYPES].sort(), /sniffPhotoType\(bytes\)/.test(image), image.includes('error: "too_big"') && image.includes('error: "type"'), /dropTakenPictures/.test(read("app/api/store/image/route.ts")) && /dropTakenPictures/.test(read("app/api/store/link-image/route.ts"))], [true, true, false, 1_000_000, ["image/jpeg", "image/webp"], true, true, true]);
is("a sold file has a size limit, said from the code", [says(`A file you sell can be at most ${maxFileLabel()}`), /maximumUploadBytes\(held, MAX_FILE_BYTES\)/.test(read("app/api/store/file/route.ts")), MAX_FILE_BYTES > 0], [true, true, true]);
const signinRoute = read("app/api/auth/request/route.ts");
is("hidden box on sign-in, contact and free-product forms; sign-in asks the host about programs", [says("A request that fills it in is dropped"), /body\.website/.test(signinRoute), /await isAutomated\(\)/.test(signinRoute), /if \(honeypot\.trim\(\)\)/.test(read("app/api/store/contact/route.ts")), /if \(honeypot\.trim\(\)\)/.test(read("app/api/store/free/route.ts")), read("lib/bot-check.ts").includes('from "botid/server"')], [true, true, true, true, true, true]);
is("outbound fetches refuse private networks", [says("refuses one inside a private network"), isPublicAddress("10.0.0.1"), isPublicAddress("169.254.169.254"), isPublicAddress("8.8.8.8"), /safeFetch/.test(read("lib/webhooks.ts")), /safeFetch/.test(read("lib/calendar-sync.ts"))], [true, false, false, true, true, true]);
is("webhooks signed with HMAC-SHA256", [says("signed with HMAC-SHA256"), /createHmac\("sha256", secret\)/.test(read("lib/webhooks.ts"))], [true, true]);
is("paid work reserved against store and site ceilings before it starts", [says("counted against a monthly ceiling for your store, and one for the whole site, before it starts"), /export async function reserveAiSpend/.test(read("lib/ai-spend.ts")), /reserveAiSpend\(/.test(read("lib/ai.ts")), /export async function reserveStoreUpload/.test(read("lib/upload-budget.ts")), /reserveStoreUpload\(store, MAX_FILE_BYTES/.test(read("app/api/store/file/route.ts"))], [true, true, true, true, true]);

part("Data export and deletion");
is("the whole store as one file", [says("can download everything your store keeps as one file"), /what === "store"/.test(read("app/api/store/export/route.ts")), /export function storeExport/.test(read("lib/store-export.ts"))], [true, true, true]);
is("a buyer deletes their own data by an emailed link", [says("Buyers can delete their own data"), words.includes('"href":"/privacy/delete"'), existsSync("app/privacy/delete/page.tsx"), existsSync("app/api/privacy/erase/route.ts")], [true, true, true, true]);
is("a creator deletes one person", [says("can delete one person from your store"), /erasePerson\(/.test(read("app/api/store/person/route.ts"))], [true, true]);

part("How the code is checked");
const workflow = (name: string) => read(`.github/workflows/${name}.yml`);
const everyChangeAndDaily = (text: string) => /\n  pull_request:\n/.test(text) && /\n  schedule:\n    - cron:/.test(text);
is("tests on every proposed change and daily", [says("runs our automated tests"), everyChangeAndDaily(workflow("product-checks")), /run: npm test/.test(workflow("product-checks"))], [true, true, true]);
is("CodeQL on every proposed change to the code and daily", [says("CodeQL, GitHub's code scanner") && says("on every proposed change to the code and once a day"), everyChangeAndDaily(workflow("codeql")), /github\/codeql-action\/analyze@/.test(workflow("codeql"))], [true, true, true]);
is("npm audit on every proposed change to the code and daily", [says("npm audit compares the packages") && says("known security flaws, on every proposed change to the code"), everyChangeAndDaily(workflow("dependency-security")), /npm audit --json/.test(workflow("dependency-security"))], [true, true, true]);
is("the written review of October 18, 2026", [says("On October 18, 2026, the code was reviewed for security faults"), existsSync("docs/security-audit-2026-10-18.md") && read("docs/security-audit-2026-10-18.md").includes("Listed, not fixed")], [true, true]);

part("Honest words");
is("says no system is free of faults", says("No system is free of faults, and this one is not either."), true);
const forbidden = [/\b(fully|completely|totally|perfectly|100%) secure\b/i, /\b(is|are|stays|stay|keeps you|kept) secure\b/i, /\bsecure (platform|site|store|checkout)\b/i, /\bcertifi(ed|cation)\b/i, /\bbank[- ]level\b/i, /\bmilitary[- ]grade\b/i, /\bunhackable\b/i, /\b100%/, /\bguarantee/i, /\b(safest|most secure|more secure|safer than)\b/i, /\b(SOC ?2|ISO ?27001|PCI[- ]DSS)\b/i, /\bbadge\b/i];
// Only what a reader sees: every string value, not the field names (the page record has a `badge` field for its "working" tag).
const shown = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(shown) : value && typeof value === "object" ? Object.values(value).flatMap(shown) : [];
const text = shown(page).join("\n");
is("no absolute promise, badge, certification or comparison", forbidden.filter((re) => re.test(text)).map(String), []);

part("Glossary, links and rendering");
const terms = page.blocks.find((b) => b.kind === "terms");
const defined = terms && terms.kind === "terms" ? terms.items.map((t) => t.term) : [];
is("defines its unusual words", ["Passkey", "Two-step login", "Recovery code", "Hash", "Cookie, HttpOnly", "Content-Security-Policy", "HSTS", "Webhook", "HMAC-SHA256", "Private network", "Code scanning"].every((t) => defined.includes(t)), true);
const html = renderToStaticMarkup(createElement(TopicPageView, { page }));
is("the glossary is a description list under its own heading", [/<h2 id="words-on-this-page"[^>]*>Words on this page<\/h2>\s*<dl/.test(html), /<dt[^>]*>Hash<\/dt>\s*<dd/.test(html)], [true, true]);
const headings = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
is("headings never skip a level going down", headings.every((h, i) => i === 0 || h <= headings[i - 1] + 1), true);
const footer = renderToStaticMarkup(SiteFooter({}));
is("in the full footer's Company column, which every page but the home page shows", /<nav aria-label="Company">[\s\S]*?href="\/platform\/security"[^>]*>Security<\/a>[\s\S]*?<\/nav>/.test(footer), true);
is("/security leads to it", read("next.config.ts").includes('...to("/platform/security", "/security")'), true);
is("security.txt names it as its policy", read("public/.well-known/security.txt").includes("Policy: https://marktmorgen.com/platform/security"), true);

done();
