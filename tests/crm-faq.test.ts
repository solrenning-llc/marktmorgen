/**
 * The questions someone starting out asks about people, deals and pipelines
 * (534 [FQ1], unit 38, lib/crm-faq.ts; added 2 November 2026). Checked: the
 * studio's own words, read from its file; the page for whoever may read
 * orders, and its route the same; one pipeline without a paid plan, more
 * with one or its trial; the shared trial answer in both states; no sentence
 * said twice on the page; no figure; the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { CRM_WORDS, crmBeginnerQuestions } from "@/lib/crm-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { PIPELINES_BY_TIER, TRIAL_PIPELINES, UNPAID_PIPELINES, changePipeline, pipelineLimit } from "@/lib/crm-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = CRM_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const board = flat(read("components/deals-board.tsx"));
const route = read("app/api/store/crm/route.ts");
const tile = studio.slice(studio.indexOf('...(may("orders") ? [ { href: studioPath(store, "", "people")'), studio.indexOf('...(may("orders") ? [ { href: studioPath(store, "", "people")') + 900);
is("the tool, its page and its route, for whoever may read orders only", [tile.includes(`href: studioPath(store, "", "deals"), title: "${w.tool}"`), read("app/studio/deals/page.tsx").includes('typeof query.store === "string" ? query.store : undefined, "orders");'), route.includes('guardStoreWrite(request, "orders"'), (route.match(/guardStoreWrite\(|can\(view\.role/g) ?? []).length, can("owner", "orders"), can("admin", "orders"), can("support", "orders"), can("editor", "orders")], [true, true, true, 1, true, true, true, false]);
is("a deal: new, what it is, saved; moved by the box on its card; the page that could not load", [board.includes(`${w.newDeal} </button>`), board.includes(`>${w.what}</span>`), board.includes(`: "${w.saveDeal}"}`), board.includes("`Move ${deal.title}`") && board.includes("stage: e.target.value"), read("components/deals-unavailable.tsx").includes(`>${w.unloaded}</h2>`), read("components/deals-unavailable.tsx").includes(`>${w.reload}</button>`), read("components/deals-unavailable.tsx").includes("No saved deal or contact field has been changed.")], [true, true, true, true, true, true, true]);
is("a field: its part, the first button opening no row, then a row, its kind, saved; filled in on the person's page", [board.includes(`> ${w.fields} </h2>`), board.includes(`: "${w.firstField}"}`), board.includes("setFieldDraft(fields.map("), board.includes(` ${w.addField} </button>`), board.includes(`>${w.kind}</span>`), board.includes(` ${w.saveFields} `), flat(read("app/studio/people/page.tsx")).includes(`>${w.fields}<`), read("components/person-fields.tsx").includes("Save {field.name}")], [true, true, true, true, true, true, true, true]);
const now = Date.now() / 1000;
is("one pipeline without a paid plan, more in a trial or on a plan", [pipelineLimit({ subscriptionActive: false, trialEnds: 0, tier: "creator" } as never, now), pipelineLimit({ subscriptionActive: true, trialEnds: now + 86_400, tier: "creator" } as never, now) > UNPAID_PIPELINES, Object.values(PIPELINES_BY_TIER).every((n) => n > UNPAID_PIPELINES), TRIAL_PIPELINES > UNPAID_PIPELINES], [1, true, true, true]);
const pipe = (id: string) => ({ id, name: `Pipe ${id}`, stages: [{ id: `${id.slice(0, 5)}o`, name: "Talking", kind: "open" }, { id: `${id.slice(0, 5)}w`, name: "Won", kind: "won" }, { id: `${id.slice(0, 5)}l`, name: "Lost", kind: "lost" }] });
const three = [pipe("aaaaaa"), pipe("bbbbbb"), pipe("cccccc")] as never;
const kept = changePipeline(three, { pipeline: { ...pipe("bbbbbb"), name: "Renamed" } }, null, new Map(), 1);
const added = changePipeline(three, { pipeline: pipe("dddddd") }, null, new Map(), 1);
is("past the limit, the pipelines a store has stay and can be edited; only adding is refused", [kept.ok, added.ok, !added.ok && added.error], [true, false, "pipeline_limit"]);

part("The answers, in both states");
const today = crmBeginnerQuestions(false, TRIAL_DAYS);
const later = crmBeginnerQuestions(true, TRIAL_DAYS);
is("three questions", today.map((x) => x.q), ["How do I record my first deal?", "How do I keep a detail about each person?", "Can I try deals and fields before paying?"]);
const deal = answer(today, "How do I record my first deal?");
is("a deal: who, the studio's words in order, no next-stage button", [deal.includes("the owner, or a teammate with the Admin or Support role"), /next stage|as the conversation/.test(deal), (() => { const k = [w.tool, w.newDeal, w.what, w.saveDeal, w.unloaded, w.reload].map((x) => deal.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })()], [true, false, true]);
is("a field: the studio's words in order", (() => { const f = answer(today, "How do I keep a detail about each person?"); const k = [w.fields, w.firstField, w.addField, w.kind, w.saveFields, w.buyers].map((x) => f.indexOf(`“${x}”`)); return k.every((x, i) => x >= 0 && (i === 0 || x > k[i - 1])); })(), true);
is("trying: the shared answer, and one pipeline without a plan", [answer(today, "Can I try deals and fields before paying?").startsWith(tryBeforePaying("People and deals", "your fields, deals and a pipeline", false, TRIAL_DAYS)), answer(today, "Can I try deals and fields before paying?").endsWith("Without a plan, you cannot add a pipeline to the one every store starts with; a plan has room for more."), answer(later, "Can I try deals and fields before paying?").endsWith("Without a plan, you cannot add a pipeline to the one every store starts with; a plan or its trial has room for more.")], [true, true, true]);
const all = [...today, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days", /\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), false);

part("On the people and deals page");
const topic = findPage("platform", "crm");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string; a: string }[] } | undefined;
is("its own Questions block, these questions only", [faq?.title, faq?.items.map((x) => x.q)], ["Questions about people and deals", today.map((x) => x.q)]);
const shared = [false, true].map((s) => tryBeforePaying("People and deals", "your fields, deals and a pipeline", s, TRIAL_DAYS)).join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).filter((b) => (b as { kind?: string }).kind !== "faq") });
is("no sentence of the answers said elsewhere on the page, or twice among them", [today, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
