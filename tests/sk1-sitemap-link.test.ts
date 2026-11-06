/**
 * 233 [SK1], the two pieces left out of the About page's first change:
 * the store's map for search engines and the community's door. Against the
 * in-memory Redis double and synthetic stores only.
 *
 *   1. The map lists /community/about only while the creator has the page on
 *      and the community itself is on: off, a community switched off, a
 *      setting that cannot be read (a lost reply, a value that does not
 *      parse, no setup at all) all leave it out. On a creator's own domain
 *      it is under the domain, as the page names itself (its canonical).
 *   2. The domain's crawler rules still keep /community shut and let the
 *      About page be read, so the map does not point at a page crawlers are
 *      told not to read.
 *   3. Its cost: the setting is read once, after the map is paid for, and
 *      the map's cost line counts it (tests/plan-cost-registry.ts).
 *   4. The community's door, for people who are not in it, links to the
 *      About page only while it is on, with the community's name in the
 *      link's words (WCAG 2.4.9), in every language.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, ensureStatsId, setCommunity, storeForEmail } from "@/lib/store";
import { freshConfig, readConfig, saveConfig } from "@/lib/community";
import { aboutWords } from "@/lib/community-about";
import { storeRobots, storeSitemap } from "@/lib/store-sitemap";
import { SITE_URL } from "@/lib/site-url";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { Gate } from "@/components/community-parts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const real = redis.pipeline.bind(redis);
let sent: (string | number)[][] = [];
let spoil: "none" | "queued" | "text" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const replies = await real(commands);
  return commands.map((c, i) => {
    if (c[0] === "GET" && String(c[1]).endsWith(":cfg")) {
      if (spoil === "queued") return "QUEUED";
      if (spoil === "text") return "{not json";
    }
    return replies[i];
  });
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "sk1map@example.com";
  await claimHandle(OWNER, "sk1map", "Rye House", "");
  await ensureStatsId(OWNER);
  const root = `${SITE_URL}/@sk1map`;
  const about = `${root}/community/about`;
  const urls = async (s: Parameters<typeof storeSitemap>[0]) => (await storeSitemap(s, 1_800_000_000)).map((e) => e.url);

  part("1. The map lists the About page only while it is on");
  let store = (await storeForEmail(OWNER))!;
  is("a store with no community: not listed", (await urls(store)).includes(about), false);
  store = (await setCommunity(OWNER, true))!;
  const id = store.community!.id;
  is("a community with no setup yet: not listed", (await urls(store)).includes(about), false);
  await saveConfig(id, freshConfig(store.name));
  is("the page off (the default): not listed", (await urls(store)).includes(about), false);
  await saveConfig(id, { ...(await readConfig(id))!, page: { on: true, counts: false } });
  sent = [];
  is("the page on: listed, at the address the page names as its own", (await urls(store)).includes(about), true);
  is("the setting read once, with one command", sent.filter((c) => c[0] === "GET" && String(c[1]).endsWith(":cfg")).length, 1);
  spoil = "queued";
  is("a lost reply to the setting: left out", (await urls(store)).includes(about), false);
  spoil = "text";
  is("a setting that does not parse: left out", (await urls(store)).includes(about), false);
  spoil = "none";
  store = (await setCommunity(OWNER, false))!;
  sent = [];
  is("the community switched off: not listed", (await urls(store)).includes(about), false);
  is("and its setting is not even read", sent.some((c) => c[0] === "GET" && String(c[1]).endsWith(":cfg")), false);
  store = (await setCommunity(OWNER, true))!;
  const owned = { ...store, tier: "pro" as const, subscriptionActive: true, domain: { name: "rye.example.com", liveAt: "2026-10-01", verifiedAt: "2026-10-01" } } as unknown as typeof store;
  is("on the creator's own domain: under the domain", (await urls(owned)).includes("https://rye.example.com/community/about"), true);
  const resting = { ...store, suspended: "2026-11-01" } as unknown as typeof store;
  is("a store switched off after notices lists nothing", (await urls(resting)).length, 0);

  part("2. The domain's crawler rules");
  const rules = storeRobots(owned).split("\n");
  is("the rest of the community stays shut, and the About page may be read", [rules.includes("Disallow: /community"), rules.includes("Allow: /community/about")], [true, true]);

  part("3. Its cost");
  const sitemap = readFileSync("lib/store-sitemap.ts", "utf8");
  const paidAt = sitemap.indexOf("takePublicRequest(store, \"public\", now, sitemapUnits(size))");
  is("the setting is read in the map itself, which is drawn only after it is paid for", [paidAt > 0, sitemap.includes("await aboutListed(store)")], [true, true]);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the map's cost line counts the setting's read", /export function sitemapRead[\s\S]{0,900}SITEMAP_SETTINGS_BYTES/.test(registry), true);

  part("4. The community's door");
  const config = (await readConfig(id))!;
  const door = (page: { on: boolean; counts: boolean }, state: "out" | "closed" | "removed" = "out", language = "en") =>
    renderToStaticMarkup(createElement(Gate, { store: { ...store, language } as typeof store, config: { ...config, page }, state, email: null, products: [], link: null }));
  const href = `href="/@sk1map/community/about"`;
  is("off: no link to it", door({ on: false, counts: false }).includes(href), false);
  const shown = door({ on: true, counts: false });
  is("on: a link to it", shown.includes(href), true);
  is("its words name the community (2.4.9)", shown.includes(`>About ${config.name}</a>`), true);
  is("not for somebody the creator removed", door({ on: true, counts: false }, "removed").includes(href), false);
  is("shown to a closed address too, who may still read about it", door({ on: true, counts: false }, "closed").includes(href), true);
  for (const code of LANGUAGE_CODES) {
    const words = aboutWords(code).link(config.name);
    is(`${code}: the link's words name the community`, [words.includes(config.name), door({ on: true, counts: false }, "out", code).includes(`>${words}</a>`)], [true, true]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
