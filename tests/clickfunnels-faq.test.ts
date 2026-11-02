/**
 * The questions someone starting out asks about moving from ClickFunnels
 * (534 [FQ1], unit 37, lib/clickfunnels-faq.ts; added 2 November 2026).
 * Checked: the studio's own words, read from its files, in the screen's
 * order; a dry run before each import; nothing asking for a plan to start a
 * ClickFunnels file, and the email to past buyers needing the plan or its
 * trial; the shared trial answer in both states; no sentence said twice on
 * the page; no figure; first in the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { CLICKFUNNELS_WORDS, clickFunnelsBeginnerQuestions } from "@/lib/clickfunnels-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { startProblem } from "@/lib/imports";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = CLICKFUNNELS_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const page = flat(read("app/studio/import/page.tsx"));
const tool = flat(read("components/import-tool.tsx"));
const funnel = flat(read("components/clickfunnels-funnel.tsx"));
is("the tool, and its ClickFunnels part", [studio.includes(`title: "${w.tool}"`), page.includes(`<span className="block font-semibold text-ink">${w.part}</span>`), page.includes('studioPath(store, "what=clickfunnels", "import")')], [true, true, true]);
is("the steps, from the first to the last", [page.indexOf(`title: "${w.first}"`) >= 0, page.indexOf(`title: "${w.first}"`) < page.indexOf(`title: "${w.last}"`)], [true, true]);
is("a file: choose, the columns, check first, then import only while the check is current, the boxes part of it", [tool.includes(`"${w.file}"`), tool.includes(`>${w.columns}</legend>`), tool.includes(`: "${w.check}"}`), tool.includes("{!fromClickFunnels || dryFresh ? ( <button type=\"button\" onClick={start}"), tool.includes("const signature = JSON.stringify([fileName, rows.length, mapping, lastName, agreed, tags, email])")], [true, true, true, true, true]);
is("dry runs used up: a ClickFunnels file waits, as the studio now says; one import at a time", [tool.includes("a ClickFunnels file waits until a check can finish again"), tool.includes("It has to finish, or be canceled, before another starts")], [true, true]);
is("the funnel: choose the pages, what each was, check first, then import once nothing is to fix", [funnel.includes(`: "${w.pages}"}`), funnel.includes(`>${w.role}</span>`), funnel.indexOf(w.pages) < funnel.indexOf(w.checkFunnel), funnel.includes(`: "${w.goFunnel}"}`), funnel.includes("planFresh && blocking.length === 0")], [true, true, true, true, true]);
const none = { sid: "c".repeat(32), catalog: { items: [] }, subscriptionActive: false, subscriptionId: null, trialEnds: 0, stripeAccountId: "", stripeChargesEnabled: false, tier: "creator" } as never;
const go = (kind: Parameters<typeof startProblem>[1], extra: Record<string, unknown>) => startProblem(none, kind, { expected: 5, source: "clickfunnels", ...extra } as never)?.reason ?? null;
is("with no plan, each ClickFunnels file starts; the email to past buyers does not", [go("products", {}), go("contacts", {}), go("purchases", { email: false }), go("purchases", { email: true })], [null, null, null, "email"]);
is("the buyers' email box needs a paid-up plan and the sender, and says both", [read("app/studio/import/page.tsx").includes("canEmail={isPaidUp(store) && isSenderConfigured()}"), tool.includes("Needs your store's plan to be active and paid up, and our email sending switched on.")], [true, true]);
is("the funnel import asks for no plan, only no paused costs", [/isPaidUp|canSell|PLANS_ON_SALE/.test(read("app/api/store/import/funnel/route.ts")), read("app/api/store/import/funnel/route.ts").includes("costPauseCode(store)")], [false, true]);

part("The answers, in both states");
const now = clickFunnelsBeginnerQuestions(false, TRIAL_DAYS);
const later = clickFunnelsBeginnerQuestions(true, TRIAL_DAYS);
is("two questions", now.map((x) => x.q), ["Where do I start?", "Can I try it before paying?"]);
const start = answer(now, "Where do I start?");
is("starting: the studio's words in order", (() => { const k = [w.tool, w.part, w.first, w.last, w.file, w.columns, w.check, w.go, w.pages, w.role, w.checkFunnel, w.goFunnel].map((x) => start.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), true);
is("trying: the shared answer, and the buyers' email only with the plan", [answer(now, "Can I try it before paying?").startsWith(tryBeforePaying("A move from ClickFunnels", "your products, contacts, past buyers and funnel pages", false, TRIAL_DAYS)), answer(now, "Can I try it before paying?").includes("only while your store's plan is active and paid up and our email sending is switched on"), answer(later, "Can I try it before paying?").includes("only while your store's plan (or its trial) is active and paid up")], [true, true, true]);
is("no order said again: the page already answers it", [/in that order|then your contacts/i.test(start), findPage("platform", "move-from-clickfunnels") !== undefined], [false, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the steps' and the trial's", /\d/.test(all.split(`${TRIAL_DAYS}-day`).join("").replace(/“\d\. /g, "")), false);

part("On the ClickFunnels page");
const topic = findPage("platform", "move-from-clickfunnels");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 2).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [false, true].map((s) => tryBeforePaying("A move from ClickFunnels", "your products, contacts, past buyers and funnel pages", s, TRIAL_DAYS)).join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(2) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
