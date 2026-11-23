/**
 * The plan a creator is offered is named by PLAN_TITLES wherever it is chosen
 * (#4499, Codex X5; Claude 4 3Kc's LEVE on #5287): the public platform pages'
 * plan tag and the studio's card that starts a plan read PLAN_TITLES.pro, so
 * they say "Studio", as the pricing page and the two FAQs do, and never "Pro",
 * which stays the internal billing id. Checked on the source of the two
 * places, since the studio page needs a signed-in store to draw.
 */
import { readFileSync } from "node:fs";
import { PLAN_TITLES } from "@/lib/plan";
import { done, is } from "./check";

const topic = readFileSync("components/topic-page.tsx", "utf8");
const studio = readFileSync("app/studio/page.tsx", "utf8");
const from = studio.indexOf("{PRO_ON_SALE ? (");
const card = from < 0 ? "" : studio.slice(from, studio.indexOf("{/* Said, not sold", from));

is("the plan is called Studio, not Pro (the name these places read)", PLAN_TITLES.pro, "Studio");
is("the platform pages' plan tag reads PLAN_TITLES.pro, never a typed \"Pro\"", [/>Pro</.test(topic), topic.includes('tag tag-brand">{PLAN_TITLES.pro}<')], [false, true]);
is("the studio's start-a-plan card was found", card.length > 200, true);
is("the studio's start-a-plan card heads and labels the plan with PLAN_TITLES.pro, never a typed \"Pro\"", [/\bPro\b/.test(card.replace(/PLAN_TITLES\.pro/g, "")), (card.match(/PLAN_TITLES\.pro/g) ?? []).length >= 3], [false, true]);

done();
