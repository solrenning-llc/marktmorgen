/**
 * The questions someone starting out asks about Outreach (534 [FQ1], unit 35,
 * lib/outreach-faq.ts; added 2 November 2026). Checked: the studio's own
 * words, read from its file, in the screen's order; the writing help only on
 * a paid-up Studio or Scale plan, never in a trial; the studio saying why
 * when the plan has none, instead of "not switched on yet"; nothing sent
 * from here; each answer in both states; no sentence said twice on the page;
 * no figure; first in the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { OUTREACH_WORDS, outreachBeginnerQuestions } from "@/lib/outreach-faq";
import { aiAllowance, aiOffReason } from "@/lib/ai";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { PLAN_TITLES } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = OUTREACH_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const panel = flat(read("components/outreach-studio.tsx"));
is("the tool", studio.includes(`href: studioPath(store, "", "outreach"), title: "${w.tool}"`), true);
const at = [`> ${w.who} </h2>`, `> ${w.name} </label>`, `> ${w.address} </label>`, `"Saving…" : "${w.save}"`, `> ${w.write} </h2>`, `>${w.goal}</legend>`, `> ${w.site} </label>`, `> ${w.country} </label>`, `(${w.notHere})`, `"Reading their website…" : "${w.find}"`, `>${w.addresses}</legend>`, `"Writing…" : "${w.draft}"`, `> ${w.pitches} </h2>`].map((x) => panel.indexOf(x));
is("each word on screen, the sender first, then the business, then the draft and the pitches", [at.map((x, k) => (x < 0 ? k : -1)).filter((k) => k >= 0), at.every((x, k) => k === 0 || x > at[k - 1])], [[], true]);
is("the draft's own buttons", [`> ${w.gmail} </button>`, `> ${w.mailApp} </button>`, `> ${w.copy} </button>`].map((x) => panel.includes(x)), [true, true, true]);
const now0 = Date.now();
const store = (extra: Record<string, unknown>) => ({ sid: "o".repeat(32), handle: "outreach", tier: "pro", subscriptionActive: true, subscriptionId: "sub_Out0001", trialEnds: 0, planEndedAt: "", cycle: "month", ...extra }) as never;
is("why the writing help is off, said as it is", [aiOffReason(store({ tier: "creator" }), now0), aiOffReason(store({ subscriptionActive: false, subscriptionId: null }), now0), aiOffReason(store({ trialEnds: now0 / 1000 + 86_400 }), now0), aiOffReason(store({ renewalUnpaidSince: now0 / 1000 - 60 }), now0), aiOffReason(store({ tier: "scale" }), now0)], ["plan", "plan", "trial", "renewal_unpaid", "setup"]);
is("a trial has no writing help at all", [AI_MONTHLY.trial, aiAllowance(store({ trialEnds: now0 / 1000 + 86_400 }), now0)], [0, 0]);
const page = flat(read("app/studio/outreach/page.tsx"));
is("the studio says that reason, never only \"not switched on yet\"", [page.includes("const off = aiOffReason(store);"), ["plan", "trial", "renewal_unpaid", "plan_disputed", "setup"].every((k) => new RegExp(`\\b${k}: "`).test(panel)), panel.includes("{OFF_WORDS[off ?? \"setup\"]}")], [true, true, true]);
is("nothing is sent from here", read("lib/feature-pages.ts").includes("It does not send anything. Every email leaves from your own mailbox, when you press Send."), true);

part("The answers, in both states");
const now = outreachBeginnerQuestions(false);
const later = outreachBeginnerQuestions(true);
is("two questions", now.map((x) => x.q), ["How do I write my first pitch?", "Can I try outreach before paying?"]);
const how = answer(now, "How do I write my first pitch?");
is("writing: paid-up Studio or Scale, labeled Pro, switched on, who, the studio's words in order, sent by you", [how.startsWith(`On a paid-up ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan (your studio calls the ${PLAN_TITLES.pro} plan “Pro”), while the writing help is available for your store`), (() => { const k = [w.tool, w.who, w.name, w.address, w.save, w.write, w.goal, w.site, w.country, w.notHere, w.find, w.addresses, w.draft, w.pitches, w.gmail, w.mailApp, w.copy].map((x) => how.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), how.endsWith("you send it yourself, from your own mailbox.")], [true, true, true]);
is("trying: not yet today; not in the trial later, and no promise past a paid-up plan", [answer(now, "Can I try outreach before paying?").startsWith("Not yet."), answer(later, "Can I try outreach before paying?").startsWith("Not in the free trial: the trial leaves out paid AI writing"), answer(later, "Can I try outreach before paying?").endsWith("plan that is paid up."), /It opens once/.test(answer(later, "Can I try outreach before paying?"))], [true, true, true, false]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure, no percent, no answer promised", [/\d/.test(all), /%|guarantee|will answer|reply rate/i.test(all)], [false, false]);

part("On the Outreach page");
const topic = findPage("platform", "outreach");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 2).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !x.startsWith("To see a store working"));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(2) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
