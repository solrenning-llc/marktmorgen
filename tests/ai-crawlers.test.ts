/**
 * 601 [KB22] U8 (docs/reviews/c5-kb22-audit.md): the creator chooses whether
 * AI crawlers are asked to stay out of the store on its own domain.
 *
 * Checked:
 *   - the list of AI crawlers is dated, each name with its maker's page and
 *     whether that page was read on the list's date; no ordinary search
 *     engine (Googlebot, Bingbot, Applebot, ...) and never "*";
 *   - by default a store's robots.txt is byte for byte what it was before;
 *   - the stored choice is read exactly: a record from before the switch is
 *     open, "open" is open, anything else is closed (never exposes what the
 *     creator closed);
 *   - closed: one "Disallow: /" group per named AI crawler, the group for
 *     every other crawler (search engines) unchanged, the map still named;
 *     a suspended store still shuts everyone out;
 *   - the route a creator's domain is served /robots.txt from (proxy.ts)
 *     answers with the closed rules;
 *   - the studio route: only an exact boolean is taken, the choice is kept,
 *     a second same choice writes nothing;
 *   - the studio says what it really does: it asks, it cannot promise,
 *     search engines are not asked, the marktmorgen.com address is not
 *     covered, and a change can take a day to reach crawlers.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAiCrawlers, storeForEmail, type Store } from "@/lib/store";
import { AI_CRAWLERS, AI_CRAWLERS_LISTED, parseAiCrawlers } from "@/lib/ai-crawlers";
import { storeRobots } from "@/lib/store-sitemap";
import { searchCheck, agentsGet, AGENTS_GET } from "@/lib/store-search-check";
import { StoreSearchCheck } from "@/components/store-search-check";
import { AiCrawlersSwitch, AI_CRAWLERS_WORDS } from "@/components/ai-crawlers-switch";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as aiCrawlersRoute } from "@/app/api/store/ai-crawlers/route";
import { GET as storeRobotsRoute } from "@/app/[handle]/store-robots/route";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** storeRobots for an open store as it was before 601 [KB22] U8, byte for byte. */
const before = (root: string) =>
  ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /orders", "Disallow: /manage", "Disallow: /thanks", "Disallow: /course", "Disallow: /community", "", `Sitemap: ${root}/sitemap.xml`, ""].join("\n");

/** The key the store's own record is kept under, found by its handle. */
async function storeKey(handle: string): Promise<string> {
  for (const key of redis.keys().filter((k) => k.startsWith("nl:store:"))) {
    const [value] = (await redis.pipeline([["GET", key]])) as unknown[];
    if (typeof value === "string" && value.startsWith("{") && (JSON.parse(value) as { handle?: string }).handle === handle) return key;
  }
  throw new Error("no store record");
}
const rawOf = async (key: string) => String(((await redis.pipeline([["GET", key]])) as unknown[])[0]);

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("The dated list of AI crawlers");
  is("dated", /^\d{4}-\d{2}-\d{2}$/.test(AI_CRAWLERS_LISTED), true);
  is("each name is a robots.txt token, named once", [
    AI_CRAWLERS.every((c) => /^[A-Za-z][A-Za-z0-9-]*$/.test(c.agent)),
    new Set(AI_CRAWLERS.map((c) => c.agent.toLowerCase())).size === AI_CRAWLERS.length,
  ], [true, true]);
  is("each with its maker and its maker's https page", AI_CRAWLERS.every((c) => c.maker.length > 0 && /^https:\/\/[a-z0-9.-]+\//.test(c.source)), true);
  is("each says whether that page was read on the list's date, and why not when it was not", AI_CRAWLERS.every((c) => (c.read === AI_CRAWLERS_LISTED ? c.unread === "" : c.read === null && c.unread.length > 0)), true);
  is("Anthropic's three, read on the list's date", ["ClaudeBot", "Claude-User", "Claude-SearchBot"].map((a) => AI_CRAWLERS.find((c) => c.agent === a)?.read), [AI_CRAWLERS_LISTED, AI_CRAWLERS_LISTED, AI_CRAWLERS_LISTED]);
  is("no ordinary search engine and never every crawler", AI_CRAWLERS.some((c) => /^(\*|Googlebot|Bingbot|Applebot|DuckDuckBot|Slurp|YandexBot|Baiduspider)$/i.test(c.agent)), false);

  part("The stored choice, read exactly");
  is("a record from before the switch is open", parseAiCrawlers(undefined), "open");
  is("open is open, closed is closed", [parseAiCrawlers("open"), parseAiCrawlers("closed")], ["open", "closed"]);
  is("anything else is closed, never open", ["OPEN", "", null, true, false, 1, {}, "yes"].map((v) => parseAiCrawlers(v)), Array(8).fill("closed"));

  const owner = "aicrawl@example.com";
  await claimHandle(owner, "aicrawl", "AI Crawl Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const made = await addProduct(owner, "Rye Guide", "", "19", null);
  if (!made.ok) throw new Error("no synthetic product");
  const fresh = (await storeForEmail(owner))!;
  is("a new store is open", fresh.aiCrawlers, "open");
  const key = await storeKey("aicrawl");
  const kept = await rawOf(key);
  const legacy = JSON.parse(kept) as Record<string, unknown>;
  is("the choice is kept in the store's own record, so reading it costs no extra command", legacy.aiCrawlers, "open");
  delete legacy.aiCrawlers;
  await redis.pipeline([["SET", key, JSON.stringify(legacy)]]);
  is("a record written before the switch reads open", (await storeForEmail(owner))!.aiCrawlers, "open");
  await redis.pipeline([["SET", key, JSON.stringify({ ...legacy, aiCrawlers: "maybe" })]]);
  is("a damaged value reads closed", (await storeForEmail(owner))!.aiCrawlers, "closed");
  await redis.pipeline([["SET", key, kept]]);

  part("By default, robots.txt is what it was");
  is("byte for byte on marktmorgen.com", storeRobots(fresh), before(`${SITE_URL}/@aicrawl`));
  const owned = { ...fresh, tier: "pro" as const, subscriptionActive: true, domain: { name: "shop.example.com", liveAt: "2026-10-01", verifiedAt: "2026-10-01" } } as unknown as Store;
  is("byte for byte on the creator's own domain", storeRobots(owned), before("https://shop.example.com"));
  is("no AI crawler named while open", AI_CRAWLERS.some((c) => storeRobots(owned).includes(c.agent)), false);

  part("Closed");
  const closed: Store = { ...owned, aiCrawlers: "closed" };
  const rules = storeRobots(closed);
  is("each named AI crawler gets its own group that shuts it out", AI_CRAWLERS.every((c) => rules.includes(`User-agent: ${c.agent}\nDisallow: /\n`)), true);
  is("the group for every other crawler, search engines included, is unchanged", rules.startsWith(["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /orders", "Disallow: /manage", "Disallow: /thanks", "Disallow: /course", "Disallow: /community", ""].join("\n")), true);
  is("no search engine named", /Googlebot|Bingbot|Applebot\n|DuckDuckBot/.test(rules), false);
  is("the map is still named, once, at the end", [rules.endsWith("Sitemap: https://shop.example.com/sitemap.xml\n"), rules.split("Sitemap:").length - 1], [true, 1]);
  is("a suspended store still shuts everyone out", storeRobots({ ...closed, suspended: "2026-11-01" }), "User-agent: *\nDisallow: /\n");

  part("The studio route");
  const session = await openSession(owner);
  const post = async (body: unknown) => {
    const response = await aiCrawlersRoute(new NextRequest("https://marktmorgen.com/api/store/ai-crawlers", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; open?: boolean; error?: string } };
  };
  for (const bad of [{ open: "false" }, { open: 0 }, { open: null }, {}, { on: false }]) is(`${JSON.stringify(bad)} refused, nothing changed`, [(await post(bad)).status, (await storeForEmail(owner))!.aiCrawlers], [400, "open"]);
  is("closing is kept", [(await post({ open: false })).body, (await storeForEmail(owner))!.aiCrawlers], [{ ok: true, open: false }, "closed"]);
  const written = await rawOf(key);
  is("closing again writes nothing", [(await setAiCrawlers(owner, "closed"))?.aiCrawlers, await rawOf(key)], ["closed", written]);
  is("no session, nothing changes", (await aiCrawlersRoute(new NextRequest("https://marktmorgen.com/api/store/ai-crawlers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: true }) }))).ok, false);
  is("still closed", (await storeForEmail(owner))!.aiCrawlers, "closed");
  is("the route asks for the settings permission", readFileSync("app/api/store/ai-crawlers/route.ts", "utf8").includes('guardStoreWrite(request, "settings"'), true);

  part("What a creator's domain serves as /robots.txt");
  const served = await (await storeRobotsRoute(new Request("https://shop.example.com/robots.txt"), { params: Promise.resolve({ handle: "@aicrawl" }) })).text();
  is("the closed rules, read from the store", AI_CRAWLERS.every((c) => served.includes(`User-agent: ${c.agent}\nDisallow: /\n`)), true);
  is("the proxy still sends a domain's /robots.txt there", readFileSync("proxy.ts", "utf8").includes('"/robots.txt": "/store-robots"'), true);
  await post({ open: true });
  const reopened = await (await storeRobotsRoute(new Request("https://shop.example.com/robots.txt"), { params: Promise.resolve({ handle: "@aicrawl" }) })).text();
  is("opened again: what it was before", reopened, before(`${SITE_URL}/@aicrawl`));

  part("What the studio says");
  const base = searchCheck((await storeForEmail(owner))!);
  is("the check carries the choice", [base.aiCrawlers, searchCheck({ ...owned, aiCrawlers: "closed" }).aiCrawlers], ["open", "closed"]);
  is("open: the lines as before", agentsGet(base), AGENTS_GET);
  const shut = agentsGet({ ...base, aiCrawlers: "closed", ownDomain: true });
  is("closed: never says the store is open to AI", shut.some((l) => /open to AI/i.test(l)), false);
  is("closed: says the marktmorgen.com address still lets them in", shut[0].includes("marktmorgen.com"), true);
  const w = AI_CRAWLERS_WORDS;
  const all = Object.values(w).join(" ");
  is("asks, cannot promise", [/\bask/i.test(w.what), /not every crawler/i.test(w.what), /cannot promise/i.test(w.what)], [true, true, true]);
  is("search engines are not asked", /Google Search, Bing and other search engines are not asked/.test(w.search), true);
  is("the marktmorgen.com address is not covered", /marktmorgen\.com/.test(w.address), true);
  is("a change can take up to a day", /up to a day/.test(w.delay), true);
  is("no promise words", /guarantee|fully|100%|block all|every AI/i.test(all), false);
  const openSwitch = renderToStaticMarkup(AiCrawlersSwitch({ open: true, ownDomain: true }));
  const closedSwitch = renderToStaticMarkup(AiCrawlersSwitch({ open: false, ownDomain: true }));
  is("one plain action each way", [openSwitch.includes("Ask AI crawlers to stay out"), closedSwitch.includes("Let AI crawlers in again")], [true, true]);
  is("the names asked are listed", AI_CRAWLERS.every((c) => openSwitch.includes(c.agent)), true);
  is("a heading and a stated state", [openSwitch.includes("<h3"), openSwitch.includes('data-ai-crawlers="open"'), closedSwitch.includes('data-ai-crawlers="closed"')], [true, true, true]);
  const noDomain = renderToStaticMarkup(AiCrawlersSwitch({ open: false, ownDomain: false }));
  is("closed with no live domain: said it is not in use, and can be undone", [noDomain.includes(w.noDomain), noDomain.includes("Let AI crawlers in again")], [true, true]);
  const panel = (aiCrawlers: "open" | "closed", ownDomain: boolean, canChangeAi: boolean) =>
    renderToStaticMarkup(StoreSearchCheck({ check: { description: true, indexed: true, suspended: false, agents: { noPicture: [] }, summaries: { missing: [], unchecked: 0 }, ownDomain, aiCrawlers }, canChangeAi }));
  is("shown in the check with a live domain and the settings permission", panel("open", true, true).includes("Ask AI crawlers to stay out"), true);
  is("not shown where it would do nothing: no domain and open", panel("open", false, true).includes("data-ai-crawlers"), false);
  is("not shown without the settings permission", panel("closed", true, false).includes("data-ai-crawlers="), false);
  is("the studio page passes the permission", readFileSync("app/studio/page.tsx", "utf8").includes('<StoreSearchCheck check={searchCheck(store)} canChangeAi={may("settings")} />'), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
