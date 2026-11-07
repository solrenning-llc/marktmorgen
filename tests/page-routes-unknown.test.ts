/**
 * The studio routes that decide a write from a page they read refuse, before writing anything, when that read's
 * answer is not known (C4-20261106-2610-C6-153, unit A; Codex T's proof 64b3a0a9). Before, an unknown read was an
 * empty page: a save took every picture for new, so the ones it kept were never released and the ones taken off
 * were never deleted, or worse, a page "known" empty had none of its pictures to keep; a version brought back
 * dropped every picture; a copy started from nothing; a saved section was put on pages, or counted against the
 * month's figure, from an empty page that was not.
 *
 * Each check sends the real route a real request from the creator's own session. Only Redis's answer to the page
 * read is changed (no reply at all, or a text that is not a page); everything else is the real store. Each must
 * answer 503 "page_unread", and what is kept must be exactly as before: the page records, which page owns each
 * picture, the page's earlier versions, the saved section, and the month's count of section updates.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { claimPictures, writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { blocksForPage } from "@/lib/saved-blocks";
import { siteKey } from "@/lib/site-page-rules";
import { monthOfUse, shareLimitsFor } from "@/lib/funnel-share-rules";
import { MONTH_USE_SECONDS, countUse, storeMonthKey } from "@/lib/funnel-share-store";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { GET as pageCopy, POST as pageSave } from "@/app/api/store/page/route";
import { GET as pageVersions } from "@/app/api/store/page-versions/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { GET as sectionsGet, POST as sectionsPost } from "@/app/api/store/saved-blocks/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "page-reads@example.com";
const ORIGIN = "https://marktmorgen.com";
const SITE = "cccccccccc";

type Mode = "no reply" | "not a page";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pagereads", "Page reads", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const product = made.product.id;
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = (path: string, body: unknown) => new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string) => new NextRequest(`${ORIGIN}${path}`, { headers });
  const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

  const shop = await storeForEmail(OWNER);
  const statsId = shop?.statsId;
  if (!shop || !statsId) throw new Error("setup");
  const folder = await imageFolder(OWNER);
  const picture = (n: number) => ({ path: `images/${folder}/${n.toString(16).padStart(32, "0")}.jpg`, width: 1200, height: 800, alt: "A page", caption: "" });
  const pictures = (id: string, items: ReturnType<typeof picture>[]): PageBlock => ({ ...(emptyBlock("pictures") as Extract<PageBlock, { kind: "pictures" }>), id, items });
  const faq = (q: string): PageBlock => ({ ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q, a: "An answer." }] });
  const cta = (label: string): PageBlock => ({ ...(emptyBlock("cta") as Extract<PageBlock, { kind: "cta" }>), label });

  // A product's page with a picture, saved twice so it has an earlier version.
  const productPicture = picture(1);
  const productPage = parsePage({ blocks: [pictures("pics0001", [productPicture]), cta("Buy it")] });
  if (!(await setProductPage(OWNER, product, true)).ok) throw new Error("setup");
  await writePage(statsId, product, parsePage({ blocks: [pictures("pics0001", [productPicture])] }), shop);
  await writePage(statsId, product, productPage, shop);
  await claimPictures(statsId, product, [productPicture.path]);

  // A store page with a picture.
  const sitePicture = picture(2);
  if (!(await setSitePages(OWNER, [{ id: SITE, slug: "about", title: "About", nav: true, target: "", from: 0 }])).ok) throw new Error("setup");
  await writePage(statsId, siteKey(SITE), parsePage({ blocks: [pictures("pics0002", [sitePicture])] }), shop);
  await claimPictures(statsId, siteKey(SITE), [sitePicture.path]);

  // A saved section, on two more store pages.
  const saved = (await (await sectionsPost(post("/api/store/saved-blocks", { action: "save", name: "Buyer questions", blocks: [faq("Is it for me?"), cta("Get it")] }))).json()) as { ok?: boolean; section?: { id: string; blocks: PageBlock[] } };
  if (!saved.ok || !saved.section) throw new Error("setup: section");
  const section = saved.section;
  const added = await storeForEmail(OWNER);
  const uses = ["dddddddddd", "eeeeeeeeee"];
  if (!(await setSitePages(OWNER, [...(added?.sitePages ?? []), ...uses.map((id, n) => ({ id, slug: `page-${n}`, title: `Page ${n}`, nav: false, target: "", from: 0 }))])).ok) throw new Error("setup");
  for (const id of uses) {
    const answer = await result(await sitePage(post("/api/store/site-page", { action: "save", id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }, ...blocksForPage(section)], style: "plain" } })));
    if (answer[0] !== 200) throw new Error(`setup: section page ${answer}`);
  }

  const month = monthOfUse((await storeForEmail(OWNER))!);
  if (!month) throw new Error("setup: month");
  const applyKey = storeMonthKey(statsId, "apply", month);
  const pageKeys = [product, siteKey(SITE), ...uses.map(siteKey)].map((id) => `nl:product:page:${statsId}:${id}`);
  const kept = async () => ({
    pages: await redis.pipeline(pageKeys.map((key) => ["GET", key])),
    owners: await redis.pipeline([["HGETALL", `nl:product:pics:${statsId}`]]),
    versions: await redis.pipeline([["LRANGE", `nl:product:pages:${statsId}:${product}`, 0, -1]]),
    section: await redis.pipeline([["HGETALL", `nl:sblocks:${statsId}`], ["SMEMBERS", `nl:sblock:uses:${statsId}:${section.id}`]]),
    applied: await redis.pipeline([["GET", applyKey]]),
    flag: (await readListing((await storeForEmail(OWNER))!, product))?.page ?? null,
  });

  /** Runs the request while Redis answers every page read in the given unknown shape; counts the reads changed. */
  async function unknown<T>(mode: Mode, task: () => Promise<T>): Promise<{ answer: T; changed: number }> {
    const original = redis.pipeline;
    let changed = 0;
    redis.pipeline = async (commands) => {
      const reply = await original.call(redis, commands);
      const command = commands[0];
      if (commands.length !== 1 || !["GET", "MGET"].includes(String(command?.[0])) || !String(command?.[1]).startsWith(`nl:product:page:${statsId}:`)) return reply;
      changed += 1;
      return mode === "no reply" ? [] : ["{"];
    };
    try {
      return { answer: await task(), changed };
    } finally {
      redis.pipeline = original;
    }
  }

  /** Each case, and whether the month's count of section updates is taken before its page reads (Codex Z on #2830). */
  const cases: [string, () => Promise<Response>, "counted"?][] = [
    ["a product's page saved with its picture taken off", () => pageSave(post("/api/store/page", { id: product, page: { blocks: [cta("Buy it")] } }))],
    ["a product's page copied to start another", () => pageCopy(get(`/api/store/page?id=${product}`))],
    ["an earlier version of a product's page brought back", () => pageVersions(get(`/api/store/page-versions?id=${product}&n=0`))],
    ["a store page saved with its picture taken off", () => sitePage(post("/api/store/site-page", { action: "save", id: SITE, page: { blocks: [cta("Read more")], style: "plain" } }))],
    ["the pages that use a saved section listed", () => sectionsGet(get(`/api/store/saved-blocks?section=${section.id}&except=`))],
    ["a saved section updated", () => sectionsPost(post("/api/store/saved-blocks", { action: "update", id: section.id, blocks: [faq("Is it for me, really?"), cta("Get it")], except: "" }))],
    ["a saved section put on its pages", () => sectionsPost(post("/api/store/saved-blocks", { action: "apply", id: section.id, pages: uses.map(siteKey) })), "counted"],
  ];

  for (const mode of ["no reply", "not a page"] as const) {
    part(`Redis's answer to the page read: ${mode}`);
    for (const [name, send, counted] of cases) {
      const before = await kept();
      const { answer, changed } = await unknown(mode, async () => result(await send()));
      is(`${name}: refused, 503 ${counted ? "page_unread_counted" : "page_unread"}`, answer, [503, counted ? "page_unread_counted" : "page_unread"]);
      is(`${name}: the page read was the one changed`, changed > 0, true);
      const after = await kept();
      for (const field of Object.keys(before) as (keyof typeof before)[]) {
        if (field === "applied" && counted) continue;
        is(`${name}: ${field} unchanged`, after[field], before[field]);
      }
      // The try counted before the reads is exactly one, and the answer says so (lib/studio-messages.ts).
      if (counted) is(`${name}: the month's count went up by exactly the one try`, Number((after.applied as unknown[])[0]), Number((before.applied as unknown[])[0] ?? 0) + 1);
    }
  }

  part("What the studio says");
  is("page_unread has its own words, saying nothing was changed", STUDIO_MESSAGES.page_unread, "A page could not be read just now, so nothing was changed. Reload, then try again.");
  is("page_unread_counted says no page changed and the try still counts", STUDIO_MESSAGES.page_unread_counted, "A page could not be read just now, so no page was changed. This try still counts toward this month's section updates. Reload, then try again.");

  part("Healthy reads still work the same");
  is("the copy", await result(await pageCopy(get(`/api/store/page?id=${product}`))), [200, "ok"]);
  is("the earlier version", await result(await pageVersions(get(`/api/store/page-versions?id=${product}&n=0`))), [200, "ok"]);
  is("the section's pages", await result(await sectionsGet(get(`/api/store/saved-blocks?section=${section.id}&except=`))), [200, "ok"]);
  is("the product's page saved as it is", await result(await pageSave(post("/api/store/page", { id: product, page: productPage }))), [200, "ok"]);
  is("the section put on its pages", await result(await sectionsPost(post("/api/store/saved-blocks", { action: "apply", id: section.id, pages: uses.map(siteKey) }))), [200, "ok"]);

  // Codex Z's proof on #2830 (codex/z-review-2830-apply-read cc6a2e2b): past the month's figure, an apply is refused
  // before it reads any page, as it was before this change; those reads would go beyond the request's studio unit.
  part("An apply past the month's figure reads no page");
  const limit = shareLimitsFor((await storeForEmail(OWNER))!).appliesPerMonth;
  while (await countUse(applyKey, limit, MONTH_USE_SECONDS));
  const original = redis.pipeline;
  let pageReads = 0;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => ["GET", "MGET"].includes(String(command[0])) && String(command[1]).startsWith(`nl:product:page:${statsId}:`))) pageReads += 1;
    return original.call(redis, commands);
  };
  let refused: unknown[] = [];
  try {
    refused = await result(await sectionsPost(post("/api/store/saved-blocks", { action: "apply", id: section.id, pages: uses.map(siteKey) })));
  } finally {
    redis.pipeline = original;
  }
  is("refused for the month's figure", refused, [429, "applies_full"]);
  is("with no page read", pageReads, 0);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
