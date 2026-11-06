/**
 * 239 [CF2], unit 1: "Move from [platform] to Marktmorgen" guides
 * (lib/migration-guides.ts, served at /platform/move-from-<platform> like the
 * existing ClickFunnels guide). Checked against the code, not against a plan:
 *
 *   - every line under "What comes across on its own" names an import that
 *     exists (lib/imports.ts IMPORT_LIMITS, the route's kinds, the studio's
 *     tab) and starts today on a store with no plan, so nothing promised is
 *     behind PLANS_ON_SALE; the members import and the email to past buyers,
 *     which need a paid plan, are never promised and are said to wait;
 *   - the figures are the code's own limits;
 *   - every source is the platform's own help center, with the date it was read;
 *   - the pages are out of the menu, in the sitemap, linked from the general
 *     moving page, and written in plain US English with no superiority claim.
 */
import { readFileSync } from "node:fs";
import { MIGRATION_GUIDES, MOVE_CAPABILITIES, type MoveCapability } from "@/lib/migration-guides";
import { IMPORT_LIMITS, startProblem } from "@/lib/imports";
import { SWITCHING_WORDS } from "@/lib/switching-faq";
import { findPage, type TopicPage } from "@/lib/site-pages";
import sitemap from "@/app/sitemap";
import { britishCopyHits } from "./us-english-source";
import { done, is, part } from "./check";

const flat = (s: string) => s.replace(/\s+/g, " ");
const route = flat(readFileSync("app/api/store/import/route.ts", "utf8"));
const studio = flat(readFileSync("app/studio/import/page.tsx", "utf8"));
const none = { sid: "s".repeat(32), catalog: { items: [] }, subscriptionActive: false, subscriptionId: null, trialEnds: 0, stripeAccountId: "", stripeChargesEnabled: false, tier: "creator" } as never;
const go = (kind: Parameters<typeof startProblem>[1], extra: Record<string, unknown>) => startProblem(none, kind, { expected: 5, ...extra } as never)?.reason ?? null;

part("Each capability is an import that exists and is on today");
const caps = Object.entries(MOVE_CAPABILITIES) as [MoveCapability, (typeof MOVE_CAPABILITIES)[MoveCapability]][];
is("three capabilities: the list, products and past buyers", caps.map(([, c]) => c.kind), ["contacts", "products", "purchases"]);
for (const [key, cap] of caps) {
  is(`${key}: the limit is the code's own`, cap.limit, IMPORT_LIMITS[cap.kind]);
  is(`${key}: the studio's tab is its own words`, (SWITCHING_WORDS.tabs as readonly string[]).includes(cap.tab), true);
  is(`${key}: the import route takes this kind`, /const KINDS = new Set<ImportKind>\(\[[^\]]*"/.test(route) && route.includes(`"${cap.kind}"`), true);
  is(`${key}: the studio's import page offers this kind`, studio.includes(`kind: "${cap.kind}"`), true);
  is(`${key}: starts on a store with no plan (not behind the sales flags)`, go(cap.kind, cap.start), null);
}
is("members and the email to past buyers wait for a paid plan, so neither is a capability", [go("members", { stopped: true }) !== null, go("purchases", { email: true }) !== null], [true, true]);

part("The guides");
is("unit 1: Gumroad and Teachable", MIGRATION_GUIDES.map((g) => g.slug), ["move-from-gumroad", "move-from-teachable"]);
const sources: Record<string, string> = { Gumroad: "help.gumroad.com", Teachable: "support.teachable.com" };
for (const guide of MIGRATION_GUIDES) {
  const page = findPage("platform", guide.slug) as TopicPage | undefined;
  const text = JSON.stringify(page);
  is(`${guide.platform}: published at /platform/${guide.slug}`, Boolean(page), true);
  is(`${guide.platform}: out of the menu`, page?.menu, undefined);
  is(`${guide.platform}: names the platform in its heading`, page?.title.includes(guide.platform), true);
  is(`${guide.platform}: read on a stated date`, guide.checked, "November 6, 2026");
  is(`${guide.platform}: every source is its own help center, over https`, guide.sources.length > 0 && guide.sources.every((s) => new URL(s.href).protocol === "https:" && new URL(s.href).host === sources[guide.platform]), true);
  is(`${guide.platform}: each source has a label that says where it leads`, guide.sources.every((s) => s.label.startsWith(`${guide.platform}'s help center:`)), true);
  is(`${guide.platform}: at least one automatic line, each a known capability`, guide.moves.length > 0 && guide.moves.every((m) => m.capability in MOVE_CAPABILITIES), true);
  is(`${guide.platform}: each automatic line carries its code limit`, guide.moves.every((m) => m.body.includes(MOVE_CAPABILITIES[m.capability].limit.toLocaleString("en-US"))), true);
  is(`${guide.platform}: nothing automatic promises an email to buyers or members`, guide.moves.some((m) => /\bemail(ed)? (to )?(each|every|your) (buyer|member)|members?\b/i.test(m.title + " " + m.body)), false);
  is(`${guide.platform}: says members and the buyer email wait for a paid plan`, guide.notMoved.some((x) => /members/i.test(x) && /paid plan/i.test(x)), true);
  is(`${guide.platform}: things to redo by hand`, guide.byHand.length > 0, true);
  const blocks = (page?.blocks ?? []).map((b) => `${b.kind}:${"title" in b ? b.title : ""}`);
  is(`${guide.platform}: the page's sections, in order`, blocks.slice(0, 6), [
    `how:How a move from ${guide.platform} works`,
    "features:What comes across on its own",
    "limits:What you redo by hand",
    "limits:What does not come across",
    "terms:Words on this page",
    `features:Where the ${guide.platform} steps come from`,
  ]);
  const cited = (page?.blocks ?? []).find((b) => b.kind === "features" && b.title.startsWith("Where the")) as { items: { title: string; href?: string }[] } | undefined;
  is(`${guide.platform}: the sources are linked by their own label`, cited?.items.map((i) => [i.title, i.href]), guide.sources.map((s) => [s.label, s.href]));
  is(`${guide.platform}: no superiority claim or competitor figure`, /\b(best|better|fastest|easiest|cheaper|only platform|#1|number one)\b|\$\d/i.test(text), false);
  is(`${guide.platform}: says it is not affiliated`, text.includes(`${guide.platform} is a trademark of its owner. Marktmorgen is not affiliated with it`), true);
  const prose = [page?.intro ?? "", ...(page?.blocks ?? []).flatMap((b) => ("items" in b ? (b.items as unknown[]).map((i) => (typeof i === "string" ? i : Object.values(i as object).filter((v) => typeof v === "string" && !String(v).startsWith("http") && !String(v).startsWith("/")).join(". "))) : []))].join(" ");
  const sentences = prose.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  is(`${guide.platform}: no sentence over 30 words`, sentences.filter((s) => words(s) > 30), []);
  is(`${guide.platform}: sentences average under 18 words`, sentences.reduce((n, s) => n + words(s), 0) / sentences.length < 18, true);
  is(`${guide.platform}: the general moving page links to it`, JSON.stringify(findPage("platform", "switching-to-marktmorgen")).includes(`"href":"/platform/${guide.slug}"`), true);
  is(`${guide.platform}: in the sitemap`, sitemap().some((e) => e.url.endsWith(`/platform/${guide.slug}`)), true);
}
is("ClickFunnels keeps its own existing guide, not a second one", MIGRATION_GUIDES.some((g) => g.platform === "ClickFunnels"), false);

part("US English");
is("no British spelling in the guides' source", britishCopyHits("lib/migration-guides.ts", readFileSync("lib/migration-guides.ts", "utf8")), []);

done();
