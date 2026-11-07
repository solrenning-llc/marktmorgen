/**
 * 601 [KB22] U7: a draft product's own page, previewed by the people who
 * work on it (docs/reviews/c5-kb22-audit.md, row 10).
 *
 * A draft is left off the store, its page and its checkout (MM-SA-30,
 * tests/draft-view.test.ts). Its owner, and a team member who may edit
 * products, signed in on the studio's session, see its page as a buyer
 * would before they publish it, under a "Preview" notice of its own, and
 * nothing else changes:
 *
 *   - nobody else sees it: a visitor, someone signed in who is not on the
 *     team, a support member (who may not edit products), a member held at
 *     the team's two-step door, a session that cannot be read;
 *   - it is never indexed (noindex, nofollow) and says nothing to search
 *     engines (no structured data);
 *   - it never sells: no checkout form, no cart, no gift or group box, no
 *     reminder form; the buy button is drawn, not pressed, and says so;
 *   - it never counts a visit, a public request, a page test or a funnel
 *     step, and leaves no work for after the answer;
 *   - it is paid in studio requests (STUDIO_PAGE_UNITS) before the page's
 *     own records are read; refused, they are not read at all.
 *
 * Real page, against the in-memory store of the tests; next/headers reads
 * the request each call answers (tests/security/next-headers.ts).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BuildOptions } from "esbuild";
import type { Metadata } from "next";
import { createDefaultMetadata } from "next/dist/lib/metadata/default-metadata";
import { mergeMetadata, postProcessMetadata } from "next/dist/lib/metadata/metadata-resolution-primitives";
import type { ResolvedMetadata } from "next/dist/lib/metadata/types/metadata-interface";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ProductPage, { generateMetadata as productMeta } from "@/app/[handle]/p/[product]/page";
import StoreLayout, { generateMetadata as storeLayoutMeta } from "@/app/[handle]/layout";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { SITE_OG_IMAGE } from "@/lib/site-og";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember, setRequireTwoStep } from "@/lib/team";
import { allowanceUsed, allowancesUsedStrict, forceAllowance } from "@/lib/store-allowance";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { writeAbout } from "@/lib/product-about";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setInboxSetting, setProductAbout, setProductHidden, setProductPage, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { afterTasks } from "./next-server-after-world";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";
const EDITOR = "editor@example.com";
const SUPPORT = "support@example.com";
const STRANGER = "someone@example.com";
const BASE = "https://marktmorgen.com";
const ABOUT = "Twelve lessons on glazes that hold their color in the kiln.";

/** A page drawn to HTML, as a browser gets it; or what it threw instead (a redirect, not found). */
async function html(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest) return `thrown ${digest}`;
    throw error;
  }
}

/** Every key the commands sent while `run` ran touched, in order. */
async function commandsDuring<T>(run: () => Promise<T>): Promise<{ result: T; keys: string[] }> {
  const real = redis.pipeline.bind(redis);
  const keys: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) keys.push(`${String(c[0])} ${String(c[1] ?? "")}`);
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), keys };
  } finally {
    redis.pipeline = real;
  }
}

/** The store's public counts: visits, requests, page tests, funnels, as they stand. */
async function publicCounts(): Promise<string> {
  const keys = redis.keys().filter((k) => k.startsWith("nl:traffic:") || k.startsWith("nl:ab:") || k.startsWith("nl:funnel:") || k.startsWith("nl:read:")).sort();
  const values = keys.length ? await redis.pipeline(keys.map((k) => ["TYPE", k])) : [];
  return JSON.stringify(keys.map((k, i) => [k, values[i]]));
}

const nodeRequire = createRequire(join(process.cwd(), "package.json"));

/** The site's own layout metadata (app/layout.tsx), evaluated for real; only Next's build-time fonts and CSS are inert (as tests/site-metadata-opening.test.ts). */
async function rootLayoutMetadata(): Promise<Metadata> {
  const { build } = nodeRequire("esbuild") as typeof import("esbuild");
  const options: BuildOptions = {
    absWorkingDir: process.cwd(),
    entryPoints: ["app/layout.tsx"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@": process.cwd() },
    external: ["next/font/google"],
    loader: { ".css": "empty" },
    logLevel: "error",
  };
  const result = await build(options);
  const evaluated = { exports: {} as { metadata: Metadata } };
  const requireWithFonts = (name: string) =>
    name === "next/font/google"
      ? Object.fromEntries(["Geist", "Instrument_Serif", "Fraunces", "Playfair_Display", "Nunito", "Bricolage_Grotesque"].map((font) => [font, (f: { variable: string }) => ({ variable: f.variable, className: "synthetic-font" })]))
      : nodeRequire(name);
  new Function("require", "module", "exports", result.outputFiles![0].text)(requireWithFonts, evaluated, evaluated.exports);
  return evaluated.exports.metadata;
}

/**
 * The metadata a browser gets for the product page: the site's layout, the
 * store's layout and the page, merged in Next's own order with Next's own
 * functions, with the picture of opengraph-image.tsx beside the page as the
 * file convention adds it (synthetic URL).
 */
async function mergedMetadata(segments: Metadata[], pathname: string): Promise<ResolvedMetadata> {
  const context = { trailingSlash: false, isStaticMetadataRouteFile: false };
  const titleTemplates = { title: null, twitter: null, openGraph: null };
  let resolved = createDefaultMetadata();
  for (const [i, metadata] of segments.entries()) {
    const last = i === segments.length - 1;
    const staticFilesMetadata = last
      ? { icon: undefined, apple: undefined, twitter: undefined, manifest: undefined, openGraph: [{ url: `https://marktmorgen.com${pathname}/opengraph-image?synthetic`, width: 1200, height: 630, type: "image/png", alt: "A product, its price and the store that sells it" }] }
      : null;
    resolved = await mergeMetadata("/[handle]/p/[product]", Promise.resolve(pathname), {
      metadata,
      resolvedMetadata: resolved,
      staticFilesMetadata,
      titleTemplates,
      metadataContext: context,
      buildState: { warnings: new Set() },
      leafSegmentStaticIcons: { icon: [], apple: [] },
    });
  }
  return postProcessMetadata(resolved, undefined, titleTemplates, context);
}

const imageUrl = (image: string | { url: string }): string => (typeof image === "string" ? image : String(image.url));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze chemistry course", "", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  let store = (await storeForEmail(OWNER)) as Store;
  if (!store.statsId || !store.sid) throw new Error("no store ids");
  await writeAbout(store.statsId, id, ABOUT, ROOM, true);
  const about = await setProductAbout(OWNER, id, true);
  if (!about.ok) throw new Error("no about");
  if (!(await putMember(store, EDITOR, "editor"))) throw new Error("no editor");
  if (!(await putMember(store, SUPPORT, "support"))) throw new Error("no support member");

  const sessions = {
    stranger: "",
    signedInStranger: await openSession(STRANGER),
    support: await openSession(SUPPORT),
    owner: await openSession(OWNER),
    editor: await openSession(EDITOR),
  };
  type Who = keyof typeof sessions;
  const args = () => ({ params: Promise.resolve({ handle: "@kilnworks", product: id }), searchParams: Promise.resolve({}) });
  const asked = (who: Who) =>
    answering(new NextRequest(`${BASE}/@kilnworks/p/${id}`, { headers: sessions[who] ? { cookie: `${SESSION_COOKIE}=${sessions[who]}` } : {} }));
  const page = async (who: Who) => {
    asked(who);
    return html(() => ProductPage(args()));
  };
  const meta = async (who: Who) => {
    asked(who);
    return productMeta(args());
  };
  const root = await rootLayoutMetadata();
  const merged = async (who: Who) => {
    asked(who);
    const layout = await storeLayoutMeta({ params: Promise.resolve({ handle: "@kilnworks" }) } as never);
    const own = await meta(who);
    return mergedMetadata([root, layout, own], `/@kilnworks/p/${id}`);
  };
  const studioUsed = async () => allowanceUsed((await storeForEmail(OWNER)) as Store, "studio");
  const previewRegion = /<section[^>]*aria-label="Preview"/;

  part("Published: the page as before, with no preview notice");
  const published = await page("stranger");
  is("drawn for a visitor", published.startsWith("redirect") || published.startsWith("thrown"), false);
  is("its about text is there", published.includes(ABOUT), true);
  is("no preview notice on a published page", previewRegion.test(published), false);
  is("its tab is indexable, as before", (await meta("stranger")).robots, { index: true, follow: true });
  const publishedMeta = await merged("stranger");
  is("merged with the layouts: it has its canonical address", String(publishedMeta.alternates?.canonical?.url ?? "").includes(`/@kilnworks/p/`), true);
  is("merged with the layouts: a card for a shared link, with its title", String(publishedMeta.openGraph?.title?.absolute ?? "").includes("Glaze chemistry course"), true);

  const hid = await setProductHidden(OWNER, id, true);
  if (!hid.ok) throw new Error(`not hidden: ${hid.reason}`);

  for (const who of ["stranger", "signedInStranger", "support"] as const) {
    part(`A draft, to ${who === "stranger" ? "a visitor who knows its id" : who === "support" ? "a support member, who may not edit products" : "someone signed in who is not on the team"}`);
    const before = await studioUsed();
    is("sent to the store, as an id that does not exist", await page(who), "redirect /@kilnworks");
    const m = await meta(who);
    is("its tab does not name the draft", m.title, "Not found — Marktmorgen");
    is("no studio request is taken for them", await studioUsed(), before);
  }

  for (const who of ["owner", "editor"] as const) {
    part(`A draft, previewed by the store's ${who}`);
    const countsBefore = await publicCounts();
    const tasksBefore = afterTasks.length;
    const usedBefore = await studioUsed();
    const { result: drawn, keys } = await commandsDuring(() => page(who));
    is("the page is drawn", drawn.startsWith("redirect") || drawn.startsWith("thrown"), false);
    is("as a buyer would see it: its about text is there", drawn.includes(ABOUT), true);
    is("its title is there", drawn.includes("Glaze chemistry course"), true);
    is("a preview notice in a landmark of its own, named Preview", previewRegion.test(drawn), true);
    is("the notice says only the team sees it and buying is off", /Only you and your team can see this page/.test(drawn) && /Buying is off/.test(drawn), true);
    is("the notice is marked as US English, whatever the store's language", /<section[^>]*lang="en-US"[^>]*aria-label="Preview"|<section[^>]*aria-label="Preview"[^>]*lang="en-US"/.test(drawn), true);
    is("a way back to the studio's products", drawn.includes('href="/studio#products"'), true);
    is("no checkout form", /\/api\/store\/checkout|data-checkout/.test(drawn), false);
    is("no structured data for search engines", drawn.includes("application/ld+json"), false);
    is("the buy button is drawn, not pressed, and says it is a preview", /Buy button preview/.test(drawn), true);
    is("no button posts anywhere", /<form/.test(drawn), false);
    is("nothing counted: visits, requests, page tests, funnels", await publicCounts(), countsBefore);
    is("no work left for after the answer", afterTasks.length, tasksBefore);
    is(`paid as one studio page (${STUDIO_PAGE_UNITS} studio requests)`, (await studioUsed()) - usedBefore, STUDIO_PAGE_UNITS);
    const charged = keys.findIndex((k) => k.startsWith("INCRBY nl:allow:studio:") || k.startsWith("EVAL") || k.includes("nl:allow:studio:"));
    const readAboutAt = keys.findIndex((k) => k.includes("nl:product:about:"));
    is("the studio requests are taken before the page's records are read", charged >= 0 && readAboutAt > charged, true);
    const m = await meta(who);
    is("its tab says Preview and names the draft", m.title, "Preview: Glaze chemistry course — Kiln Works");
    is("never indexed, never followed", m.robots, { index: false, follow: false, nocache: true });
    is("the page itself asks for no canonical address and none of the site's card", [m.alternates, m.openGraph, m.twitter], [{ canonical: null }, null, null]);
    const all = await merged(who);
    is("merged with the layouts: no canonical address", all.alternates?.canonical ?? null, null);
    is("merged with the layouts: never indexed", [all.robots?.basic ?? null].join(""), "noindex, nofollow, nocache");
    is("merged with the layouts: none of the site's card (site name, locale, its picture)", [all.openGraph?.siteName ?? null, all.openGraph?.locale ?? null, (all.openGraph?.images ?? []).some((image) => imageUrl(image).includes(String(SITE_OG_IMAGE.url)))], [null, null, false]);
    is("merged with the layouts: the only picture is the page's own card file, which draws no draft", (all.openGraph?.images ?? []).map(imageUrl), [`https://marktmorgen.com/@kilnworks/p/${id}/opengraph-image?synthetic`]);
    is("no store chat or assistant can be opened: the corner is hidden on a preview", /\[data-store-corner\]\{display:none!important\}/.test(drawn), true);
  }

  part("The store's chat, drawn by the store's layout around a preview, is hidden");
  if (!(await setInboxSetting(OWNER, { chat: true, saved: [] })).ok) throw new Error("no chat");
  asked("owner");
  const around = await html(async () => StoreLayout({ children: await ProductPage(args()), params: Promise.resolve({ handle: "@kilnworks" }) } as never));
  is("the layout draws the chat in a corner the page can hide", /<div[^>]*data-store-corner[^>]*>/.test(around), true);
  is("and the preview hides that corner", /\[data-store-corner\]\{display:none!important\}/.test(around), true);
  if (!(await setProductHidden(OWNER, id, false)).ok) throw new Error("not published");
  asked("stranger");
  const publicAround = await html(async () => StoreLayout({ children: await ProductPage(args()), params: Promise.resolve({ handle: "@kilnworks" }) } as never));
  is("a published page keeps its chat", /<div[^>]*data-store-corner[^>]*>/.test(publicAround) && !/\[data-store-corner\]\{display:none/.test(publicAround), true);
  if (!(await setProductHidden(OWNER, id, true)).ok) throw new Error("not hidden again");
  await setInboxSetting(OWNER, { chat: false, saved: [] });

  part("A draft whose page is built from blocks, with a form among them");
  const quiz = await addProduct(OWNER, "Glaze quiz", "", "0", null);
  if (!quiz.ok) throw new Error("no quiz product");
  const formSaved = await (
    await saveForms(new NextRequest(`${BASE}/api/store/forms`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${sessions.owner}` }, body: JSON.stringify({ form: { name: "Kiln survey", fields: [{ id: "kkkkkk", type: "short", label: "Your kiln's make", required: true }] } }) }))
  ).json();
  if (!formSaved.ok) throw new Error("no form");
  store = (await storeForEmail(OWNER)) as Store;
  await writePage(store.statsId!, quiz.product.id, { ...parsePage({}), blocks: [{ id: "blkt01", kind: "text", heading: "Before you start", body: "Bring three test tiles." }, { id: "blkf01", kind: "form", heading: "Tell us about your kiln", form: formSaved.form.id }] } as never, ROOM);
  if (!(await setProductPage(OWNER, quiz.product.id, true)).ok) throw new Error("no page");
  if (!(await setProductHidden(OWNER, quiz.product.id, true)).ok) throw new Error("quiz not hidden");
  const quizArgs = () => ({ params: Promise.resolve({ handle: "@kilnworks", product: quiz.product.id }), searchParams: Promise.resolve({}) });
  answering(new NextRequest(`${BASE}/@kilnworks/p/${quiz.product.id}`, { headers: { cookie: `${SESSION_COOKIE}=${sessions.owner}` } }));
  const quizDrawn = await html(() => ProductPage(quizArgs()));
  is("its blocks are drawn", quizDrawn.includes("Bring three test tiles."), true);
  is("under the preview notice", previewRegion.test(quizDrawn), true);
  is("no form at all: nothing can be sent from a preview", /<form/.test(quizDrawn), false);
  is("nothing posts to the store's form address", quizDrawn.includes("/api/store/form"), false);
  is("no submit button", /type="submit"/.test(quizDrawn), false);

  part("A team that requires two-step sign-in, as the studio reads it");
  if (!(await setRequireTwoStep(store, true, OWNER))) throw new Error("two-step not required");
  is("a member whose session had no second step is sent to the store", await page("editor"), "redirect /@kilnworks");
  is("the owner still previews it", previewRegion.test(await page("owner")), true);
  await setRequireTwoStep(store, false, OWNER);

  part("What cannot be read is a no");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[0]) === "GET" && String(c[1]).startsWith("nl:auth:session"))) throw new Error("store down");
    return real(commands);
  }) as typeof redis.pipeline;
  is("a session that cannot be read: sent to the store", await page("owner"), "redirect /@kilnworks");
  redis.pipeline = real;

  part("The studio's requests used up: the preview is refused before its records are read");
  store = (await storeForEmail(OWNER)) as Store;
  const figure = (await allowancesUsedStrict(store, ["studio"]))?.[0];
  if (!figure) throw new Error("no studio figure");
  if (!(await forceAllowance(store, "studio", Math.max(1, figure.figure - figure.used)))) throw new Error("not used up");
  const { result: refused, keys: refusedKeys } = await commandsDuring(() => page("owner"));
  is("a plain notice is drawn instead", /Preview not available/.test(refused), true);
  is("the draft's about text is not read", refusedKeys.some((k) => k.includes("nl:product:about:")), false);
  is("nor shown", refused.includes(ABOUT), false);
  is("no checkout form", /\/api\/store\/checkout|data-checkout/.test(refused), false);

  part("Published again: the preview is gone and the page is public as before");
  const shown = await setProductHidden(OWNER, id, false);
  if (!shown.ok) throw new Error("not published");
  const back = await page("owner");
  is("no preview notice once it is published", previewRegion.test(back), false);
  is("its tab is indexable again", (await meta("owner")).robots, { index: true, follow: true });

  part("The studio offers the preview on a draft");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("a draft's row links to its page to preview it, in a new tab", /product\.hidden \? \([\s\S]{0,900}href=\{`\/@\$\{handle\}\/p\/\$\{productSegment\(product\)\}`\}[\s\S]{0,300}Preview its page/.test(editor), true);

  part("Its cost is the studio's own line");
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the studio line names the product page's preview charge", registry.includes('{ file: "app/[handle]/p/[product]/page.tsx", names: ["countStudio(found.store, null, STUDIO_PAGE_UNITS)"'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
