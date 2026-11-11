/**
 * C4-20261106-2610-C6-153, unit B part 2 (after #2832; unit A, #2830, made readPage and readPages throw on an unknown
 * read): the last two places that took a page read whose answer is not known for an empty page or for no page.
 * Each check sends the real page or export the real store; only Redis's answer to the page's GET or MGET changes (no
 * reply at all, or a text that is not a page).
 *   - The public store page (/@handle/slug) says "Not available right now." in a status line, keeps itself out of
 *     search (noindex) and draws no blocks, instead of taking the read for an empty page and answering "not found", as
 *     if the creator had taken the page down. A page the creator never filled is still not there (not found), as before.
 *   - The creator's export says its products' pages could not be read, in a note, and writes no page as absent.
 *   - The store copy and the demo seed let the error go on (no catch turns it into an empty page), so neither writes
 *     an empty page over a real one.
 *   - Review of #2853 (Claude 4 team, L1): a page the store record already keeps back (from = -1) or schedules for later
 *     is not there with an unknown read either; its unpublished title is never shown.
 *   - Review of #2853 (Claude 6, findings 1 and 2): the export's note on pages is the one text #2831 writes, and the
 *     products' descriptions and thank-you notes (the same pattern next to the pages, rule 30) are never written as
 *     "" or null when their read fails: each is left out and said once.
 */
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server";
import StoreOwnPage, { generateMetadata as siteMeta } from "@/app/[handle]/[slug]/page";
import { storeExport } from "@/lib/store-export";
import { addProduct, claimHandle, ensureStatsId, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "page-show-b2@example.com";
const ORIGIN = "https://marktmorgen.com";
const SITE = "eeeeeeeeee";
const BARE = "dddddddddd";
const SECRET = "ffffffffff";
const SOON = "cccccccccc";
const UNREAD_LATER = "could not be read just now. Download the file again in a few minutes.";
type Mode = "no reply" | "not a page";

/** A page drawn to HTML, as a browser gets it; or the error it threw, named, so a page that fails says so. */
async function html(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    return `thrown ${(error as Error)?.name ?? "error"}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pageshowb", "Page show B", "");
  await ensureStatsId(OWNER);
  const paid = await addProduct(OWNER, "Guide", "A guide.", "19", null);
  if (!paid.ok) throw new Error("setup");
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const hero = (id: string, headline: string) => ({ id, kind: "hero", headline, sub: "For busy parents", media: "none", video: null });
  if (!(await setProductPage(OWNER, paid.product.id, true)).ok) throw new Error("setup");
  await writePage(statsId, paid.product.id, parsePage({ blocks: [hero("hero0001", "Forty dinners")] }), shop);
  const pages = [
    { id: SITE, slug: "about", title: "About", nav: true, target: "", from: 0 },
    { id: BARE, slug: "later", title: "Later", nav: false, target: "", from: 0 },
    { id: SECRET, slug: "secret", title: "Secret launch: 70% off", nav: false, target: "", from: -1 },
    { id: SOON, slug: "soon", title: "Soon: early bird", nav: false, target: "", from: 4000000000 },
  ];
  if (!(await setSitePages(OWNER, pages)).ok) throw new Error("setup");
  await writePage(statsId, siteKey(SITE), parsePage({ blocks: [hero("hero0004", "About us")] }), shop);
  await writePage(statsId, siteKey(SECRET), parsePage({ blocks: [hero("hero0005", "Kept back")], hidden: true, showFrom: 0 }), shop);
  await writePage(statsId, siteKey(SOON), parsePage({ blocks: [hero("hero0006", "Out later")], hidden: true, showFrom: 4000000000 }), shop);
  const now = (await storeForEmail(OWNER))!;

  /** Runs the task while Redis answers every page read in the given unknown shape. */
  async function unknown<T>(mode: Mode, task: () => Promise<T>): Promise<T> {
    const original = redis.pipeline;
    redis.pipeline = async (commands) => {
      const reply = await original.call(redis, commands);
      const command = commands[0];
      if (commands.length !== 1 || !["GET", "MGET"].includes(String(command?.[0])) || !String(command?.[1]).startsWith(`nl:product:page:${statsId}:`)) return reply;
      return mode === "no reply" ? [] : ["{"];
    };
    try {
      return await task();
    } finally {
      redis.pipeline = original;
    }
  }

  const exported = async () => JSON.parse(await new Response(storeExport(now, 1000)).text()) as { products: Record<string, unknown>[]; pagesNote?: string; aboutsNote?: string; thanksNote?: string };
  const siteParams = { params: Promise.resolve({ handle: "@pageshowb", slug: "about" }), searchParams: Promise.resolve({}) };
  const bareParams = { params: Promise.resolve({ handle: "@pageshowb", slug: "later" }), searchParams: Promise.resolve({}) };

  part("The store page and the export, read as they are");
  answering(new Request(`${ORIGIN}/@pageshowb/about`));
  const shown = await html(() => StoreOwnPage(siteParams));
  is("the store page's headline is shown", shown.includes("About us"), true);
  is("with no status line saying it is not available", shown.includes("Not available right now."), false);
  is("in search", (await siteMeta(siteParams)).robots, { index: true, follow: true });
  answering(new Request(`${ORIGIN}/@pageshowb/later`));
  is("a store page the creator never filled is not there, as before", await html(() => StoreOwnPage(bareParams)), "thrown Error");
  is("and its title says not found, as before", (await siteMeta(bareParams)).title, "Not found — Marktmorgen");
  const fine = await exported();
  is("the export writes the product's page", JSON.stringify(fine.products[0]?.page ?? null).includes("Forty dinners"), true);
  is("and has no note about pages", fine.pagesNote, undefined);

  for (const mode of ["no reply", "not a page"] as const) {
    part(`A page read answered ${mode}`);
    answering(new Request(`${ORIGIN}/@pageshowb/about`));
    const page = await unknown(mode, () => html(() => StoreOwnPage(siteParams)));
    is(`${mode}: the store page says it is not available right now, in a status line`, /role="status"[^>]*>Not available right now\./.test(page), true);
    is(`${mode}: with a way back to the store`, page.includes("Back to Page show B"), true);
    is(`${mode}: and draws no blocks (no empty page body)`, page.includes("sp-body"), false);
    const meta = await unknown(mode, () => siteMeta(siteParams));
    is(`${mode}: kept out of search`, (meta.robots as { index?: boolean } | undefined)?.index, false);
    is(`${mode}: its title says not available, not an empty page's title`, String(meta.title).startsWith("Not available right now."), true);

    const out = await unknown(mode, exported);
    is(`${mode}: the export notes that the products' pages could not be read, in #2831's words`, out.pagesNote, `The products' sales pages ${UNREAD_LATER}`);
    is(`${mode}: and writes no product's page as absent`, out.products.some((product) => "page" in product), false);
    is(`${mode}: the products themselves are still written`, out.products.length, 1);
  }

  for (const [slug, title] of [["secret", "Secret launch"], ["soon", "Soon: early bird"]] as const) {
    const kept = { params: Promise.resolve({ handle: "@pageshowb", slug }), searchParams: Promise.resolve({}) };
    part(`A store page the store record keeps back (${slug}), review of #2853 L1`);
    answering(new Request(`${ORIGIN}/@pageshowb/${slug}`));
    is(`${slug}: with a known read, it is not there`, await html(() => StoreOwnPage(kept)), "thrown Error");
    for (const mode of ["no reply", "not a page"] as const) {
      const page = await unknown(mode, () => html(() => StoreOwnPage(kept)));
      is(`${slug}, ${mode}: it is still not there`, page, "thrown Error");
      is(`${slug}, ${mode}: its unpublished title is not shown`, page.includes(title), false);
      const meta = await unknown(mode, () => siteMeta(kept));
      is(`${slug}, ${mode}: its title says not found, never its own title`, meta.title, "Not found — Marktmorgen");
    }
  }

  /** The export while one part's MGET fails, the way an unknown reply makes the read throw. */
  async function failing(prefix: string) {
    const original = redis.pipeline;
    redis.pipeline = async (commands) => {
      if (commands.some((command) => command[0] === "MGET" && String(command[1]).startsWith(prefix))) throw new TypeError("fetch failed");
      return original.call(redis, commands);
    };
    try {
      return await exported();
    } finally {
      redis.pipeline = original;
    }
  }
  for (const [part_, prefix, field, note, said] of [
    ["descriptions", "nl:product:about:", "about", "aboutsNote", "long descriptions"],
    ["thank-you notes", "nl:product:note:", "thanks", "thanksNote", "thank-you notes"],
  ] as const) {
    part(`The products' ${part_} cannot be read (rule 30, next to the pages; review of #2853 finding 2)`);
    const out = await failing(prefix);
    is(`${part_}: the export says so once, in #2831's words`, out[note], `The products' ${said} ${UNREAD_LATER}`);
    is(`${part_}: and writes none as "" or null`, out.products.some((product) => field in product), false);
    is(`${part_}: the products and their pages are still written`, out.products.length === 1 && "page" in out.products[0]!, true);
  }

  part("The store copy and the demo seed let an unknown page read go on, so they never write an empty page over it");
  const copy = readFileSync("lib/store-copy.ts", "utf8");
  const seed = readFileSync("lib/demo-seed.ts", "utf8");
  const reads = (source: string) => source.split("\n").filter((line) => /\breadPages?\(/.test(line) && !/^\s*import\b/.test(line));
  is("the store copy reads pages in two places", reads(copy).length, 2);
  is("with no catch on either", reads(copy).some((line) => line.includes(".catch(")), false);
  is("the demo seed reads its page in one place", reads(seed).length, 1);
  is("with no catch on it", reads(seed).some((line) => line.includes(".catch(")), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
