/**
 * The questions someone starting out asks about connecting an email platform
 * (534 [FQ1], unit 26, lib/email-platform-faq.ts; added 2 November 2026).
 * Checked: the studio's own words, read from its files, in the order the
 * answer gives them; the page for whoever may change settings, with no plan
 * read by its route; the warning where keys cannot be kept; each platform's
 * key told where to find; nobody sent before a sign-up or a sale, both
 * needing the plan or its trial; the shared trial answer in both states; no
 * sentence said twice on the page; no figure; first in the page's own
 * Questions block.
 */
import { readFileSync } from "node:fs";
import { EMAIL_PLATFORM_WORDS, emailPlatformBeginnerQuestions } from "@/lib/email-platform-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = EMAIL_PLATFORM_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const editor = flat(read("components/email-sync-editor.tsx"));
const route = read("app/api/store/email-sync/route.ts");
is("the tool, for whoever may change settings, with no plan read by its route", [studio.includes(`...(may("settings") ? [{ href: studioPath(store, "", "integrations"), title: "${w.tool}"`), can("owner", "settings"), can("admin", "settings"), can("editor", "settings"), route.includes('guardStoreWrite(request, "settings"'), /planOf\(|PLANS_ON_SALE|canUse\(|isPaidUp\(|canSell\(/.test(route)], [true, true, true, false, true, false]);
const connected = editor.slice(editor.indexOf("{connected && !replacing ? ("), editor.indexOf(`>${w.platform}</legend>`));
is("once connected: the place, who is sent, save and test; before: the platform and connect, as the editor says them", [connected.includes(`{\`${w.target} \${info.target}\`}`), connected.includes(`>${w.who}</legend>`), connected.includes(`: "${w.save}"}`), connected.includes(`: "${w.test}"}`), editor.includes(`>${w.platform}</legend>`), editor.indexOf(`>${w.platform}</legend>`) < editor.indexOf(`: "${w.connect}"}`), editor.includes(` ${w.log} </h2>`)], [true, true, true, true, true, true, true]);
is("each platform's key told where to find, under the key's box", [(editor.match(/where: "In [A-Za-z]+/g) ?? []).length, editor.includes('aria-describedby="sync-key-where"')], [4, true]);
is("the warning where keys cannot be kept", [editor.includes("Keys cannot be stored safely on this deployment yet, so no platform can be connected."), read("lib/email-sync.ts").includes("const available = canSeal() && isRedisConfigured();")], [true, true]);
is("the test checks the key and the place, or says it could not", [read("lib/email-sync.ts").includes("accepted the key and"), read("lib/email-sync.ts").includes("The platform could not be contacted just now.")], [true, true]);
is("until a plan is paid, the platform calls are limited, and the studio says it cannot reach the platform", [route.includes('withinService("esync"'), NON_PAYING_ALLOWANCES.none.integration > 0, NON_PAYING_ALLOWANCES.trial.integration > 0, editor.includes("The studio cannot reach your platform again just now: that is twenty requests in a minute, or this month's calls to it are used up.")], [true, true, true, true]);
is("a free sign-up, a list sign-up and a sale each need the plan or its trial", [flat(read("lib/free.ts")).includes("isPaidUp(store) &&"), read("lib/store-join.ts").includes("isPaidUp(store)"), flat(read("lib/store-checkout.ts")).includes("isPaidUp(store) &&")], [true, true, true]);

part("The answers, in both states");
const now = emailPlatformBeginnerQuestions(false, TRIAL_DAYS);
const later = emailPlatformBeginnerQuestions(true, TRIAL_DAYS);
is("three questions", now.map((x) => x.q), ["How do I connect my email tool?", "How do I know it works?", "Can I try it before paying?"]);
const how = answer(now, "How do I connect my email tool?");
is("connecting: the owner or an Admin, the studio's words in order, the warning", [how.startsWith("The owner or an Admin does it."), (() => { const at = [w.tool, w.platform, w.connect, `${w.target} …`, w.who, w.save].map((x) => how.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), how.endsWith("no platform can be connected for now.")], [true, true, true]);
is("works: the test button once connected, the log's own title", [answer(now, "How do I know it works?").startsWith(`Once connected, press “${w.test}”`), answer(now, "How do I know it works?").includes(`Under “${w.log}”`)], [true, true]);
is("try before paying: the shared answer, and nobody sent before the plan", [answer(now, "Can I try it before paying?").startsWith(tryBeforePaying("The connection", "the connection", false, TRIAL_DAYS)), answer(now, "Can I try it before paying?").endsWith("open a checkout only on a plan."), answer(later, "Can I try it before paying?").startsWith(tryBeforePaying("The connection", "the connection", true, TRIAL_DAYS)), answer(later, "Can I try it before paying?").endsWith("open a checkout only on a plan or its trial.")], [true, true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|more sales|proven/i.test(all)], [false, false]);

part("On the email platforms page");
const topic = findPage("platform", "email-platforms");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("The connection", "the connection", false, TRIAL_DAYS), tryBeforePaying("The connection", "the connection", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
