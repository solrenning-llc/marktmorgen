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
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ProductPage, { generateMetadata as productMeta } from "@/app/[handle]/p/[product]/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember, setRequireTwoStep } from "@/lib/team";
import { allowanceUsed, allowancesUsedStrict, forceAllowance } from "@/lib/store-allowance";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { writeAbout } from "@/lib/product-about";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductAbout, setProductHidden, setSubscription, storeForEmail, type Store } from "@/lib/store";
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
  const studioUsed = async () => allowanceUsed((await storeForEmail(OWNER)) as Store, "studio");
  const previewRegion = /<section[^>]*aria-label="Preview"/;

  part("Published: the page as before, with no preview notice");
  const published = await page("stranger");
  is("drawn for a visitor", published.startsWith("redirect") || published.startsWith("thrown"), false);
  is("its about text is there", published.includes(ABOUT), true);
  is("no preview notice on a published page", previewRegion.test(published), false);
  is("its tab is indexable, as before", (await meta("stranger")).robots, { index: true, follow: true });

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
    is("no canonical address and no card for a shared link", [m.alternates, m.openGraph, m.twitter], [undefined, undefined, undefined]);
  }

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
