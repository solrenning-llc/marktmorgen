import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio, jsonAccess } from "@/lib/studio-route";
import { can } from "@/lib/team-roles";
import { fileHeaders } from "@/lib/request-guard";
import { FUNNEL_ID } from "@/lib/page-funnel";
import { type BundleOutline, type FunnelBundle, type PlanLine, leftOutWords, outlineOf, planImport, readBundle } from "@/lib/funnel-bundle";
import { collectBundle, importBundle, receiverOf } from "@/lib/funnel-bundle-store";
import { MONTH_USE_SECONDS, countUse, createShare, listShares, openShare, revokeShare, shareMonthKey, storeMonthKey, storeUseKey } from "@/lib/funnel-share-store";
import { funnelStarter, starterBeforeLines, starterOutline } from "@/lib/funnel-starters";
import {
  DEFAULT_SHARE_DAYS,
  IMPORTS_PER_SHARE_MONTH,
  MAX_BUNDLE_BYTES,
  PREVIEWS_PER_SHARE_MONTH,
  PREVIEWS_PER_STORE_HOUR,
  SHARE_ID,
  bytesWords,
  codeFrom,
  parseShareDays,
  shareLimitsFor,
  shareLink,
  monthOfUse,
  calendarMonthOfUse,
} from "@/lib/funnel-share-rules";
import { SITE_URL } from "@/lib/site-url";
import { UnknownReplyError } from "@/lib/redis-reply";
import { UnknownReply } from "@/lib/redis-exact";
import { STORE_ID_PATTERN, type Store, accountStores, storeRef } from "@/lib/store";

const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, ...extra }, { status });

/**
 * A part of the funnel (the funnel, a page or a form) whose read did not come
 * back in a known shape (lib/funnel-bundle-store.ts collectBundle; the funnel
 * and page reads throw UnknownReplyError, lib/redis-reply.ts, and the form
 * read throws UnknownReply, lib/redis-exact.ts, once #2857 lands): nothing
 * was shared, copied or downloaded from it, and the creator is told so rather
 * than "gone" or a server error (CX-123 rule 24). `counted` when the try was
 * already counted toward a monthly figure, which it keeps, as any other failed try.
 */
const unread = (counted: boolean) => refuse(counted ? "funnel_unread_counted" : "funnel_unread", 503);
const isUnread = (error: unknown) => error instanceof UnknownReplyError || error instanceof UnknownReply;

/** A share entry as the studio sees it: never the hash of its code. */
const shown = (entry: { id: string; name: string; funnelId: string; createdAt: number; expiresAt: number; hint: string }) => ({
  id: entry.id,
  name: entry.name,
  funnelId: entry.funnelId,
  createdAt: entry.createdAt,
  expiresAt: entry.expiresAt,
  hint: entry.hint,
});

type Source =
  | { ok: true; kind: "code"; shareId: string; from: string; outline: BundleOutline; bundle: FunnelBundle | null }
  | { ok: true; kind: "file"; from: string; outline: BundleOutline; bundle: FunnelBundle }
  | { ok: true; kind: "starter"; from: string; outline: BundleOutline; bundle: FunnelBundle; before: PlanLine[] }
  | { ok: false; response: Response };

/**
 * Where a funnel to bring in comes from: a share code (only its outline for a
 * preview, the whole file to import), a file the creator chose, or one of
 * Marktmorgen's starters. Every file is read strictly (lib/funnel-bundle.ts);
 * the store's plan sets how large a file it may bring in.
 */
async function sourceOf(body: Record<string, unknown>, store: Store, want: "preview" | "import"): Promise<Source> {
  const limits = shareLimitsFor(store);
  if (typeof body.starter === "string") {
    const starter = funnelStarter(text(body.starter, 40));
    if (!starter) return { ok: false, response: refuse("unknown", 404) };
    // What to do first is said with what to fill in, and again once it is made.
    return { ok: true, kind: "starter", from: "Marktmorgen", outline: starterOutline(starter), bundle: starter.bundle, before: starterBeforeLines(starter) };
  }
  if (body.bundle !== undefined) {
    const read = readBundle(body.bundle, { maxBytes: limits.bundleBytes });
    if (!read.ok) return { ok: false, response: refuse(`bundle_${read.error}`, 400, { limit: bytesWords(limits.bundleBytes) }) };
    return { ok: true, kind: "file", from: "", outline: outlineOf(read.bundle), bundle: read.bundle };
  }
  const code = codeFrom(body.code);
  if (!code) return { ok: false, response: refuse("code") };
  const opened = await openShare(code, want === "preview" ? "sum" : "bundle");
  if (!opened) return { ok: false, response: refuse("code_gone", 404) };
  // However many stores ask, one link is read only so often a month.
  const fits = await countUse(shareMonthKey(opened.id, want, calendarMonthOfUse()), want === "preview" ? PREVIEWS_PER_SHARE_MONTH : IMPORTS_PER_SHARE_MONTH, MONTH_USE_SECONDS);
  if (!fits) return { ok: false, response: refuse("share_busy", 429) };
  if (want === "preview") {
    const outline = opened.value as BundleOutline;
    if (!outline || typeof outline !== "object" || !Array.isArray(outline.steps) || !Array.isArray(outline.products)) return { ok: false, response: refuse("code_gone", 404) };
    return { ok: true, kind: "code", shareId: opened.id, from: opened.from, outline, bundle: null };
  }
  // A snapshot is read as strictly as any file, against the receiver's own size limit.
  const read = readBundle(opened.value, { maxBytes: limits.bundleBytes });
  if (!read.ok) return { ok: false, response: refuse(`bundle_${read.error}`, 400, { limit: bytesWords(limits.bundleBytes) }) };
  return { ok: true, kind: "code", shareId: opened.id, from: opened.from, outline: outlineOf(read.bundle), bundle: read.bundle };
}

/**
 * Another store of the same account, for a copy between them (18 October
 * 2026): only the account's owner may make one, from one of its stores into
 * another of them. A team member of a store, or a store of anyone else, is
 * never a destination, so a funnel cannot leave the account this way.
 */
async function otherOwnStore(email: string, store: Store, role: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; response: Response }> {
  if (role !== "owner" || email.toLowerCase() !== store.email.toLowerCase()) return { ok: false, response: refuse("owner_only", 403) };
  const to = typeof raw === "string" ? raw : "";
  if (!STORE_ID_PATTERN.test(to) || to === store.sid) return { ok: false, response: refuse("not_yours", 404) };
  const target = (await accountStores(email)).find((s) => s.sid === to && s.email.toLowerCase() === email.toLowerCase());
  if (!target) return { ok: false, response: refuse("not_yours", 404) };
  if (!target.statsId) return { ok: false, response: refuse("unavailable", 503) };
  // A request into that store is one of its own studio requests (lib/store-allowance-rules.ts).
  const counted = await countStudio(target, "page");
  if (!counted.ok) return { ok: false, response: refuse("target_used", 429) };
  return { ok: true, store: counted.store ?? target };
}

const mappingOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [ref, id] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    if (/^x[1-9][0-9]?$/.test(ref) && typeof id === "string" && /^[A-Za-z0-9_-]{0,40}$/.test(id)) out[ref] = id;
  }
  return out;
};

/**
 * Sharing, copying and bringing in funnels of pages (lib/funnel-bundle.ts).
 *
 *   { action: "share", funnel, days }        a share link to a snapshot of one funnel; its code is shown once
 *   { action: "revoke", id }                 that link stops working at once
 *   { action: "preview", code | bundle | starter, products? }
 *                                            what it would make in this store, nothing written
 *   { action: "import", code | bundle | starter, products, name? }
 *                                            makes it here as a draft: pages kept back, funnel off
 *   { action: "clone", funnel }              a copy of one of this store's funnels, in this store
 *   { action: "copy-preview", funnel, to }   what a copy would make in another store of this account, nothing written
 *   { action: "copy", funnel, to, products, name? }
 *                                            the copy, made there as a draft (the account's owner only)
 *
 * A funnel's pages are part of the public page and its steps are products, so
 * every action needs both permissions (lib/team-roles.ts).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", MAX_BUNDLE_BYTES + 20_000);
  if (!guarded.ok) return guarded.response;
  const { store, body, role, ref } = guarded;
  if (!can(role, "products")) return refuse("forbidden", 403);
  if (!store.statsId) return refuse("unavailable", 503);
  const statsId = store.statsId;
  const limits = shareLimitsFor(store);
  const action = text(body.action, 12);
  // The store's window (lib/allowance-window.ts): its billing month when it pays.
  const month = monthOfUse(store);
  if (!month) return refuse("unavailable", 503);

  // Whether this attempt was counted against a figure yet: a read that fails after it says the try still counts
  // (Codex K2 on #2880), and one that fails before it does not.
  const tried = { counted: false };
  try {
    if (action === "share") {
      const funnelId = text(body.funnel, 10);
      if (!FUNNEL_ID.test(funnelId)) return refuse("unknown", 404);
      const days = body.days === undefined ? DEFAULT_SHARE_DAYS : parseShareDays(body.days);
      if (!days) return refuse("days");
      const held = await listShares(statsId);
      if (held.length >= limits.shares) return refuse("shares_full", 400, { limit: limits.shares });
      // Links made in the month, revoked ones included: each writes a snapshot.
      tried.counted = true;
      if (!(await countUse(storeMonthKey(statsId, "share", month), limits.sharesPerMonth, MONTH_USE_SECONDS))) return refuse("shares_month", 429, { limit: limits.sharesPerMonth });
      const collected = await collectBundle(store, funnelId, "share");
      if (!collected) return refuse("unknown", 404);
      const outline = outlineOf(collected.bundle);
      if (outline.bytes > limits.bundleBytes) return refuse("too_big", 400, { limit: bytesWords(limits.bundleBytes) });
      // What is written is what any receiver would read: a snapshot that does not pass its own rules is never shared.
      const check = readBundle(collected.bundle, { maxBytes: limits.bundleBytes });
      if (!check.ok) return refuse(`bundle_${check.error}`);
      const made = await createShare(statsId, { name: collected.funnel.name, funnelId, days, from: store.name || `@${store.handle}`, bundle: collected.bundle, outline, limit: limits.shares });
      if (!made.ok) return refuse("shares_full", 400, { limit: limits.shares });
      return Response.json(
        { ok: true, code: made.code, link: shareLink(SITE_URL, made.code), share: shown(made.entry), left: leftOutWords(collected.left) },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    if (action === "revoke") {
      const id = text(body.id, 12);
      if (!SHARE_ID.test(id)) return refuse("unknown", 404);
      return (await revokeShare(statsId, id)) ? Response.json({ ok: true }) : refuse("unknown", 404);
    }

    if (action === "preview") {
      tried.counted = true;
      if (!(await countUse(storeUseKey(statsId, "preview"), PREVIEWS_PER_STORE_HOUR, 3_600))) return refuse("busy", 429);
      tried.counted = true;
      if (!(await countUse(storeMonthKey(statsId, "preview", month), limits.previewsPerMonth, MONTH_USE_SECONDS))) return refuse("previews_month", 429, { limit: limits.previewsPerMonth });
      const source = await sourceOf(body, store, "preview");
      if (!source.ok) return source.response;
      const receiver = await receiverOf(store);
      const plan = planImport(source.outline, receiver.products, receiver.room, mappingOf(body.products));
      if (source.outline.bytes > limits.bundleBytes) {
        plan.ok = false;
        plan.lines.unshift({ level: "stop", text: `It weighs ${bytesWords(source.outline.bytes)}; your plan brings in funnels up to ${bytesWords(limits.bundleBytes)}.` });
      }
      return Response.json(
        { ok: true, from: source.from, outline: source.outline, plan, products: receiver.products, room: receiver.room, limits },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    if (action === "copy-preview" || action === "copy") {
      const target = await otherOwnStore(guarded.email, store, role, body.to);
      if (!target.ok) return target.response;
      const to = target.store;
      const toLimits = shareLimitsFor(to);
      const toMonth = monthOfUse(to);
      if (!to.statsId || !toMonth) return refuse("unavailable", 503);
      const funnelId = text(body.funnel, 10);
      if (!FUNNEL_ID.test(funnelId)) return refuse("unknown", 404);
      if (action === "copy-preview") {
        // A preview is the destination's, as a preview of a link or file would be.
        tried.counted = true;
        if (!(await countUse(storeUseKey(to.statsId, "preview"), PREVIEWS_PER_STORE_HOUR, 3_600))) return refuse("busy", 429);
        tried.counted = true;
        if (!(await countUse(storeMonthKey(to.statsId, "preview", toMonth), toLimits.previewsPerMonth, MONTH_USE_SECONDS))) return refuse("previews_month", 429, { limit: toLimits.previewsPerMonth });
      } else {
        // Reading it out of this store is one of its exports, bringing it into the other one of its imports;
        // both are counted before anything is written, and kept when it fails.
        tried.counted = true;
        if (!(await countUse(storeMonthKey(statsId, "export", month), limits.exportsPerMonth, MONTH_USE_SECONDS))) return refuse("exports_month", 429, { limit: limits.exportsPerMonth });
        tried.counted = true;
        if (!(await countUse(storeMonthKey(to.statsId, "import", toMonth), toLimits.importsPerMonth, MONTH_USE_SECONDS))) return refuse("imports_full", 429, { limit: toLimits.importsPerMonth });
      }
      // The same creator's copy: their about text, videos, deadline and quotes stay; pictures never come along.
      const collected = await collectBundle(store, funnelId, "own");
      if (!collected) return refuse("unknown", 404);
      const outline = outlineOf(collected.bundle);
      const destination = { sid: to.sid, name: to.name || `@${to.handle}` };
      if (action === "copy-preview") {
        const receiver = await receiverOf(to);
        const plan = planImport(outline, receiver.products, receiver.room, mappingOf(body.products));
        if (outline.bytes > toLimits.bundleBytes) {
          plan.ok = false;
          plan.lines.unshift({ level: "stop", text: `It weighs ${bytesWords(outline.bytes)}; ${destination.name}'s plan brings in funnels up to ${bytesWords(toLimits.bundleBytes)}.` });
        }
        return Response.json(
          { ok: true, from: store.name || `@${store.handle}`, to: destination, outline, plan, products: receiver.products, room: receiver.room, limits: toLimits, left: leftOutWords(collected.left) },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }
      // Read as strictly as any file, against the destination's own size limit.
      const check = readBundle(collected.bundle, { maxBytes: toLimits.bundleBytes, own: true });
      if (!check.ok) return refuse(check.error === "too_big" ? "too_big" : `bundle_${check.error}`, 400, { limit: bytesWords(toLimits.bundleBytes) });
      const result = await importBundle(storeRef(to), to, check.bundle, mappingOf(body.products), text(body.name, 60) || collected.funnel.name);
      if (!result.ok) return refuse(result.error, result.error === "setup_incomplete" ? 500 : 400, { lines: result.lines ?? [] });
      return Response.json({ ok: true, to: destination, funnel: result.funnel, pages: result.pages, lines: result.lines, left: leftOutWords(collected.left) });
    }

    if (action === "import" || action === "clone") {
      let bundle: FunnelBundle;
      let mapping: Record<string, string>;
      let left: string[] = [];
      let before: PlanLine[] = [];
      let name: string | undefined = text(body.name, 60) || undefined;
      if (action === "clone") {
        const funnelId = text(body.funnel, 10);
        if (!FUNNEL_ID.test(funnelId)) return refuse("unknown", 404);
        const collected = await collectBundle(store, funnelId, "own");
        if (!collected) return refuse("unknown", 404);
        const check = readBundle(collected.bundle, { maxBytes: limits.bundleBytes, own: true });
        if (!check.ok) return refuse(check.error === "too_big" ? "too_big" : `bundle_${check.error}`, 400, { limit: bytesWords(limits.bundleBytes) });
        bundle = check.bundle;
        mapping = collected.productIds;
        left = leftOutWords(collected.left);
        name = `Copy of ${collected.funnel.name}`.slice(0, 60);
      } else {
        const source = await sourceOf(body, store, "import");
        if (!source.ok) return source.response;
        bundle = source.bundle!;
        mapping = mappingOf(body.products);
        if (source.kind === "starter") before = source.before;
      }
      // Counted before anything is written, and kept when it fails: an attempt costs reads as well.
      tried.counted = true;
      if (!(await countUse(storeMonthKey(statsId, "import", month), limits.importsPerMonth, MONTH_USE_SECONDS))) return refuse("imports_full", 429, { limit: limits.importsPerMonth });
      const result = await importBundle(ref, store, bundle, mapping, name);
      if (!result.ok) return refuse(result.error, result.error === "setup_incomplete" ? 500 : 400, { lines: result.lines ?? [] });
      return Response.json({ ok: true, funnel: result.funnel, pages: result.pages, lines: [...before, ...result.lines], left });
    }

    return refuse("invalid");
  } catch (error) {
    if (isUnread(error)) return unread(tried.counted);
    console.error("sharing or bringing in a funnel failed", error);
    return refuse("server_error", 500);
  }
}

/**
 * One of this store's funnels as a file to keep or give: `?export=<funnel>`.
 * The same snapshot a share link holds, with what is the sender's own left
 * out, in the versioned format any Marktmorgen store can bring in.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "page");
  if (access instanceof Response) return access;
  const store = access.store;
  const funnelId = (request.nextUrl.searchParams.get("export") ?? "").slice(0, 10);
  if (!store || !FUNNEL_ID.test(funnelId) || !can(access.role, "products")) return refuse("unknown", 404);
  try {
    const limits = shareLimitsFor(store);
    const month = monthOfUse(store);
    if (!store.statsId || !month) return refuse("unavailable", 503);
    if (!(await countUse(storeMonthKey(store.statsId, "export", month), limits.exportsPerMonth, MONTH_USE_SECONDS))) return refuse("exports_month", 429, { limit: limits.exportsPerMonth });
    const collected = await collectBundle(store, funnelId, "share");
    if (!collected) return refuse("unknown", 404);
    const json = JSON.stringify(collected.bundle, null, 2);
    if (new TextEncoder().encode(json).length > limits.bundleBytes) return refuse("too_big", 400, { limit: bytesWords(limits.bundleBytes) });
    const slug = collected.funnel.slug || "funnel";
    return new Response(json, { headers: fileHeaders("application/json; charset=utf-8", `${slug}.marktmorgen-funnel.json`) });
  } catch (error) {
    if (isUnread(error)) return unread(true);
    console.error("exporting a funnel failed", error);
    return refuse("server_error", 500);
  }
}
