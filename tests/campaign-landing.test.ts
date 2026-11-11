/**
 * 632 [AA2] (m), unit 1: a campaign's landing page is the product's sales
 * page with only the ad's checked words in place, nothing added, nothing cut.
 */
import { checkAdText, type AdContext, type AdText } from "@/lib/ad-creative-check";
import { CAMPAIGN_TAG, landingFrom, landingPage } from "@/lib/campaign-landing";
import { EMPTY_PAGE, MAX_HEADLINE, newBlockId, type PageBlock, type SalesPage } from "@/lib/sales-page";
import { done, is, part } from "./check";

const NOW = 1_793_700_000;
const context: AdContext = { priceCents: 4_900, currency: "usd", ownHosts: ["baker.example"], realDeadline: false, realStockLimit: false, verifiedReviews: [] };
const ad: AdText = { headline: "Bake bread you are proud of", text: "A video course on sourdough, from starter to loaf.", description: "", button: "See the course" };
const checked = checkAdText(ad, context);

const hero: PageBlock = { id: newBlockId(), kind: "hero", headline: "Sourdough at home", sub: "The course", media: "picture", video: null };
const text: PageBlock = { id: newBlockId(), kind: "text", heading: "What you learn", body: "Starters, shaping, baking." };
const cta: PageBlock = { id: newBlockId(), kind: "cta", label: "Buy now", note: "" };
const ahead: PageBlock = { id: newBlockId(), kind: "countdown", heading: "Doors close", until: NOW + 3_600, note: "" };
const gone: PageBlock = { id: newBlockId(), kind: "countdown", heading: "Launch price", until: NOW - 60, note: "" };
const page: SalesPage = { ...EMPTY_PAGE, blocks: [hero, text, ahead, gone, cta], test: { id: "t1" } as never, variant: { id: "v1" } as never };

part("Only words that passed the ad check, each fitting its place");
is("the ad passes the check", checked.sendable, true);
const made = landingFrom(ad, checked, "spring-bake");
is("the landing words", made.ok ? made.landing : null, { campaign: "spring-bake", headline: "Bake bread you are proud of", sub: "A video course on sourdough, from starter to loaf.", button: "See the course" });
const refused = checkAdText({ ...ad, headline: "Make $5,000 a month baking from home" }, context);
is("an ad the check refuses makes no page", [refused.sendable, landingFrom({ ...ad, headline: "Make $5,000 a month baking from home" }, refused, "spring-bake")], [false, { ok: false, error: "not_checked" }]);
is("a campaign name that is not a tag", landingFrom(ad, checked, "Spring Bake!"), { ok: false, error: "campaign" });
is("the tag is the numbers' own shape", [CAMPAIGN_TAG.test("spring-bake_2"), CAMPAIGN_TAG.test("x".repeat(41))], [true, false]);
const long = { ...ad, headline: "x".repeat(MAX_HEADLINE + 1) };
is("a headline too long is refused, never cut", landingFrom(long, checkAdText(long, context), "spring-bake"), { ok: false, error: "headline_long" });
is("no headline", landingFrom({ ...ad, headline: " " }, { ...checked }, "spring-bake"), { ok: false, error: "headline" });

part("The sales page, with the ad's words where a visitor reads first");
if (!made.ok) throw new Error("no landing");
const landed = landingPage(page, made.landing, NOW);
if (!landed.ok) throw new Error("no page");
const blocks = landed.page.blocks;
is("the top block says the ad's headline and line", [blocks[0].kind === "hero" && blocks[0].headline, blocks[0].kind === "hero" && blocks[0].sub], ["Bake bread you are proud of", "A video course on sourdough, from starter to loaf."]);
is("the button says the ad's words", blocks.find((b) => b.kind === "cta")?.kind === "cta" ? (blocks.find((b) => b.kind === "cta") as { label: string }).label : null, "See the course");
is("everything else is the page's own, in its order", blocks.map((b) => b.id), [hero.id, text.id, ahead.id, cta.id]);
is("a countdown already past is left out, one ahead is kept", [blocks.some((b) => b.id === gone.id), blocks.some((b) => b.id === ahead.id)], [false, true]);
is("nothing is added", blocks.length <= page.blocks.length, true);
is("no headline or page test runs on it", [landed.page.test, landed.page.variant], [null, null]);
is("the published page is untouched", [page.blocks[0].kind === "hero" && page.blocks[0].headline, page.blocks.length], ["Sourdough at home", 5]);
const keepButton = landingPage(page, { ...made.landing, button: "" }, NOW);
is("no button words keeps the page's own", keepButton.ok ? (keepButton.page.blocks.find((b) => b.kind === "cta") as { label: string }).label : null, "Buy now");
is("a page with no top block is refused", landingPage({ ...EMPTY_PAGE, blocks: [text, cta] }, made.landing, NOW), { ok: false, error: "no_hero" });

done();
