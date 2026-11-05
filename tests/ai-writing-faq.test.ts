/**
 * The questions someone starting out asks about the writing help (534 [FQ1],
 * unit 39, lib/ai-writing-faq.ts; added 2 November 2026). Checked: the
 * buttons' own words, read from the editors; every button drawn only while
 * the writing help is on; on only for a paid-up Studio or Scale plan, never in
 * a trial; each answer in both states; no sentence said twice on the page; no
 * figure; first in the page's own Questions block.
 */
import { readFileSync, readdirSync } from "node:fs";
import { AI_WRITING_WORDS, aiWritingBeginnerQuestions } from "@/lib/ai-writing-faq";
import { aiAllowance, aiOffReason } from "@/lib/ai";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { PLAN_TITLES } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = AI_WRITING_WORDS;

part("The editors and the rules");
const components = readdirSync("components").filter((f) => f.endsWith(".tsx")).map((f) => read(`components/${f}`)).join("\n");
const assist = flat(read("components/ai-assist.tsx"));
is("the buttons' and the panels' words, as the studio draws them", [components.includes(`"${w.draft}"`), components.includes(`title="${w.panel}"`), assist.includes(`: "${w.write}"}`), flat(read("components/studio-help.tsx")).includes(` ${w.help} `)], [true, true, true, true]);
const home = flat(read("app/studio/page.tsx"));
is("each way in drawn only while the writing help is available", [assist.includes("const { on, left: startLeft } = useContext(AiOn);") && assist.includes("if (!on) return null;"), home.includes("{ai.on ? <StudioHelp"), home.includes('ai.on && may("page") && may("products")'), home.includes("canAsk={aiAvailableFor(store)}"), home.includes("const ai = store && aiAvailableFor(store) ?"), ["app/studio/blog/page.tsx", "app/studio/reviews/page.tsx", "app/studio/site/page.tsx", "app/studio/pages/page.tsx"].every((f) => read(f).includes("aiAvailableFor("))], [true, true, true, true, true, true]);
const now = Date.now();
const store = (extra: Record<string, unknown>) => ({ sid: "a".repeat(32), handle: "aiwriting", tier: "pro", subscriptionActive: true, subscriptionId: "sub_Ai0001", trialEnds: 0, planEndedAt: "", cycle: "month", ...extra }) as never;
is("off on the Store plan, without a plan and in a trial; none on the Store plan or in a trial", [aiOffReason(store({ tier: "creator" }), now), aiOffReason(store({ subscriptionActive: false, subscriptionId: null }), now), aiOffReason(store({ trialEnds: now / 1000 + 86_400 }), now), AI_MONTHLY.trial, AI_MONTHLY.creator, aiAllowance(store({ trialEnds: now / 1000 + 86_400 }), now)], ["plan", "plan", "trial", 0, 0, 0]);

part("The answers, in both states");
const today = aiWritingBeginnerQuestions(false);
const later = aiWritingBeginnerQuestions(true);
is("two questions", today.map((x) => x.q), ["Where do I find the writing help?", "Can I try the writing help before paying?"]);
const where = answer(today, "Where do I find the writing help?");
is("finding it: next to what it writes, paid-up Studio or Scale, its label, while available, the button, the panel and its press, the help box, not shown otherwise", [where.startsWith("In your studio, next to what it writes."), where.includes(`On a paid-up ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan (your studio calls the ${PLAN_TITLES.pro} plan “Pro”), while the writing help is available for your store`), (() => { const k = [w.draft, w.panel, w.write, w.help].map((x) => where.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), where.endsWith("Otherwise none of these are shown."), /switched on|save it yourself/.test(where)], [true, true, true, true, false]);
is("trying: needs, never comes with; not in the trial; no promise past a paid-up plan; nothing the page's closing already says", [answer(today, "Can I try the writing help before paying?"), answer(later, "Can I try the writing help before paying?")], [`Not yet. The writing help needs a paid-up ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan, and paid plans are not on sale yet.`, `Not in the free trial: the trial does not include the writing help. It needs a ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan that is paid up.`]);
const all = [...today, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure, no percent, no result promised", [/\d/.test(all), /%|guarantee|more sales|convert/i.test(all)], [false, false]);

part("On the writing help page");
const topic = findPage("platform", "ai-writing");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 2).map((x) => x.q), today.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20);
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(2) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [today, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
