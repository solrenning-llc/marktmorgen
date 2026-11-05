/**
 * A larger plan is offered only to a store that can have one (534 [FQ1],
 * unit 41; added 2 November 2026): while plans are on sale, to a store that
 * pays for its plan, with a plan above its own sold (lib/larger-plan.ts). The
 * words for a full data room, the pipelines, the saved sections, funnel
 * sharing, the usage emails, the store checkup, Path and the public pages
 * offered one to every store, though there is none above Scale and none is
 * sold while PLANS_ON_SALE is false. Checked: the rule itself; the words with
 * and without one; every sentence in the site's code that offers a larger
 * plan sits behind that condition, the terms aside (legal text left to the
 * owner, recorded in the queue); and funnel sharing no longer says "this
 * month … your next billing month" to a trial or a store without a plan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { largerPlanFor, planAboveSold } from "@/lib/larger-plan";
import { dataFullWords } from "@/lib/store-data-rules";
import { WRITE_ERRORS } from "@/lib/api-write";
import { limitsCheck } from "@/lib/checkup-rules";
import { pathPlanLine } from "@/lib/path-plan";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const paid = { subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
const now = 2_000_000_000;

part("Who can be offered a larger plan");
is("a plan above each one, while Pro is sold", [planAboveSold("creator", true), planAboveSold("pro", true), planAboveSold("scale", true), planAboveSold(undefined, true)], [true, true, false, true]);
is("none while Pro is not sold: the switch then takes only the Store plan", [planAboveSold("creator", false), planAboveSold("pro", false), planAboveSold("scale", false)], [false, false, false]);
is("only a paying store, only while plans are on sale", [
  largerPlanFor({ ...paid, tier: "pro" }, now, true, true),
  largerPlanFor({ ...paid, tier: "pro" }, now, false, true),
  largerPlanFor({ ...paid, tier: "pro" }, now, true, false),
  largerPlanFor({ ...paid, tier: "scale" }, now, true, true),
  largerPlanFor({ ...paid, tier: "pro", trialEnds: now + 60 }, now, true, true),
  largerPlanFor({ subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" }, now, true, true),
  largerPlanFor({ subscriptionActive: false, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "2026-10-01", tier: "pro" }, now, true, true),
], [true, false, false, false, false, false, false]);

part("The words, with and without one");
is("the full data room", [dataFullWords(10, 10, true).endsWith("pages or contacts, or move to a larger plan."), dataFullWords(10, 10).endsWith("pages or contacts."), dataFullWords(10, 10).includes("larger plan")], [true, true, false]);
is("a write refused through the API offers none (it is not told which store)", WRITE_ERRORS.store_full[1].includes("larger plan"), false);
const reading = [{ kind: "studio" as const, used: 10, figure: 10 }];
is("the checkup: a larger plan, a plan, or nothing for a paying store with none above it", [limitsCheck(reading, "", true, true, true).fix, limitsCheck(reading, "", false, true, false).fix, limitsCheck(reading, "", true, true, false).fix].map((f) => (f && "label" in f ? f.label : f)), ["See a larger plan", "Start a plan", undefined]);
is("Path, and no plan offered by default", [pathPlanLine(900, 1000)?.includes("plan"), limitsCheck(reading, "", true).fix, pathPlanLine(900, 1000, true)?.endsWith("Review plans if you need more room."), pathPlanLine(900, 1000, false)?.includes("plan")], [false, undefined, true, false]);

part("Every sentence that offers one, behind the condition");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : []; });
// A comment is not a sentence anyone reads; the terms are legal text, left to the owner (docs/codex-queue.md, 534 [FQ1], unit 41); lib/mail.ts speaks of the email sender's own plan, to the owner.
const ALLOWED = ["app/terms/page.tsx", "lib/mail.ts"];
const CONDITION = /largerOnSale|largerPlanFor|larger \?|PRO_ON_SALE \?|PLANS_ON_SALE(?: && PRO_ON_SALE)? \?|plansOnSale && standing === "paid" && larger|where a larger plan is on sale/;
const offers = ["app", "components", "lib"].flatMap(walk).filter((f) => !ALLOWED.includes(f)).flatMap((f) => read(f).split("\n").map((line, i) => ({ f, i: i + 1, line })))
  .filter(({ line }) => /larger plan/i.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line) && !/label: paying \? "See a larger plan"/.test(line))
  .filter(({ line }) => !CONDITION.test(line)).map(({ f, i }) => `${f}:${i}`);
const seen = ["app", "components", "lib"].flatMap(walk).filter((f) => !ALLOWED.includes(f) && read(f).split("\n").some((line) => /larger plan/i.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line))).length;
is("none unconditional, among the files that offer one", [seen >= 6, offers], [true, []]);

part("Where the store is known, the store decides");
const flat = (f: string) => read(f).replace(/\s+/g, " ");
is("a full data room on the server, the usage emails, the checkup and Path ask the store", [
  flat("lib/store-data.ts").includes("dataFullWords(used, room, largerPlanFor(store, nowSeconds))"),
  (flat("app/api/cron/usage/route.ts").match(/\.\.\.\(largerPlanFor\(store\) \? \["Moving to a larger plan opens them at once\."\] : \[\]\)/g) ?? []).length,
  flat("lib/checkup.ts").includes('planAboveSold(store.tier ?? "creator")'),
  flat("app/studio/path/page.tsx").includes("const larger=largerPlanFor(store,now/1000);"),
  flat("app/studio/page.tsx").includes("const largerOnSale = PLANS_ON_SALE && planAboveSold(tier);"),
], [true, 2, true, true, true]);

part("Funnel sharing's figures");
const share = read("components/funnel-share-panel.tsx");
is("no month or billing month said to a store whose window is a trial or the calendar", /this month as your plan allows|next billing month/.test(share), false);
is("no plan named where the store's own figure is meant", /your plan (allows|brings)/.test(share + read("components/saved-sections.tsx")), false);

done();
