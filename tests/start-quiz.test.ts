/**
 * "Where should I start?" (562 [QZ1], unit 1; lib/start-quiz.ts, components/start-quiz.tsx, app/start-here;
 * added 12 November 2026). Checked:
 *
 *   - every page the answer links to exists on the site (lib/site-pages.ts PAGES, in its section), every template it
 *     names exists in the studio (lib/funnel-starters.ts), and every platform it offers has an importer's guide;
 *   - every combination of answers has an answer, nothing is answered before all three questions are, and an answer
 *     that is not one of the choices gives none;
 *   - the plan is named with its published prices (lib/plan.ts), and sign-up opens with that plan, as the pricing
 *     page's cards do; while plans are not on sale, the answer says so;
 *   - the page asks for no email, sends nothing (no form action, no fetch in the quiz) and says the answers stay in
 *     the browser; the questions are radio groups with legends; the answer is announced in a status region;
 *   - no promise of sales or income, no urgency, no scarcity; the page is in the sitemap.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUDIENCE_CHOICES, SELL_CHOICES, SELL_PATHS, type QuizFacts, quizQuestions, quizResult } from "@/lib/start-quiz";
import { StartQuiz } from "@/components/start-quiz";
import { PAGES } from "@/lib/site-pages";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import { PLAN_TITLES, publishedPriceWords } from "@/lib/plan";
import { done, is, part } from "./check";

const facts = (onSale: boolean): QuizFacts => ({
  starters: Object.fromEntries(FUNNEL_STARTERS.map((s) => [s.id, { label: s.label, hint: s.hint }])),
  guides: MIGRATION_GUIDES.map((g) => ({ slug: g.slug, platform: g.platform })),
  plan: { tier: "creator", name: PLAN_TITLES.creator, monthly: publishedPriceWords("creator", "month"), yearly: publishedPriceWords("creator", "year"), onSale },
});
const page = (section: string, slug: string) => PAGES.find((p) => p.section === section && p.slug === slug);

part("Everything it names exists");
const paths = Object.values(SELL_PATHS);
is("every feature page", paths.filter((p) => !page("platform", p.feature)).map((p) => p.feature), []);
is("every page for a kind of creator", paths.filter((p) => p.forPage && !page("for", p.forPage)).map((p) => p.forPage), []);
is("every template, starting out and with a following", paths.flatMap((p) => Object.values(p.starter)).filter((id) => !FUNNEL_STARTERS.some((s) => s.id === id)), []);
is("every feature it names is on the plan it recommends", paths.filter((p) => page("platform", p.feature)?.plan !== "creator").map((p) => p.feature), []);
is("every platform offered has its guide, and the general one exists", [MIGRATION_GUIDES.every((g) => page("platform", g.slug)), Boolean(page("platform", "switching-to-marktmorgen"))], [true, true]);

part("Every answer has an answer");
const f = facts(true);
const froms = quizQuestions(f.guides)[2].choices.map((c) => c.id);
let missing = 0;
for (const sell of SELL_CHOICES) for (const audience of AUDIENCE_CHOICES) for (const from of froms) if (!quizResult(f, { sell: sell.id, audience: audience.id, from })) missing += 1;
is(`all ${SELL_CHOICES.length * AUDIENCE_CHOICES.length * froms.length} combinations`, missing, 0);
is("nothing before all three are answered", [quizResult(f, {}), quizResult(f, { sell: "course" }), quizResult(f, { sell: "course", audience: "starting" })], [null, null, null]);
is("an answer that is not a choice gives none", [quizResult(f, { sell: "crypto", audience: "starting", from: "no" }), quizResult(f, { sell: "course", audience: "starting", from: "move-from-nowhere" })], [null, null]);
const course = quizResult(f, { sell: "course", audience: "following", from: MIGRATION_GUIDES[0].slug })!;
is("a course creator with a following who sells elsewhere", {
  links: course.links.map((l) => l.href),
  starter: course.starter.label,
  moving: course.moving?.href,
}, {
  links: ["/for/course-creators", "/platform/courses"],
  starter: FUNNEL_STARTERS.find((s) => s.id === "course-launch")!.label,
  moving: `/platform/${MIGRATION_GUIDES[0].slug}`,
});
is("starting out, a template that gathers people first; another platform, the general guide; none, no guide", [quizResult(f, { sell: "files", audience: "starting", from: "other" })!.starter.label, quizResult(f, { sell: "files", audience: "starting", from: "other" })!.moving?.href, quizResult(f, { sell: "files", audience: "starting", from: "no" })!.moving], [FUNNEL_STARTERS.find((s) => s.id === "guide-signup")!.label, "/platform/switching-to-marktmorgen", null]);
is("the plan with its published prices, and sign-up with it", [course.plan.monthly, course.plan.yearly, course.start.href], [publishedPriceWords("creator", "month"), publishedPriceWords("creator", "year"), "/signin?plan=creator&billing=month"]);

part("The page");
const closed = renderToStaticMarkup(createElement(StartQuiz, { facts: facts(false) }));
is("three questions as radio groups with legends", [(closed.match(/<fieldset/g) ?? []).length, (closed.match(/<legend/g) ?? []).length, closed.includes('type="radio"')], [3, 3, true]);
is("the answer has a heading and is announced in a status region", [closed.includes('id="start-result-title"'), closed.includes('role="status"'), closed.includes('aria-live="polite"')], [true, true, true]);
is("before answering, it says what to do", closed.includes("Answer the 3 questions above and your starting point appears here."), true);
is("no email asked, nothing sent", [/type="email"|name="email"/.test(closed), /action=/.test(closed), readFileSync("components/start-quiz.tsx", "utf8").includes("fetch(")], [false, false, false]);
const source = readFileSync("components/start-quiz.tsx", "utf8");
is("while plans are not on sale, the answer says so", source.includes("result.plan.onSale ? null : <p className=\"font-semibold\">Paid plans and paid selling are not open yet. You can prepare your store now.</p>"), true);
const route = readFileSync("app/start-here/page.tsx", "utf8");
is("the page says the answers stay in the browser", route.includes("Your answers stay in this browser: they are not sent or kept."), true);
const words = [closed, source, route, JSON.stringify(SELL_PATHS), JSON.stringify(quizQuestions(f.guides))].join(" ").replace(/<[^>]+>/g, " ");
is("no promise of sales or income, no urgency or scarcity", /guarantee|income|earn |make money|six figures|limited time|only \d+ left|hurry|today only|act now/i.test(words), false);
is("it says it is not a promise of sales", source.includes("This is where to start, not a promise of sales."), true);
is("in the sitemap", readFileSync("app/sitemap.ts", "utf8").includes('{ path: "/start-here", priority: 0.6 }'), true);

done();
