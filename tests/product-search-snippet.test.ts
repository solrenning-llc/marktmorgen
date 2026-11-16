/**
 * 248 [ST1] unit 3: "What search engines are given" under a product page's search fields in the studio. What the
 * creator is shown is what the public page sends, because both read lib/product-search-snippet.ts:
 *   - the rule itself, in the page's order (own title, else "<product> — <store>"; own description, else the
 *     summary, else the start of About, else the general sentence), with where each part came from;
 *   - the real product page's metadata (generateMetadata) for four synthetic products, one per description
 *     source, equals the rule given what the studio page hands the editor;
 *   - the studio's page for a product hands the editor the About excerpt and the general sentence the public page
 *     would use, and the preview draws the title, the description and where each came from, in plain words;
 *   - the store's own pages (no product, another metadata rule) get no such preview.
 * Synthetic store on the Redis stand-in; nothing reaches Stripe or any other service.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { generateMetadata as productMeta } from "@/app/[handle]/p/[product]/page";
import StudioPagesPage from "@/app/studio/pages/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setProductPage, storeForEmail } from "@/lib/store";
import { writeAbout, aboutExcerpt } from "@/lib/product-about";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { speech } from "@/lib/buyer-words";
import { PageEditor } from "@/components/page-editor";
import * as snippetModule from "@/lib/product-search-snippet";
import * as previewModule from "@/components/search-snippet-preview";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const OWNER = "search-snippet@example.com";
const ORIGIN = "https://marktmorgen.com";
const ABOUT = "Forty weeknight dinners, each ready in thirty minutes, with a shopping list for every week of the year and notes on what keeps.";

type Snippet = { title: string; description: string; titleFrom: string; descriptionFrom: string; waiting?: boolean };
type Input = { seoTitle: string; seoDescription: string; productTitle: string; summary: string; storeName: string; aboutLine: string; general: string; shown?: boolean };
const rule = (snippetModule as Record<string, unknown>).productSearchSnippet as ((input: Input) => Snippet) | undefined;
const Preview = (previewModule as Record<string, unknown>).SearchSnippetPreview as ((props: { snippet: Snippet }) => React.ReactElement) | undefined;
const snippet = (input: Input): Snippet | "missing" => (rule ? rule(input) : "missing");

/** The first element of this component in a page's tree, with its props. */
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

async function main(): Promise<void> {
  const base: Input = { seoTitle: "", seoDescription: "", productTitle: "Dinner guide", summary: "", storeName: "Harbor Kitchen", aboutLine: "", general: "Dinner guide, from the store of Harbor Kitchen." };

  part("The rule, in the page's order");
  is("nothing of its own: the product's and store's names, and the general sentence", snippet(base), {
    title: "Dinner guide — Harbor Kitchen", titleFrom: "default", description: base.general, descriptionFrom: "general", waiting: false,
  });
  is("the start of About comes before the general sentence", snippet({ ...base, aboutLine: "Forty dinners." }), {
    title: "Dinner guide — Harbor Kitchen", titleFrom: "default", description: "Forty dinners.", descriptionFrom: "about", waiting: false,
  });
  is("the summary comes before About", snippet({ ...base, aboutLine: "Forty dinners.", summary: "Dinners in thirty minutes." }), {
    title: "Dinner guide — Harbor Kitchen", titleFrom: "default", description: "Dinners in thirty minutes.", descriptionFrom: "summary", waiting: false,
  });
  const own = { ...base, aboutLine: "Forty dinners.", summary: "Dinners in thirty minutes.", seoTitle: "Forty fast dinners", seoDescription: "A year of weeknight dinners." };
  is("the page's own words come first", snippet(own), {
    title: "Forty fast dinners", titleFrom: "yours", description: "A year of weeknight dinners.", descriptionFrom: "yours", waiting: false,
  });
  is("a field of spaces is empty, as the studio saves it", snippet({ ...base, seoTitle: "   ", seoDescription: "  \n" }), {
    title: "Dinner guide — Harbor Kitchen", titleFrom: "default", description: base.general, descriptionFrom: "general", waiting: false,
  });
  is("a page kept from visitors gives none of its own words, and says it waits", snippet({ ...own, shown: false }), {
    title: "Dinner guide — Harbor Kitchen", titleFrom: "default", description: "Dinners in thirty minutes.", descriptionFrom: "summary", waiting: true,
  });

  part("The real product page's metadata is the rule, for each source of the description");
  redis.clear();
  await claimHandle(OWNER, "harborkitchen", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  const made = await Promise.all([
    addProduct(OWNER, "Own words", "A summary it does not use.", "0", null),
    addProduct(OWNER, "Summary only", "Dinners in thirty minutes.", "0", null),
    addProduct(OWNER, "About only", "", "0", null),
    addProduct(OWNER, "Nothing yet", "", "0", null),
    addProduct(OWNER, "Hidden page", "Kept back for now.", "0", null),
  ]);
  if (made.some((r) => !r.ok)) throw new Error("setup");
  const [ownWords, summaryOnly, aboutOnly, nothing, hiddenPage] = made.map((r) => (r.ok ? r.product : null)!);
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  for (const [product, hidden] of [[ownWords, false], [hiddenPage, true]] as const) {
    if (!(await setProductPage(OWNER, product.id, true)).ok) throw new Error("setup");
    await writePage(statsId, product.id, parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: product.title, sub: "", media: "none", video: null }], seoTitle: "Forty fast dinners", seoDescription: "A year of weeknight dinners.", hidden }), shop);
  }
  const marked = await setProductAbout(OWNER, aboutOnly.id, true);
  if (!marked.ok) throw new Error("setup");
  await writeAbout(statsId, aboutOnly.id, ABOUT, marked.store);
  const now = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const headers = { cookie: `${SESSION_COOKIE}=${session}` };

  const cases = [
    { product: ownWords, from: "yours", seo: { seoTitle: "Forty fast dinners", seoDescription: "A year of weeknight dinners." }, summary: "A summary it does not use.", about: "" },
    { product: hiddenPage, from: "summary", seo: { seoTitle: "Forty fast dinners", seoDescription: "A year of weeknight dinners.", shown: false }, summary: "Kept back for now.", about: "" },
    { product: summaryOnly, from: "summary", seo: { seoTitle: "", seoDescription: "" }, summary: "Dinners in thirty minutes.", about: "" },
    { product: aboutOnly, from: "about", seo: { seoTitle: "", seoDescription: "" }, summary: "", about: ABOUT },
    { product: nothing, from: "general", seo: { seoTitle: "", seoDescription: "" }, summary: "", about: "" },
  ] as const;
  for (const c of cases) {
    const params = { params: Promise.resolve({ handle: "@harborkitchen", product: c.product.id }), searchParams: Promise.resolve({}) };
    answering(new Request(`${ORIGIN}/@harborkitchen/p/${c.product.id}`));
    const meta = await productMeta(params);
    answering(new Request(`${ORIGIN}/studio/pages?product=${c.product.id}`, { headers }));
    const page = await StudioPagesPage({ searchParams: Promise.resolve({ product: c.product.id }) });
    const editor = find(page, PageEditor);
    const name = `${c.product.title} (${c.from})`;
    is(`${name}: the studio's page mounts the editor`, Boolean(editor), true);
    const handed = editor?.props.searchLine as { aboutLine?: string; general?: string } | undefined;
    is(`${name}: the editor is handed the About excerpt the page would use`, handed?.aboutLine, aboutExcerpt(c.about));
    is(`${name}: and the general sentence in the store's language`, handed?.general, speech(now).w.productDescription(c.product.title, now.name));
    const expected = snippet({ ...c.seo, productTitle: c.product.title, summary: c.summary, storeName: now.name, aboutLine: handed?.aboutLine ?? "", general: handed?.general ?? "" });
    is(`${name}: the description comes from where the rule says`, expected === "missing" ? "missing" : expected.descriptionFrom, c.from);
    is(`${name}: the page's title is the rule's`, meta.title, expected === "missing" ? "missing" : expected.title);
    is(`${name}: the page's description is the rule's`, meta.description, expected === "missing" ? "missing" : expected.description);
    is(`${name}: and so are the shared link's`, [meta.openGraph?.title, meta.openGraph?.description], expected === "missing" ? "missing" : [expected.title, expected.description]);
  }

  part("The preview says what is given and where it came from");
  const shown = Preview && rule ? renderToStaticMarkup(Preview({ snippet: rule({ ...base, aboutLine: "Forty dinners." }) })) : "missing";
  is("a named section", /<section[^>]*aria-labelledby="search-snippet-title"/.test(shown) && shown.includes('id="search-snippet-title"'), true);
  is("its heading", shown.includes(">What search engines are given</h3>"), true);
  is("the title given", shown.includes(">Dinner guide — Harbor Kitchen</dd>"), true);
  is("the description given", shown.includes(">Forty dinners.</dd>"), true);
  is("where the title came from, in plain words", shown.includes("From the product&#x27;s name and your store&#x27;s name."), true);
  is("where the description came from", shown.includes("From the start of the product&#x27;s About text."), true);
  is("a page that shows says nothing about waiting", shown.includes("data-snippet-waiting"), false);
  is("no promise of a place in results", shown.includes("nobody can promise a place in results"), true);
  const general = Preview && rule ? renderToStaticMarkup(Preview({ snippet: rule(base) })) : "missing";
  is("with nothing of its own, it says how to use your own words", general.includes("Write a description above to use your own words."), true);
  const waiting = Preview && rule ? renderToStaticMarkup(Preview({ snippet: rule({ ...base, seoTitle: "Forty fast dinners", shown: false }) })) : "missing";
  is("a hidden page says its own words wait until it shows", waiting.includes("This page is hidden, so visitors and search engines get the product&#x27;s plain page."), true);
  is("and gives the product's name meanwhile", waiting.includes(">Dinner guide — Harbor Kitchen</dd>"), true);

  part("In the editor: only on a product's page, from what is typed");
  const source = readFileSync("components/page-editor.tsx", "utf8");
  is("the editor draws the preview from the shared rule", /productSearchSnippet\(\{[^}]*seoTitle[^}]*seoDescription/.test(source) && source.includes("<SearchSnippetPreview"), true);
  is("only when handed a product's search line (never a store page's)", /searchLine && !site \?/.test(source), true);
  is("hidden until its time, as the public page reads it", source.includes("shown: !hidden || (showFrom > 0 && clock > 0 && showFrom * 1000 <= clock)"), true);
  const sitePage = readFileSync("app/studio/site/page.tsx", "utf8");
  is("the store page editor is handed none", sitePage.includes("searchLine"), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
