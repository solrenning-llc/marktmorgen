/**
 * C4-20261106-2610-C6-153, unit B (Codex T's proof 64b3a0a9; unit A, #2830, made readPage throw on an unknown read):
 * what shows a page, or answers from one, never takes a read whose answer is not known for an empty page or for no
 * page. Each check sends the real page or route the real store; only Redis's answer to the page's GET changes (no
 * reply at all, or a text that is not a page).
 *   - The public product page says "Not available right now." in a status line, keeps itself out of search (noindex)
 *     and offers no checkout, instead of showing the product as if it had no page.
 *   - The studio's page editors (a product's, a store page's) say the page could not be read and show no editor, so
 *     nothing empty can be saved over the page. The product editor keeps its list of products, to choose another, and
 *     the note a buyer reads after paying, which is read on its own (Claude 6's review of #2832, LIGHT 1).
 *   - The studio's reach and page-test numbers answer 503 page_unread, not a server error.
 *   - The page after a free sign-up shows no "next" product it could not confirm, and says nothing is missing.
 *   - The store assistant's facts and the affiliate kit's read refuse, so no model is asked from facts with the page
 *     left out.
 * The store can sell (a stand-in Stripe account and subscription, a product that hands over a link), so the read-as-it-is
 * controls show the buy box and the "next" card, and their absence on an unknown read means something (Claude 6's
 * review of #2832, LIGHT 2). Nothing reaches Stripe: `fetch` is a stand-in that refuses.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import ProductPage, { generateMetadata as productMeta } from "@/app/[handle]/p/[product]/page";
import FreePage from "@/app/[handle]/free/page";
import StudioSitePage from "@/app/studio/site/page";
import StudioPagesPage from "@/app/studio/pages/page";
import { GET as depthRoute } from "@/app/api/store/depth/route";
import { GET as abRoute } from "@/app/api/store/ab/route";
import { readAssistantFacts } from "@/lib/store-assistant";
import * as kit from "@/lib/affiliate-kit";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductPage, setSitePages, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { PageEditor } from "@/components/page-editor";
import { ThanksNoteEditor } from "@/components/thanks-note-editor";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_page_show_only";
// Nothing here may reach Stripe or any other service: every request is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const OWNER = "page-show@example.com";
const ORIGIN = "https://marktmorgen.com";
const SITE = "ffffffffff";
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


/**
 * Whether a page's element tree holds an element of this component, or this text. The studio's editors are client
 * components that need Next's app router to render to HTML, which a test has not got; what the page returns is read
 * instead: the editor it would mount, and the words it would say.
 */
function holds(node: unknown, want: { component?: unknown; text?: string }): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") return want.text !== undefined && String(node).includes(want.text);
  if (Array.isArray(node)) return node.some((child) => holds(child, want));
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (want.component !== undefined && element.type === want.component) return true;
  const props = element.props ?? {};
  return Object.values(props).some((value) => typeof value === "object" || typeof value === "string" ? holds(value, want) : false);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pageshow", "Page show", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPageShow001", true);
  await setSubscription(OWNER, { customerId: "cus_PageShow0001", subscriptionId: "sub_PageShow0001", active: true, period: paidPeriod() });
  const paid = await addProduct(OWNER, "Guide", "A guide.", "19", null);
  const free = await addProduct(OWNER, "Sampler", "A free sampler.", "0", null);
  if (!paid.ok || !free.ok) throw new Error("setup");
  if (!(await setProductLink(OWNER, paid.product.id, "https://example.com/guide")).ok) throw new Error("setup");
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const hero = (id: string, headline: string) => ({ id, kind: "hero", headline, sub: "For busy parents", media: "none", video: null });
  const cta = (id: string) => ({ id, kind: "cta", label: "", note: "" });
  const faq: PageBlock = { ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), id: "faq00001", items: [{ q: "Is it a PDF?", a: "Yes, a PDF of forty pages." }] };
  if (!(await setProductPage(OWNER, paid.product.id, true)).ok || !(await setProductPage(OWNER, free.product.id, true)).ok) throw new Error("setup");
  await writePage(statsId, paid.product.id, parsePage({ blocks: [hero("hero0001", "Forty dinners"), faq, cta("cta00001")], variant: { blocks: [hero("hero0002", "Dinner, sorted"), cta("cta00002")] } }), shop);
  await writePage(statsId, free.product.id, parsePage({ blocks: [hero("hero0003", "A free week")], next: paid.product.id }), shop);
  if (!(await setSitePages(OWNER, [{ id: SITE, slug: "about", title: "About", nav: true, target: "", from: 0 }])).ok) throw new Error("setup");
  await writePage(statsId, siteKey(SITE), parsePage({ blocks: [hero("hero0004", "About us")] }), shop);
  // The store as it is now, with both products' pages on (the one read above was taken before).
  const now = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const headers = { cookie: `${SESSION_COOKIE}=${session}` };
  const get = (path: string) => new NextRequest(`${ORIGIN}${path}`, { headers });
  const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

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

  const productParams = { params: Promise.resolve({ handle: "@pageshow", product: paid.product.id }), searchParams: Promise.resolve({}) };
  part("The public product page, read as it is: its page, in search");
  answering(new Request(`${ORIGIN}/@pageshow/p/${paid.product.id}`));
  const shown = await html(() => ProductPage(productParams));
  is("its headline is shown", shown.includes("Forty dinners") || shown.includes("Dinner, sorted"), true);
  is("with its buy box (so its absence below means something)", shown.includes("/api/store/checkout"), true);
  is("in search", (await productMeta(productParams)).robots, { index: true, follow: true });

  for (const mode of ["no reply", "not a page"] as const) {
    part(`A page read answered ${mode}`);
    const page = await unknown(mode, () => html(() => ProductPage(productParams)));
    is(`${mode}: the product page says it is not available right now, in a status line`, /role="status"[^>]*>Not available right now\./.test(page), true);
    is(`${mode}: and offers no checkout`, page.includes("/api/store/checkout"), false);
    const meta = await unknown(mode, () => productMeta(productParams));
    is(`${mode}: kept out of search`, (meta.robots as { index?: boolean } | undefined)?.index, false);

    answering(new Request(`${ORIGIN}/studio/pages?product=${paid.product.id}`, { headers }));
    const editor = await unknown(mode, () => StudioPagesPage({ searchParams: Promise.resolve({ product: paid.product.id }) }).catch((error: Error) => `thrown ${error.name}`));
    is(`${mode}: the studio's page editor says the page could not be read`, holds(editor, { text: STUDIO_MESSAGES.page_unread }), true);
    is(`${mode}: and mounts no editor that could save over it`, holds(editor, { component: PageEditor }), false);
    is(`${mode}: and keeps the list of products, to choose another`, holds(editor, { text: "Sampler" }), true);
    is(`${mode}: and the note a buyer reads after paying, which is read on its own`, holds(editor, { component: ThanksNoteEditor }), true);

    answering(new Request(`${ORIGIN}/studio/site?page=${SITE}`, { headers }));
    const site = await unknown(mode, () => StudioSitePage({ searchParams: Promise.resolve({ page: SITE }) }).catch((error: Error) => `thrown ${error.name}`));
    is(`${mode}: the store page editor says the page could not be read`, holds(site, { text: STUDIO_MESSAGES.page_unread }), true);
    is(`${mode}: and mounts no editor that could save over it`, holds(site, { component: PageEditor }), false);

    is(`${mode}: how far the page is read: 503 page_unread`, await unknown(mode, async () => result(await depthRoute(get(`/api/store/depth?id=${paid.product.id}`)))), [503, "page_unread"]);
    is(`${mode}: the page test's numbers: 503 page_unread`, await unknown(mode, async () => result(await abRoute(get(`/api/store/ab?id=${paid.product.id}`)))), [503, "page_unread"]);

    answering(new Request(`${ORIGIN}/@pageshow/free`));
    const after = await unknown(mode, () => html(() => FreePage({ params: Promise.resolve({ handle: "@pageshow" }), searchParams: Promise.resolve({ status: "sent", product: free.product.id }) })));
    is(`${mode}: after a free sign-up, no next product it could not confirm`, after.includes('id="next-title"'), false);

    let facts: string | Error;
    try { facts = await unknown(mode, () => readAssistantFacts(now)); } catch (error) { facts = error as Error; }
    is(`${mode}: the assistant's facts refuse instead of leaving the page out`, facts instanceof Error, true);

    const kitRead = (kit as Record<string, unknown>).kitPageRead as ((store: typeof shop, product: unknown) => Promise<unknown>) | undefined;
    const product = await readListing(now, paid.product.id);
    is(`${mode}: the affiliate kit's read of the page says unread, not none`, kitRead ? await unknown(mode, () => kitRead(now, product)) : "missing", "unread");
  }

  part("Read as it is, everything else goes on as before");
  answering(new Request(`${ORIGIN}/studio/pages?product=${paid.product.id}`, { headers }));
  is("the studio's page editor, read as it is, mounts the editor (so its absence above means something)", holds(await StudioPagesPage({ searchParams: Promise.resolve({ product: paid.product.id }) }), { component: PageEditor }), true);
  answering(new Request(`${ORIGIN}/studio/site?page=${SITE}`, { headers }));
  is("the store page editor, read as it is, mounts the editor", holds(await StudioSitePage({ searchParams: Promise.resolve({ page: SITE }) }), { component: PageEditor }), true);
  answering(new Request(`${ORIGIN}/@pageshow/free`));
  const fine = await html(() => FreePage({ params: Promise.resolve({ handle: "@pageshow" }), searchParams: Promise.resolve({ status: "sent", product: free.product.id }) }));
  is("after a free sign-up, the next product the page names, for sale here (so its absence above means something)", fine.includes('id="next-title"'), true);
  is("the assistant's facts are read with the page: its questions are in them", (await readAssistantFacts(now)).includes("Is it a PDF?"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
