/**
 * 653 [WG13], unit 1: the studio gallery "Add to your store" (app/studio/add).
 *
 * Reads the studio's own folders, so a card that points at a screen that does
 * not exist fails here, and so does a studio screen with no card and no reason
 * why it has none (lib/studio-modules.ts, NOT_MODULES). Then the filter: the
 * same roles, deployment keys and plan the studio home reads. Then the markup,
 * for AX274 (WCAG 2.2 AAA): one h1, an h2 per group, a list of cards, each a
 * real link named by its module, 44px targets, nothing said by color alone.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CATEGORIES, NOT_MODULES, STUDIO_MODULES, galleryFor, type GalleryContext } from "@/lib/studio-modules";
import { AddGallery } from "@/components/add-gallery";
import { can, type Role } from "@/lib/team-roles";
import { done, is, part } from "./check";

const root = process.cwd();
const studio = join(root, "app/studio");
const href = (segment: string) => `/studio/${segment}?store=s1`;
const PLAN_HREF = "/studio?store=s1#billing";

/** Every folder of the studio that draws a page of its own. */
const screens = readdirSync(studio)
  .filter((name) => statSync(join(studio, name)).isDirectory() && existsSync(join(studio, name, "page.tsx")))
  .sort();

part("every card opens a screen that exists");
for (const entry of STUDIO_MODULES) {
  is(`${entry.id}: app/studio/${entry.segment}/page.tsx exists`, existsSync(join(studio, entry.segment, "page.tsx")), true);
}
is("no card points at the gallery itself", STUDIO_MODULES.some((entry) => entry.segment === "add"), false);

part("every studio screen has a card or a reason");
const carded = new Set(STUDIO_MODULES.map((entry) => entry.segment));
const reasoned = new Set(Object.keys(NOT_MODULES));
for (const name of screens.filter((name) => name !== "add")) {
  is(`${name}: has a card or is in NOT_MODULES`, carded.has(name) || reasoned.has(name), true);
  is(`${name}: not both a card and in NOT_MODULES`, carded.has(name) && reasoned.has(name), false);
}
is("the gallery itself is neither a card nor in NOT_MODULES", carded.has("add") || reasoned.has("add"), false);
for (const [name, reason] of Object.entries(NOT_MODULES)) {
  is(`NOT_MODULES ${name}: names a screen that exists`, existsSync(join(studio, name, "page.tsx")), true);
  is(`NOT_MODULES ${name}: one line of reason`, reason.trim().length > 10 && !reason.includes("\n"), true);
}

part("each card asks for what its screen asks for");
// The screen's own studioView(..., need): a card is never shown to a role the screen would send away.
for (const entry of STUDIO_MODULES) {
  const source = readFileSync(join(studio, entry.segment, "page.tsx"), "utf8");
  const need = /studioView\([^;]*?,\s*"([a-z]+)"/.exec(source)?.[1] ?? null;
  is(`${entry.id}: permission is the screen's own (${need})`, entry.permission, need);
}

part("the registry reads well");
is("ids are unique", new Set(STUDIO_MODULES.map((entry) => entry.id)).size, STUDIO_MODULES.length);
is("five groups, in order", CATEGORIES.map((c) => c.title), ["Sell", "Teach", "Community", "Grow", "Connect"]);
for (const category of CATEGORIES) {
  is(`${category.title}: at least one card`, STUDIO_MODULES.some((entry) => entry.category === category.id), true);
}
const BOASTS = /\b(best|most|#1|number one|fastest|guarantee[ds]?|ultimate|unlimited|soon|coming)\b|#1/i;
for (const entry of STUDIO_MODULES) {
  is(`${entry.id}: a title`, entry.title.trim().length > 0, true);
  is(`${entry.id}: one sentence, ending in a period`, /^[A-Z][^.!?]*\.$/.test(entry.text), true);
  is(`${entry.id}: no percent`, entry.text.includes("%"), false);
  is(`${entry.id}: no boast or promise`, BOASTS.test(entry.text) || BOASTS.test(entry.title), false);
  is(`${entry.id}: short enough to read at a glance`, entry.text.split(/\s+/).length <= 20, true);
}

part("filtering: the same conditions as the studio home");
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
const cards = (ctx: GalleryContext) => galleryFor(ctx, href).flatMap((section) => section.cards);
const ids = (ctx: GalleryContext) => cards(ctx).map((card) => card.id);

const owner = cards(context("owner"));
is("the owner with everything on sees every card", owner.length, STUDIO_MODULES.length);
is("every owner card opens its own editor", owner.every((card) => card.state === "open" && card.href === href(STUDIO_MODULES.find((m) => m.id === card.id)!.segment)), true);

const support = ids(context("support"));
for (const entry of STUDIO_MODULES) {
  const allowed = entry.permission === "member" || can("support", entry.permission);
  is(`support: ${entry.id} ${allowed ? "shown" : "hidden"}`, support.includes(entry.id), allowed);
}
is("support: no Sales pages (products)", support.includes("pages"), false);
is("support: Inbox (orders) is there", support.includes("inbox"), true);
is("editor: no Affiliates (settings)", ids(context("editor")).includes("affiliates"), false);

is("Discord absent without Discord's keys", ids(context("owner", { has: { ...everything, discord: false } })).includes("discord"), false);
is("Discord there with them", ids(context("owner")).includes("discord"), true);
is("Video calls absent without a meeting app", ids(context("owner", { has: { ...everything, meet: false } })).includes("meetings"), false);
is("Your calendar absent with no calls sold", ids(context("owner", { has: { ...everything, calls: false } })).includes("calendar"), false);
is("Membership numbers absent with no memberships", ids(context("owner", { has: { ...everything, memberships: false } })).includes("memberships"), false);
is("Email absent while Pro is not on sale", ids(context("owner", { has: { ...everything, proOnSale: false } })).includes("email"), false);

const gated = cards(context("owner", { pro: false })).find((card) => card.id === "email");
is("off the Studio plan, Email is still listed", Boolean(gated), true);
is("…as needing the plan", gated?.state, "plan");
is("…named by the plan's title", gated?.state === "plan" ? gated.plan : null, "Studio");
is("…with the way to the plan page, not to the editor", gated?.href, PLAN_HREF);
const noBilling = cards(context("editor", { pro: false, planHref: null })).find((card) => card.id === "email");
is("a role that may not change the plan: no link at all", noBilling?.href, null);
is("…and says who chooses the plan", noBilling?.state === "plan" ? noBilling.note : null, "The store's owner chooses its plan.");
const notReady = cards(context("owner", { pro: false, planHref: null })).find((card) => card.id === "email");
is("billing not set up here: no link, said plainly", notReady?.state === "plan" ? [notReady.href, notReady.note] : null, [null, "Paid plans are not on sale yet."]);
// Claude 3 on #2727: "not on sale" only while paid plans are not on sale (lib/opening.ts PLANS_ON_SALE), as the FAQs say it.
const onSaleNoBilling = cards(context("owner", { pro: false, planHref: null, onSale: true })).find((card) => card.id === "email");
is("plans on sale but billing not set up here: never \"not on sale\"", onSaleNoBilling?.state === "plan" ? [onSaleNoBilling.href, onSaleNoBilling.note] : null, [null, "The plan can't be changed from here right now."]);
is("empty groups are left out", galleryFor(context("support"), href).every((section) => section.cards.length > 0), true);

part("the page as drawn");
const render = (ctx: GalleryContext) =>
  renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(AddGallery, { sections: galleryFor(ctx, href) })),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const html = render(context("owner"));
const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => text(m[1]));
is("one h1, \"Add to your store\"", h1s, ["Add to your store"]);
const h2s = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]));
is("an h2 per group", h2s, CATEGORIES.map((c) => c.title));
is("a list per group", (html.match(/<ul\b/g) ?? []).length, CATEGORIES.length);
is("a list item per card", (html.match(/<li\b/g) ?? []).length, STUDIO_MODULES.length);
const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], name: text(m[2]), href: /href="([^"]*)"/.exec(m[1])?.[1] ?? "" }));
is("a link per card", links.length, STUDIO_MODULES.length);
for (const entry of STUDIO_MODULES) {
  const link = links.find((l) => l.href === href(entry.segment).replace(/&/g, "&amp;"));
  is(`${entry.id}: a real link to its editor`, Boolean(link), true);
  is(`${entry.id}: the link is named by the module`, link?.name, entry.title);
  is(`${entry.id}: its sentence is on the page`, text(html).includes(entry.text), true);
}
is("no link says only Open or Click here", links.some((l) => /^(open|click here|more|go)$/i.test(l.name)), false);
is("every link is at least 44px tall (min-h-11)", links.every((l) => /\bmin-h-11\b/.test(l.attrs)), true);
is("no button without an action", /<button\b/.test(html), false);
is("every icon is hidden from screen readers", [...html.matchAll(/<svg\b[^>]*>/g)].every((m) => m[0].includes('aria-hidden="true"')), true);
is("no motion", /\b(animate-|transition|translate-)/.test(html), false);

const gatedHtml = render(context("owner", { pro: false }));
const gatedText = text(gatedHtml);
is("the plan need is said in words, not by color", gatedText.includes("Needs the Studio plan"), true);
const planLink = [...gatedHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((m) => m[1].includes(`href="${PLAN_HREF}"`));
is("…with a link to the plan page", Boolean(planLink), true);
is("…named by what it opens, for which module", planLink ? text(planLink[2]) : null, "See the Studio plan for Email");
is("…and no link to the Email editor", gatedHtml.includes(`href="${href("email")}"`), false);
const editorHtml = render(context("editor", { pro: false, planHref: null }));
is("no plan link for a role that may not change the plan", editorHtml.includes("#billing"), false);
is("…who is told who chooses it", text(editorHtml).includes("The store's owner chooses its plan."), true);

part("the page itself");
const page = existsSync(join(studio, "add/page.tsx")) ? readFileSync(join(studio, "add/page.tsx"), "utf8") : "";
is("app/studio/add/page.tsx exists", page.length > 0, true);
is("it resolves the store with studioView, open to anyone on the team", /studioView\([^;]*?,\s*"member"/.test(page), true);
is("it builds each link with studioPath(store, \"\", segment)", /studioPath\(store, "", /.test(page), true);
is("it reads the same deployment switches as the studio home", ["isDiscordConfigured()", "configuredProviders()", "sellsMemberships(store)", "PRO_ON_SALE", "isBillingConfigured()"].every((needle) => page.includes(needle)), true);

done();
