import type { NextRequest } from "next/server";
import { handleTaken, normaliseHandle, storeForHandle } from "@/lib/store";
import { classifySource, cleanTag } from "@/lib/stats";
import { countAffiliateClick, countHit, countVisit, isStorePeople } from "@/lib/visit";
import { isBot } from "@/lib/source-rules";
import { funnelMark, stepIndex } from "@/lib/page-funnel";
import { countFunnelStep, funnelVisitor, readPageFunnel } from "@/lib/page-funnel-store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { productIdFor } from "@/lib/catalog";
import { markCountGap, takeSignal } from "@/lib/traffic";
import { type CountKind, HIT_STORE_LIMIT, shareAddress } from "@/lib/traffic-rules";
import { affiliatesOn } from "@/lib/affiliates";
import { browserProof } from "@/lib/bot-check";

const MAX_BODY_BYTES = 1_500;

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/** How often one server writes down, for one store and one kind, the counts a flood past HIT_STORE_LIMIT refused. */
const FLOOD_MARK_MS = 60_000;
/** The last time this server wrote it, by store and kind: at most FLOOD_MARKS_KEPT of them, the oldest let go first. */
const floodMarked = new Map<string, number>();
const FLOOD_MARKS_KEPT = 1_000;

/**
 * Writes down that a flood past the store's ten minutes refused some of its counts (lib/traffic.ts, markCountGap),
 * at most once a minute for a store and a kind on this server (Claude 5 on b2acc71c18, L1): every request of a flood
 * used to read the address's index and write the mark, three commands each. The mark keeps its first time and its
 * last to within a minute, and the pages say the day.
 */
async function floodMark(handle: string, what: CountKind): Promise<void> {
  const at = Date.now();
  const id = `${what}|${handle}`;
  const last = floodMarked.get(id);
  if (last !== undefined && at - last < FLOOD_MARK_MS) return;
  floodMarked.delete(id);
  if (floodMarked.size >= FLOOD_MARKS_KEPT) floodMarked.delete(floodMarked.keys().next().value as string);
  floodMarked.set(id, at);
  if (await handleTaken(handle).catch(() => false)) await markCountGap(handle, what, at);
}

/**
 * A store page saying it was opened, or that one of its links was.
 *
 * Sent by the page itself (components/store-beacon.tsx), through the host's
 * browser check, so a visit is counted only when a real browser ran the page
 * — not when a crawler or a link preview fetched it, and not when a program
 * sent the count on its own. The answer is always empty: nothing here is worth telling the caller,
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
  // A page sends one of these per visit and per click; a script sending
  // thousands would only inflate the creator's numbers, so it stops counting.
  // A funnel's steps have an allowance of their own, so a person browsing the
  // store at length never crowds out the steps they walk afterwards: one
  // person walks twenty at most. Both are asked before the store's record is
  // read (up to MAX_STORE_BYTES), and so is the store's own allowance, so a
  // refused count reads nothing but its counter (independent review of #1496,
  // 4 November 2026; until then the record was read first).
  // A robot that says it is one is never counted (lib/visit.ts): left out
  // before any allowance is asked, so it neither spends one nor marks the
  // store's counts as not whole.
  if (isBot(request.headers.get("user-agent") ?? "")) return done();
  const kind = read("k", 2);
  const allowance = kind === "f" ? (["hit-funnel", 60] as const) : (["hit", 120] as const);
  // The address as one site is handed it (lib/traffic-rules.ts, shareAddress:
  // a /48 for the new kind), so a machine with a block of its own is one.
  const address = clientAddress(request);
  const from = shareAddress(address) || address;
  // One address's allowance is one address's alone: what it sends past it is
  // left out as a repeat and never written down, or one machine could hide any
  // store's rates (Claude 5 on b2acc71c18, 7 November 2026, M1).
  if (!(await withinLimit(allowance[0], `${from}|${handle}`, allowance[1], 600))) return done();
  // The store's own ten minutes for what is not a page (lib/traffic-rules.ts, HIT_STORE_LIMIT): views and pages are
  // never under it. Past it many machines at once were sending, and counts may have been lost: written down, under the
  // kind of count refused, for a store that exists, so no rate is shown from counts that were not whole.
  if (kind !== "v" && kind !== "p" && !(await withinLimit("hit-store", handle, HIT_STORE_LIMIT, 600))) {
    await floodMark(handle, kind === "f" ? "steps" : "clicks");
    return done();
  }
  // A page opened (a visit, another page, a funnel's step) is counted only when the host's check says a person's
  // browser sent this (lib/bot-check.ts, browserProof). A program, a check that failed or did not answer, is counted
  // nowhere: not toward the visits the store's plan covers, never in its numbers as a visit. What pages cost is still
  // bounded where they are drawn (lib/traffic.ts, isResting: every request against the store's window and its
  // connection's share of the day). Asked before the store's record is read, so a program reads nothing more.
  if ((kind === "v" || kind === "p" || kind === "f") && (await browserProof()) !== "human") return done();
  const store = await storeForHandle(handle).catch(() => null);
  if (!store) return done();

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
    // A click on one of the store's links, an affiliate's visit and a
    // funnel's step are not a page of a visit: each is written inside one of
    // the store's signals (lib/traffic.ts, takeSignal; lib/traffic-rules.ts,
    // SIGNALS_PER_VISIT), once everything that costs nothing has passed and
    // the store's own people are known not to be the ones looking. A signal
    // is kept only when something was written (a new funnel step, an approved
    // affiliate's click new today), each connection takes its share of a day
    // at most, and past the window's the count is not made (4 November 2026,
    // independent review of #1496). Never the requests the store's pages are
    // drawn from: these never bring its pages to rest.
    const id = read("id", 40);
    if (store.statsId && store.links.some((link) => link.id === id) && !isBot(request.headers.get("user-agent") ?? "")) {
      await countHit(request, store, { kind: "link", id }, (write) => takeSignal(store, write));
    }
  } else if (kind === "f") {
    // A step of a funnel of pages was opened (lib/page-funnel.ts): one person
    // once for that step, never the store's own people, and only for a page
    // or product that is one of the funnel's steps.
    const userAgent = request.headers.get("user-agent") ?? "";
    if (!store.statsId || isBot(userAgent)) return done();
    const statsId = store.statsId;
    const funnel = await readPageFunnel(statsId, funnelMark(read("f", 10))).catch(() => null);
    const step = read("t", 1) === "g" ? "page" : "product";
    const index = funnel?.on ? stepIndex(funnel, step, read("id", 40)) : -1;
    if (funnel && index >= 0 && !(await isStorePeople(request, store))) {
      await takeSignal(store, () => countFunnelStep(statsId, funnel, index, funnelVisitor(statsId, funnel.id, clientAddress(request), userAgent)), Date.now(), "signals", "steps");
    }
  } else if (kind === "a") {
    // A visit through an affiliate's link: counted for them, once a day.
    // `p`: the link was reached from a paid search ad (components/affiliate-click.tsx), counted apart.
    // One from a paid ad is counted on a pool of its own (lib/traffic-rules.ts, PAID_ARRIVALS_PER_VISIT), so the
    // mark the creator's paid-search hold reads never stops because the store's other clicks were many.
    const code = read("c", 20).toLowerCase();
    const paid = read("p", 2) === "1";
    if (code && affiliatesOn(store)) await countAffiliateClick(request, store, code, paid, (write) => takeSignal(store, write, Date.now(), paid ? "paid" : "signals"));
  }
  return done();
}
