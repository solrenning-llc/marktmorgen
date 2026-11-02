/**
 * The questions someone starting out asks about the community (534 [FQ1],
 * unit 27, lib/community-faq.ts; added 2 November 2026). Checked: the
 * studio's own words, read from its file, in the order the answer gives them;
 * set up by whoever may change settings; switched off at first; the way in on
 * the store page once on; its address; a sale needing the plan or its trial;
 * the shared trial answer in both states; no sentence said twice on the page;
 * no figure; first in the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { COMMUNITY_WORDS, communityBeginnerQuestions } from "@/lib/community-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = COMMUNITY_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const panel = flat(read("components/community-studio.tsx"));
const route = flat(read("app/api/store/community/manage/route.ts"));
is("the tool, and setting up for whoever may change settings", [studio.includes(`href: studioPath(store, "", "community"), title: "${w.tool}"`), route.includes('(MODERATION.has(text(body.action, 20)) ? "community" : "settings")'), can("owner", "settings"), can("admin", "settings"), can("editor", "settings")], [true, true, true, true, false]);
is("set up switched off, as the studio says", [panel.includes(`: "${w.start}"}`), panel.includes('run("start", { action: "enable", on: false }'), panel.includes("Switched off: only the store's owner can open it"), panel.includes("Only the store&apos;s owner can see it until then."), read("lib/learn.ts").includes("normaliseEmail(signedIn) === normaliseEmail(store.email)")], [true, true, true, true, true]);
is("on screen: switch it on above who gets in; with no product, a product first", [panel.indexOf("<Basics ") > 0 && panel.indexOf("<Basics ") < panel.indexOf("<Access "), panel.includes("Add a product first: people come in by buying one.")], [true, true]);
is("who gets in, saved, switched on, as the studio says", [panel.includes(`>${w.who}</h2>`), panel.includes(` ${w.saveWho} </button>`), panel.includes(`: "${w.on}"}`)], [true, true, true]);
const storePage = flat(read("app/[handle]/page.tsx"));
is("once on, the store page shows the way in, unless the page rests; its address", [storePage.includes("community: store.community?.on === true"), storePage.includes("if (await isResting(store)) return <StoreResting store={store} />;"), panel.includes(`>${w.address}</p>`)], [true, true, true]);
is("a sale or a free copy needs the plan or its trial", [flat(read("lib/store-checkout.ts")).includes("isPaidUp(store) &&"), flat(read("lib/free.ts")).includes("isPaidUp(store) &&")], [true, true]);

part("The answers, in both states");
const now = communityBeginnerQuestions(false, TRIAL_DAYS);
const later = communityBeginnerQuestions(true, TRIAL_DAYS);
is("three questions", now.map((x) => x.q), ["How do I start my community?", "How do my buyers find it?", "Can I try it before paying?"]);
const start = answer(now, "How do I start my community?");
is("starting: the owner or an Admin, only the owner while off, no product first, the studio's words in order", [start.includes("the owner or an Admin"), start.includes("only the store's owner can open it"), start.includes("with no product yet, it asks you to add one first"), (() => { const at = [w.tool, w.start, w.who, w.saveWho, w.on].map((x) => start.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })()], [true, true, true, true]);
is("finding it: once on, the address", [answer(now, "How do my buyers find it?").startsWith("Once it is switched on"), answer(now, "How do my buyers find it?").includes(`“${w.address}”`)], [true, true]);
is("try before paying: the shared answer, and a sale's plan", [answer(now, "Can I try it before paying?").startsWith(tryBeforePaying("The community", "your community", false, TRIAL_DAYS)), answer(now, "Can I try it before paying?").endsWith("a sale or a free copy needs your store's plan."), answer(later, "Can I try it before paying?").startsWith(tryBeforePaying("The community", "your community", true, TRIAL_DAYS)), answer(later, "Can I try it before paying?").endsWith("a sale or a free copy needs your store's plan or its trial.")], [true, true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|more sales|engagement|proven/i.test(all)], [false, false]);

part("On the community page");
const topic = findPage("platform", "community");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("The community", "your community", false, TRIAL_DAYS), tryBeforePaying("The community", "your community", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
