/**
 * The $449 plan by one name (issue #4314, creator funnel, Claude 1, 12/11/2026). Found by walking main as a new creator:
 * the signup page lists "Store: $69 a month, Studio: $449 a month, Scale: $999 a month" (PLAN_TITLES, the
 * owner's names since #434), and the studio the creator lands in then spoke of a plan called "Pro" that
 * appears nowhere else: "What is not switched on here yet: Your own domain, on Pro", "On Pro." under
 * "Take Made with Marktmorgen off the foot of my page", a "Pro" tag on the
 * Email tile and on the Email and domain cards, "Part of Pro, at $449 a month", and on /studio/email "Part
 * of Pro … When plans open, Pro is $449 a month". "Pro" stays the billing identity (PLAN_NAMES, "Marktmorgen
 * Pro", the name on Stripe's invoice), not what a creator reads while choosing.
 */
import { readFileSync } from "node:fs";
import { PLAN_TITLES } from "@/lib/plan";
import { done, is, part } from "./check";

/** The source with its comments taken out, so only what is drawn or said is read. */
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** "Pro" as a word a person reads, not inside an identifier (hasPro, PRO_ON_SALE) or the tier key "pro". */
const proWords = (text: string) => text.match(/(?<![\w$.])Pro(?![\w])/g) ?? [];

part("The name");
is("the signup page's middle plan is Studio", PLAN_TITLES.pro, "Studio");

part("The studio home a new creator lands on");
const studio = code("app/studio/page.tsx");
const between = (from: string, to: string) => studio.slice(studio.indexOf(from), studio.indexOf(to, studio.indexOf(from)));
const notYet = between("const NEXT_WHEN_SELLING", "\n");
const emailTile = between('href: studioPath(store, "", "email")', "}]");
const domainCard = between('<div id="domain"', "{PRO_ON_SALE && may(\"draft\") ? (");
const emailCard = between("{PRO_ON_SALE && may(\"draft\") ? (", "</Link>");
is("each part is found", [notYet.length > 0, emailTile.length > 0, domainCard.length > 200, emailCard.length > 200], [true, true, true, true]);
is("no plan called Pro in what is not switched on yet, the Email tile, the domain card or the email card", [proWords(notYet), proWords(emailTile), proWords(domainCard), proWords(emailCard)], [[], [], [], []]);
is("each names the plan from PLAN_TITLES", [notYet.includes("${PLAN_TITLES.pro} plan"), emailTile.includes("${PLAN_TITLES.pro} plan"), domainCard.includes("${PLAN_TITLES.pro} plan"), emailCard.includes("${PLAN_TITLES.pro} plan")], [true, true, true, true]);

part("The tile that carries the tag");
is("its tag can go under the icon on a narrow tile instead of running past it", readFileSync("components/studio-tools.tsx", "utf8").includes('<span className="flex flex-wrap items-center justify-between gap-2">'), true);

part("The look editor's line about our name on the page");
const look = code("components/look-editor.tsx");
const badge = look.slice(look.indexOf("Take &ldquo;Made with Marktmorgen&rdquo;"), look.indexOf("</fieldset>", look.indexOf("Take &ldquo;Made with Marktmorgen&rdquo;")));
is("no plan called Pro, the plan named from PLAN_TITLES", [badge.length > 100, proWords(badge), (badge.match(/\$\{PLAN_TITLES\.pro\} plan/g) ?? []).length], [true, [], 2]);

part("The Email page before the plan");
const email = code("app/studio/email/page.tsx");
is("no plan called Pro anywhere on it", proWords(email), []);
is("the plan block names it from PLAN_TITLES", (email.match(/\$\{PLAN_TITLES\.pro\} plan/g) ?? []).length >= 7, true);

done();
