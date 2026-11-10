/**
 * 486 [IT3], unit 1: the rules of the studio's search of actions, "What do
 * you want to do?" (lib/studio-actions.ts). No screen yet; the search box is
 * the next unit.
 *
 * Reads the studio's own folders, so an action that points at a screen that
 * does not exist fails here, and so does a studio screen with no action and
 * no reason why it has none (NOT_ACTIONS). Each action asks for the
 * permission its screen asks studioView for; an action on the studio home
 * names a section the home really draws, under that permission alone. Then
 * the words: typos, plurals and other words for the same thing find the
 * right action; a role never sees an action its screen would send it away
 * from; the recent list orders the results and survives nothing it did not
 * write.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_QUERY_CHARS,
  MAX_RECENT,
  MAX_RESULTS,
  NOT_ACTIONS,
  STUDIO_ACTIONS,
  editDistance,
  readRecent,
  rememberAction,
  searchActions,
  singular,
  termsOf,
  type ActionResult,
} from "@/lib/studio-actions";
import { STUDIO_MODULES, type GalleryContext } from "@/lib/studio-modules";
import { can, type Role } from "@/lib/team-roles";
import { done, is, part } from "./check";

const root = process.cwd();
const studio = join(root, "app/studio");
const href = (segment: string) => (segment ? `/studio/${segment}?store=s1` : "/studio?store=s1");
const PLAN_HREF = "/studio?store=s1#billing";

const screens = readdirSync(studio)
  .filter((name) => statSync(join(studio, name)).isDirectory() && existsSync(join(studio, name, "page.tsx")))
  .sort();

part("every action opens a screen that exists");
for (const action of STUDIO_ACTIONS) {
  const file = action.segment ? join(studio, action.segment, "page.tsx") : join(studio, "page.tsx");
  is(`${action.id}: ${action.segment ? `app/studio/${action.segment}` : "the studio home"} exists`, existsSync(file), true);
  is(`${action.id}: the home's actions name a section, the others none`, Boolean(action.anchor), action.segment === "");
}

part("every studio screen has an action or a reason");
const acted = new Set(STUDIO_ACTIONS.map((action) => action.segment).filter(Boolean));
const reasoned = new Set(Object.keys(NOT_ACTIONS));
for (const name of screens) {
  is(`${name}: has an action or is in NOT_ACTIONS`, acted.has(name) || reasoned.has(name), true);
  is(`${name}: not both an action and in NOT_ACTIONS`, acted.has(name) && reasoned.has(name), false);
}
for (const [name, reason] of Object.entries(NOT_ACTIONS)) {
  is(`NOT_ACTIONS ${name}: names a screen that exists`, existsSync(join(studio, name, "page.tsx")), true);
  is(`NOT_ACTIONS ${name}: one line of reason`, reason.trim().length > 10 && !reason.includes("\n"), true);
}

part("each action asks for what its screen asks for");
for (const action of STUDIO_ACTIONS.filter((entry) => entry.segment)) {
  const source = readFileSync(join(studio, action.segment, "page.tsx"), "utf8");
  const need = /studioView\([^;]*?,\s*"([a-z]+)"/.exec(source)?.[1] ?? null;
  is(`${action.id}: permission is the screen's own (${need})`, action.permission, need);
  const module = STUDIO_MODULES.find((entry) => entry.segment === action.segment);
  if (module) is(`${action.id}: the same permission as its card in the gallery`, action.permission, module.permission);
}

part("each action on the home scrolls to a section the home draws, under its permission alone");
const home = readFileSync(join(studio, "page.tsx"), "utf8").split("\n");
const componentsDir = join(root, "components");
const componentFiles = readdirSync(componentsDir).filter((name) => name.endsWith(".tsx"));
/** The condition of the `{… ? (` block a line sits in, read up to six lines back; null when the block before it ended first. */
function gateAt(at: number): string | null {
  for (let i = at; i >= Math.max(0, at - 6); i--) {
    const line = home[i].trim();
    const gate = /^\{(.+?) \? [(<]/.exec(line);
    if (gate) return gate[1];
    if (i < at && (/^\) : null\}$/.test(line) || /^<\/(div|section)>$/.test(line))) return null;
  }
  return null;
}
for (const action of STUDIO_ACTIONS.filter((entry) => entry.anchor)) {
  const marker = `id="${action.anchor}"`;
  let at = home.findIndex((line) => line.includes(marker));
  let where = "app/studio/page.tsx";
  if (at === -1) {
    // A section drawn by a component: the home's line that draws it.
    const file = componentFiles.find((name) => readFileSync(join(componentsDir, name), "utf8").includes(marker));
    const name = file ? /export function ([A-Z][A-Za-z]+)/.exec(readFileSync(join(componentsDir, file), "utf8"))?.[1] : undefined;
    at = name ? home.findIndex((line) => line.trim().startsWith(`<${name}`)) : -1;
    where = file ? `components/${file}, drawn by the home` : "nowhere";
  }
  is(`${action.id}: #${action.anchor} is drawn (${where})`, at >= 0, true);
  if (at < 0) continue;
  is(`${action.id}: drawn under ${action.permission === "member" ? "no condition" : `may("${action.permission}") alone`}`, gateAt(at), action.permission === "member" ? null : `may("${action.permission}")`);
}

part("the list reads well");
is("ids are unique", new Set(STUDIO_ACTIONS.map((action) => action.id)).size, STUDIO_ACTIONS.length);
const BOASTS = /\b(best|most|#1|fastest|guarantee[ds]?|ultimate|unlimited|soon|coming|instantly)\b/i;
for (const action of STUDIO_ACTIONS) {
  is(`${action.id}: a title starting with a capital, no period`, /^[A-Z][^.!?]*[^.!?\s]$/.test(action.title), true);
  is(`${action.id}: short enough to read at a glance`, action.title.split(/\s+/).length <= 9, true);
  is(`${action.id}: no boast or promise`, BOASTS.test(action.title), false);
  is(`${action.id}: some other words people type`, action.words.length >= 3, true);
  is(`${action.id}: words are plain lower case`, action.words.every((word) => /^[a-z0-9][a-z0-9 ]*[a-z0-9]$|^[a-z0-9]$/.test(word)), true);
}

part("words: typos, plurals and other words for the same thing");
const everything = { discord: true, meet: true, memberships: true, calls: true, proOnSale: true };
const context = (role: Role, over: Partial<GalleryContext> = {}): GalleryContext => ({
  may: (permission) => can(role, permission),
  has: { ...everything },
  pro: true,
  planHref: PLAN_HREF,
  billing: can(role, "billing"),
  onSale: false,
  ...over,
});
const owner = context("owner");
const ids = (query: string, ctx: GalleryContext = owner, recent: readonly string[] = []) => searchActions(query, ctx, href, recent).map((result) => result.id);
const first = (query: string, ctx: GalleryContext = owner) => ids(query, ctx)[0] ?? null;

is("plurals fold: emails", singular("emails"), "email");
is("plurals fold: categories", singular("categories"), "category");
is("plurals fold: boxes", singular("boxes"), "box");
is("a double s stays: class", singular("class"), "class");
is("a short word stays: bus", singular("bus"), "bus");
is("small words are left out", termsOf("How do I send an email?"), ["send", "email"]);
is("accents and case fold", termsOf("Résumé PRICE"), ["resume", "price"]);
is("a swap of two letters is one", editDistance("refnud", "refund"), 1);
is("a dropped letter is one", editDistance("refnd", "refund"), 1);

is("\"send email\" opens Email", first("send email"), "email");
is("\"emails\" (plural) opens Email", first("emails"), "email");
is("\"newsletter\" (another word) finds Email", ids("newsletter").includes("email"), true);
is("\"change price\" opens products", first("change price"), "products");
is("\"pricing\" opens products", first("pricing"), "products");
is("\"discount\" (another word for a sale) opens the store sale", first("discount"), "sale");
is("\"refund\" finds the plan's refund", ids("refund").includes("refund"), true);
is("\"refund\" finds the buyers, where refunds show", ids("refund").includes("people"), true);
is("\"refnd\" (a typo) still finds the refund", ids("refnd").includes("refund"), true);
is("\"afiliate\" (a typo) opens Affiliates", first("afiliate"), "affiliates");
is("\"affiliates\" (plural) opens Affiliates", first("affiliates"), "affiliates");
is("\"invoice\" opens Payment requests", first("invoice"), "requests");
is("\"zoom\" opens video calls", first("zoom"), "meetings");
is("\"move from gumroad\" opens the import", first("move from gumroad"), "import");
is("\"tax\" opens the tax report", first("tax"), "tax");
is("\"two step\" opens how you sign in", first("two step"), "account");
is("\"something is not working\" opens the checkup", first("something is not working"), "checkup");
is("\"refu\" (the start of a word) finds the refund", ids("refu").includes("refund"), true);
is("an exact word ranks above a near miss: \"post\" is the blog first", first("post"), "blog");
is("every typed word must fit: \"refund zebra\" finds nothing", ids("refund zebra"), []);
is("nothing fits: \"zzzz\"", ids("zzzz"), []);
is("a three-letter typo is not guessed: \"tez\"", ids("tez"), []);
is("only small words: nothing", ids("how do I"), []);
is("at most MAX_RESULTS results", ids("e").length <= MAX_RESULTS, true);
is("past MAX_QUERY_CHARS, the rest is ignored", ids(`${"x ".repeat(MAX_QUERY_CHARS / 2)}email`), []);

part("roles and conditions: the same as the gallery");
for (const role of ["owner", "admin", "editor", "support"] as const) {
  const ctx = context(role);
  for (const action of STUDIO_ACTIONS) {
    const shown = searchActions(action.title, ctx, href).some((result) => result.id === action.id);
    const module = STUDIO_MODULES.find((entry) => entry.segment === action.segment);
    const allowed = (action.permission === "member" || can(role, action.permission)) && (module?.when ? everything[module.when] : true);
    is(`${role}: ${action.id} ${allowed ? "found" : "never found"}`, shown, allowed);
  }
}
is("support: no plan refund (billing)", ids("refund", context("support")).includes("refund"), false);
is("support: buyers still found for \"refund\" (orders)", ids("refund", context("support")).includes("people"), true);
is("Discord never found without Discord's keys", ids("discord", context("owner", { has: { ...everything, discord: false } })), []);
is("video calls never found without a meeting app", ids("zoom", context("owner", { has: { ...everything, meet: false } })).includes("meetings"), false);

const emailOffPlan = searchActions("send email", context("owner", { pro: false }), href).find((result) => result.id === "email");
is("off the Studio plan, Email is found as needing the plan", emailOffPlan?.plan, "Studio");
is("…and goes to the plan page, not to the editor", emailOffPlan?.href, PLAN_HREF);
is("a role that may not change the plan: no Email result at all", ids("send email", context("editor", { pro: false, planHref: null })).includes("email"), false);

part("links");
const result = (query: string): ActionResult | undefined => searchActions(query, owner, href)[0];
is("a screen of its own: its own address", result("invoice")?.href, "/studio/requests?store=s1");
is("a section of the home: the home and the section", result("change price")?.href, "/studio?store=s1#products");
is("a result has no plan when the plan includes it", result("invoice")?.plan, null);

part("recent actions: order only, and only what this list wrote");
is("no words: the recent ones, most recent first", ids("", owner, ["tax", "email"]), ["tax", "email"]);
is("no words and nothing recent: nothing", ids("", owner, []), []);
is("recent breaks a tie: \"refund\" with the buyers opened last", ids("refund", owner, ["people"])[0], "people");
is("recent never lifts a worse fit above a better one", ids("post", owner, ["community"])[0], "blog");
is("no words: a recent action the role may not open is left out", ids("", context("support"), ["tax", "inbox"]), ["inbox"]);
is("remember puts it first", rememberAction(["tax", "email"], "email"), ["email", "tax"]);
is("remember keeps at most MAX_RECENT", rememberAction(["tax", "email", "blog", "forms", "reviews"], "inbox").length, MAX_RECENT);
is("remember ignores an unknown id", rememberAction(["tax"], "nope"), ["tax"]);
is("a kept list reads back", readRecent(JSON.stringify(["tax", "email"])), ["tax", "email"]);
is("a broken kept value reads as none", readRecent("{not json"), []);
is("a kept object reads as none", readRecent(JSON.stringify({ 0: "tax" })), []);
is("unknown ids and repeats are dropped", readRecent(["tax", "constructor", "tax", 3, "email"]), ["tax", "email"]);
is("null reads as none", readRecent(null), []);

done();
