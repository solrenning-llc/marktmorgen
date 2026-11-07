import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { classifySource, cleanTag } from "@/lib/stats";
import { countAffiliateClick, countHit, countVisit, isStorePeople } from "@/lib/visit";
import { isBot } from "@/lib/source-rules";
import { funnelMark, stepIndex } from "@/lib/page-funnel";
import { countFunnelStep, funnelVisitor, readPageFunnel } from "@/lib/page-funnel-store";
import { clientAddress, fromAnotherSite, limited, withinLimit, unknownLimit } from "@/lib/request-guard";
import { productIdFor } from "@/lib/catalog";

const MAX_BODY_BYTES = 1_500;

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * A store page saying it was opened, or that one of its links was.
 *
 * Sent by the page itself with sendBeacon, so a visit is counted only when a
 * real browser ran the page — not when a crawler or a link preview fetched
 * it. The answer is always empty: nothing here is worth telling the caller,
 * and a caller probing for stores learns nothing either.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return done();
  const host = request.headers.get("host");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return done();

  let body: Record<string, unknown> = {};
  try {
    const raw = await (await limited(request, MAX_BODY_BYTES)).text();
    if (raw.length > MAX_BODY_BYTES) return done();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return done();
  }
  const read = (key: string, max: number) => (typeof body[key] === "string" ? (body[key] as string).slice(0, max) : "");

  const handle = normaliseHandle(read("h", 40));
  if (!handle) return done();
  const store = await storeForHandle(handle).catch(() => null);
  if (!store) return done();
  // A page sends one of these per visit and per click; a script sending
  // thousands would only inflate the creator's numbers, so it stops counting.
  // A funnel's steps have an allowance of their own, so a person browsing the
  // store at length never crowds out the steps they walk afterwards: one
  // person walks twenty at most.
  const kind = read("k", 2);
  const allowance = kind === "f" ? (["hit-funnel", 60] as const) : (["hit", 120] as const);
  // Past the limit, or a count that could not be read (unknown, rule 24): not counted, and the answer is the same.
  if ((await withinLimit(allowance[0], `${clientAddress(request)}|${store.handle}`, allowance[1], 600).catch(unknownLimit)) !== true) return done();

  if (kind === "v") {
    const source = classifySource({
      referrer: read("r", 500),
      utm: read("u", 60),
      userAgent: request.headers.get("user-agent") ?? "",
      ownHost: (host ?? "").split(":")[0].toLowerCase(),
    });
    await countHit(request, store, { kind: "view", source, medium: cleanTag(read("m", 60)), campaign: cleanTag(read("g", 60)) });
    // And toward the visits the store's plan covers (lib/traffic.ts).
    await countVisit(request, store);
  } else if (kind === "p") {
    // Another page of the store was opened: a visit all the same. On a
    // product's own page, a person counted for that product too, once a day
    // (lib/stats.ts): what its checkouts and sales are measured against.
    await countVisit(request, store);
    const product = read("p", 40);
    if (product && productIdFor(store, product) === product) await countHit(request, store, { kind: "product", id: product });
  } else if (kind === "l") {
    const id = read("id", 40);
    if (store.links.some((link) => link.id === id)) await countHit(request, store, { kind: "link", id });
  } else if (kind === "f") {
    // A step of a funnel of pages was opened (lib/page-funnel.ts): one person
    // once for that step, never the store's own people, and only for a page
    // or product that is one of the funnel's steps.
    const funnel = await readPageFunnel(store.statsId, funnelMark(read("f", 10))).catch(() => null);
    const step = read("t", 1) === "g" ? "page" : "product";
    const index = funnel?.on ? stepIndex(funnel, step, read("id", 40)) : -1;
    const userAgent = request.headers.get("user-agent") ?? "";
    if (funnel && index >= 0 && store.statsId && !isBot(userAgent) && !(await isStorePeople(request, store))) {
      await countFunnelStep(store.statsId, funnel, index, funnelVisitor(store.statsId, funnel.id, clientAddress(request), userAgent));
    }
  } else if (kind === "a") {
    // A visit through an affiliate's link: counted for them, once a day.
    // `p`: the link was reached from a paid search ad (components/affiliate-click.tsx), counted apart.
    await countAffiliateClick(request, store, read("c", 20).toLowerCase(), read("p", 2) === "1");
  }
  return done();
}
