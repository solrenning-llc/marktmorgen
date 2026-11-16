/**
 * 248 [ST1] unit 4: "What search engines are given" for one of a store's own pages (/about and the rest) in the
 * studio. Both the public page's metadata (app/[handle]/[slug]/page.tsx) and the studio read sitePageSnippet
 * (lib/product-search-snippet.ts), so what the creator is shown is what the page sends:
 *   - the rule, in the page's order: own title, else "<page> — <store>"; own description, else the subheadline of
 *     the first block when it is a hero, else the store's description, else "<page>, from <store>."; 300 at most;
 *   - the real metadata of five synthetic pages (one per source, two stores, with and without a description) is
 *     the rule's; a page kept back is not on the store (not found), and the rule says it waits;
 *   - the studio's store page editor is handed the store's description, and the editor draws the rule from what is
 *     typed: the first block's subheadline, the Hidden switch, and whether the page has a block at all;
 *   - the preview's words for a store page, including the one said while it is not on the store.
 * Synthetic stores on the Redis stand-in; nothing reaches any service.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { generateMetadata as siteMeta } from "@/app/[handle]/[slug]/page";
import StudioSitePage from "@/app/studio/site/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { PageEditor } from "@/components/page-editor";
import * as snippetModule from "@/lib/product-search-snippet";
import { SearchSnippetPreview } from "@/components/search-snippet-preview";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const WITH_BIO = "site-snippet-a@example.com";
const NO_BIO = "site-snippet-b@example.com";
const BIO = "Weeknight dinners for busy parents.";

type Snippet = { title: string; description: string; titleFrom: string; descriptionFrom: string; waiting: boolean; kind: string };
type Input = { seoTitle: string; seoDescription: string; pageTitle: string; subheadline: string; storeBio: string; storeName: string; shown: boolean };
const rule = (snippetModule as Record<string, unknown>).sitePageSnippet as ((input: Input) => Snippet) | undefined;
const snippet = (input: Input): Snippet | "missing" => (rule ? rule(input) : "missing");

function find(node: unknown, component: unknown): { props: Record<string, unknown> } | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, component);
      if (hit) return hit;
    }
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === component && element.props) return { props: element.props };
  for (const value of Object.values(element.props ?? {})) {
    const hit = find(value, component);
    if (hit) return hit;
  }
  return null;
}

const hero = (id: string, sub: string) => ({ id, kind: "hero", headline: "Hello", sub, media: "none", video: null });

async function main(): Promise<void> {
  const base: Input = { seoTitle: "", seoDescription: "", pageTitle: "About", subheadline: "", storeBio: "", storeName: "Harbor Kitchen", shown: true };

  part("The rule, in the store page's order");
  is("nothing of its own: the page's and store's names, and the sentence", snippet(base), {
    title: "About — Harbor Kitchen", titleFrom: "default", description: "About, from Harbor Kitchen.", descriptionFrom: "sentence", waiting: false, kind: "site",
  });
  is("the store's description before the sentence", snippet({ ...base, storeBio: BIO }), {
    title: "About — Harbor Kitchen", titleFrom: "default", description: BIO, descriptionFrom: "bio", waiting: false, kind: "site",
  });
  is("the first subheadline before the store's description, as it is kept (one line)", snippet({ ...base, storeBio: BIO, subheadline: "  Who we are,\n and why. " }), {
    title: "About — Harbor Kitchen", titleFrom: "default", description: "Who we are, and why.", descriptionFrom: "subheadline", waiting: false, kind: "site",
  });
  is("the page's own words first", snippet({ ...base, storeBio: BIO, subheadline: "Who we are.", seoTitle: "Our kitchen", seoDescription: "Two cooks, one table." }), {
    title: "Our kitchen", titleFrom: "yours", description: "Two cooks, one table.", descriptionFrom: "yours", waiting: false, kind: "site",
  });
  is("at most 300 characters, as the page gives", snippet({ ...base, storeBio: "x".repeat(400) }) === "missing" ? "missing" : (snippet({ ...base, storeBio: "x".repeat(400) }) as Snippet).description.length, 300);
  is("a page not on the store waits, with what it gives once it shows", snippet({ ...base, seoTitle: "Our kitchen", shown: false }) === "missing" ? "missing" : [(snippet({ ...base, seoTitle: "Our kitchen", shown: false }) as Snippet).waiting, (snippet({ ...base, seoTitle: "Our kitchen", shown: false }) as Snippet).title], [true, "Our kitchen"]);

  part("The real store page's metadata is the rule");
  redis.clear();
  await claimHandle(WITH_BIO, "harborkitchen", "Harbor Kitchen", BIO);
  await claimHandle(NO_BIO, "quietkitchen", "Quiet Kitchen", "");
  await ensureStatsId(WITH_BIO);
  await ensureStatsId(NO_BIO);
  const pages = [
    { id: "ownwords01", slug: "story", title: "Our story", blocks: [hero("hero0001", "Who we are.")], seo: { seoTitle: "Our kitchen", seoDescription: "Two cooks, one table." }, from: "yours" },
    { id: "subline001", slug: "about", title: "About", blocks: [hero("hero0002", "Who we are, and why.")], seo: { seoTitle: "", seoDescription: "" }, from: "subheadline" },
    { id: "storebio01", slug: "start-here", title: "Start here", blocks: [hero("hero0003", "")], seo: { seoTitle: "", seoDescription: "" }, from: "bio" },
    { id: "keptback01", slug: "soon", title: "Soon", blocks: [hero("hero0004", "Not yet.")], seo: { seoTitle: "Later", seoDescription: "" }, hidden: true, from: "waiting" },
  ] as const;
  if (!(await setSitePages(WITH_BIO, pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title, nav: true, target: "", from: 0 })))).ok) throw new Error("setup");
  if (!(await setSitePages(NO_BIO, [{ id: "sentence01", slug: "about", title: "About", nav: true, target: "", from: 0 }])).ok) throw new Error("setup");
  const withBio = (await storeForEmail(WITH_BIO))!;
  const noBio = (await storeForEmail(NO_BIO))!;
  for (const p of pages) await writePage(withBio.statsId!, siteKey(p.id), parsePage({ blocks: [...p.blocks], ...p.seo, hidden: "hidden" in p ? p.hidden : false }), withBio);
  await writePage(noBio.statsId!, siteKey("sentence01"), parsePage({ blocks: [hero("hero0005", "")] }), noBio);

  const cases = [
    ...pages.map((p) => ({ owner: WITH_BIO, handle: "harborkitchen", store: withBio, ...p, sub: p.blocks[0].sub })),
    { owner: NO_BIO, handle: "quietkitchen", store: noBio, id: "sentence01", slug: "about", title: "About", seo: { seoTitle: "", seoDescription: "" }, from: "sentence", sub: "", hidden: false },
  ];
  for (const c of cases) {
    const name = `${c.title} (${c.from})`;
    answering(new Request(`${ORIGIN}/@${c.handle}/${c.slug}`));
    const meta = await siteMeta({ params: Promise.resolve({ handle: `@${c.handle}`, slug: c.slug }) });
    const session = await openSession(c.owner);
    answering(new Request(`${ORIGIN}/studio/site?page=${c.id}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    const editor = find(await StudioSitePage({ searchParams: Promise.resolve({ page: c.id }) }), PageEditor);
    is(`${name}: the studio mounts the store page editor`, Boolean(editor?.props.site), true);
    const handed = editor?.props.siteSearch as { bio?: string } | undefined;
    is(`${name}: and hands it the store's description`, handed?.bio, c.store.bio);
    const shown = !("hidden" in c && c.hidden);
    const expected = snippet({ ...c.seo, pageTitle: c.title, subheadline: c.sub, storeBio: handed?.bio ?? "", storeName: c.store.name, shown });
    if (expected === "missing") {
      is(`${name}: the rule`, "missing", "present");
      continue;
    }
    is(`${name}: the description comes from where the rule says`, expected.waiting ? "waiting" : expected.descriptionFrom, c.from);
    if (expected.waiting) {
      is(`${name}: kept back, the page is not on the store`, meta.title, "Not found — Marktmorgen");
      continue;
    }
    is(`${name}: the page's title is the rule's`, meta.title, expected.title);
    is(`${name}: the page's description is the rule's`, meta.description, expected.description);
    is(`${name}: and so are the shared link's`, [meta.openGraph?.title, meta.openGraph?.description], [expected.title, expected.description]);
  }

  part("In the editor and the preview");
  const source = readFileSync("components/page-editor.tsx", "utf8");
  is("a store page draws sitePageSnippet when handed the store's description", /site && siteSearch \? \(\s*<SearchSnippetPreview\s*snippet=\{sitePageSnippet\(/.test(source), true);
  is("from the first block's subheadline as typed", source.includes('subheadline: drafts[0]?.block.kind === "hero" ? drafts[0].block.sub : ""'), true);
  is("on the store only with a block, and not while kept back", source.includes("shown: drafts.length > 0 && (!hidden || (showFrom > 0 && clock > 0 && showFrom * 1000 <= clock))"), true);
  const studioSite = readFileSync("app/studio/site/page.tsx", "utf8");
  is("the studio's store pages hand the editor the store's description", studioSite.includes("siteSearch={{ bio: store.bio }}"), true);
  if (rule) {
    const fromBio = renderToStaticMarkup(SearchSnippetPreview({ snippet: rule({ ...base, storeBio: BIO }) as never }));
    is("the title's source names the page's title", fromBio.includes("From the page&#x27;s title and your store&#x27;s name."), true);
    is("the description's source names the store's description", fromBio.includes("From your store&#x27;s description, the line under its name."), true);
    const fromSentence = renderToStaticMarkup(SearchSnippetPreview({ snippet: rule(base) as never }));
    is("with nothing, it says how to use your own words", fromSentence.includes("Write a description above to use your own words."), true);
    const absent = renderToStaticMarkup(SearchSnippetPreview({ snippet: rule({ ...base, shown: false }) as never }));
    is("not on the store yet, it says search engines get nothing from it", absent.includes("This page is not on your store yet, because it is hidden or has no blocks, so search engines get nothing from it."), true);
  } else is("the preview's words for a store page", "missing", "present");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
