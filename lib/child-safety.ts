/**
 * Reports of child sexual exploitation and of intimate images shared without
 * consent (C1-20261109-1546-TODOS-70; procedure in docs/incident-response.md).
 *
 * A child-safety report from /report takes the product it points at off the
 * store at once: it is unpublished, never deleted, so the files and records
 * stay as they are for the report to NCMEC and for the time the law asks them
 * to be kept (18 U.S.C. § 2258A(h)). Anybody can fill in the form, so the
 * automatic step is capped per store per day (CHILD_SAFETY_HOLDS_PER_DAY),
 * counted in distinct products, so reports of one product and retries never
 * spend the day; past it, the owner decides. A request to remove an intimate image shared
 * without consent is not taken down automatically: the owner has 48 hours to
 * remove it (TAKE_IT_DOWN_HOURS) and is told by when.
 *
 * Either way the owner gets an urgent email that carries only where it is and
 * what was done: never the reported content, a preview of it or the reporter's
 * description, and it says that nobody, person or AI agent, opens, downloads,
 * forwards or describes the content.
 *
 *   nl:csa:held:<store>:<YYYY-MM-DD>   set      products held automatically that day, 2 days
 *   nl:csa:keep:<store>:<product>      "1"      preservation hold, 400 days (unit 2)
 *   nl:csa:files:<store>:<product>     JSON     where its held files are, 400 days (unit 3b)
 *   nl:csa:hide                        zset     held products whose taking off the store is not confirmed yet, by
 *                                               when each is next tried (hideHeldProducts); KEEP_SECONDS from the
 *                                               last one added
 *
 * Unit 2: the hold also marks the product for KEEP_SECONDS, before it is
 * taken off, and while the mark is there no studio route removes, edits,
 * publishes it or changes or deletes any of its files, options, picture,
 * page, episodes, lessons, lesson captions, license keys, bundle list,
 * waitlist or buyers' reviews, and no bundle takes it in (heldRefusal,
 * heldRefusalAmong). Nor is it sold through another product: a bundle
 * holding it is not offered or sold, and a checkout box offering it, or a
 * bundle holding it, is not shown or charged (lib/child-safety-holds.ts,
 * heldInSale): the law asks for what was reported to
 * be kept for a year from the report (18 U.S.C. § 2258A(h), as the REPORT Act
 * amended it), and a creator could otherwise delete it from the studio.
 *
 * Unit 3a: while the mark is there, nobody but the store's owner reads what the
 * product holds: its course pages and worksheets, its podcast page, feed and
 * episodes, its PDF preview, its shared card, its file from the studio (the
 * team is refused) and the AI writing help (refused for everyone, so nothing
 * of it goes to an AI provider: a picture description is refused for its
 * picture and the pictures on its sales page whichever product or page the
 * request names, heldPictureRefusal), nor the MCP server's product tools
 * (lib/mcp-tools.ts, heldForAgent), for the same reason. The studio's course
 * and podcast pages are the owner's only. A mark that cannot be read refuses
 * the same way (holdState, contentOpenTo). Should taking it off the store not
 * go through after its mark was written, its own page shows it to nobody at
 * once, and the hourly job (app/api/cron/quiet) takes it off, again and again
 * until it is confirmed off (hideHeldProducts), so the store's lists, which
 * read no mark on a visit, drop it too.
 */
import { createHash } from "node:crypto";
import { emailForSession, normaliseEmail } from "@/lib/auth";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { type Store, setProductHidden, storeForEmail, storeRef } from "@/lib/store";
import { productIdFromAddress, productIds, readListingExactly } from "@/lib/catalog";
import { handleIn, type ReportKind } from "@/lib/takedown-rules";
import { MAX_VAULT_PATH_BYTES } from "@/lib/vault-rules";
import { holdFiles, isFileHeld } from "@/lib/held-files";
import { productFilePaths } from "@/lib/held-product-files";
import { withReminders } from "@/lib/child-safety-alerts";
import { type Listing, productIdFor, readListings } from "@/lib/catalog";
import { heldIdsAmong, heldInCatalog, isHeldForReport, keepKey, touchesHeld } from "@/lib/child-safety-holds";
import { imagePaths } from "@/lib/product-image";
import { picturePaths } from "@/lib/sales-page";
import { readPageExact } from "@/lib/sales-page-store";
import { activeBumps, bumpTargets } from "@/lib/product-extras";

/** Automatic holds a store takes from child-safety reports in one UTC day; past them the owner decides. */
export const CHILD_SAFETY_HOLDS_PER_DAY = 3;
/** The time the TAKE IT DOWN Act gives to remove an intimate image once a valid request is received. */
export const TAKE_IT_DOWN_HOURS = 48;
const COUNT_SECONDS = 2 * 86_400;
/** How long a reported product is kept from removal, editing and publishing: a year from the report and a margin. */
export const KEEP_SECONDS = 400 * 86_400;

/**
 * How many paths the held list keeps: every file stays marked whatever the list
 * holds (lib/held-files.ts); the list is for finding them again, and `more`
 * says how many it left out. 400 until Claude 6's focal review of #3480
 * (6758141878): 400 longest vault paths wrote 88,106 bytes, priced at 48,000.
 */
export const HELD_LIST_PATHS = 200;
/** The list's frame, `{"paths":[],"more":N}`, with room for any count. */
const HELD_LIST_FRAME_BYTES = 40;
/**
 * The most a held list ever weighs, in bytes: HELD_LIST_PATHS of the longest
 * vault paths the path rules allow (lib/vault-rules.ts), each quoted with a
 * comma, and the frame. heldListOf never writes more, whatever the paths, so
 * the price in tests/store-data-registry.ts cannot drift from the code.
 */
export const HELD_LIST_BYTES = HELD_LIST_PATHS * (MAX_VAULT_PATH_BYTES + 3) + HELD_LIST_FRAME_BYTES;

/**
 * The held list as it is written: the paths in order while they fit in
 * HELD_LIST_PATHS and HELD_LIST_BYTES (a path longer than any vault path, say
 * a picture's, is passed over rather than written), and how many were left out.
 */
export function heldListOf(paths: string[]): string {
  const kept: string[] = [];
  let bytes = HELD_LIST_FRAME_BYTES;
  for (const path of paths) {
    if (kept.length >= HELD_LIST_PATHS) break;
    const cost = Buffer.byteLength(JSON.stringify(path), "utf8") + 1;
    if (bytes + cost > HELD_LIST_BYTES) continue;
    kept.push(path);
    bytes += cost;
  }
  return JSON.stringify({ paths: kept, more: paths.length - kept.length });
}
const listKey = (store: Pick<Store, "statsId" | "handle">, productId: string) => `nl:csa:files:${storeTag(store)}:${productId}`;

/**
 * Where the held product's files are, kept beside the marks for as long: the marks are hashes, and once a store
 * closes or a person is erased this list is how the owner finds what to hand over (18 U.S.C. § 2258A(h)). It is
 * read by the owner only, from the store's data in the hosting console, never served by the site.
 */
async function listHeldFiles(store: Pick<Store, "statsId" | "handle">, productId: string, paths: string[]): Promise<boolean> {
  const list = heldListOf(paths);
  const replies = repliesFor(await redisPipeline([["SET", listKey(store, productId), list, "EX", KEEP_SECONDS]]), 1);
  return replies?.[0] === "OK";
}

export type HoldOutcome = "held" | "files_unconfirmed" | "no_product" | "not_held" | "capped" | "unknown" | "failed";

const storeTag = (store: Pick<Store, "statsId" | "handle">) => store.statsId || `h:${store.handle}`;
const countKey = (store: Pick<Store, "statsId" | "handle">, day: string) => `nl:csa:held:${storeTag(store)}:${day}`;
export { isHeldForReport } from "@/lib/child-safety-holds";

/** A product's hold as a reader sees it; "unknown" is a mark that could not be read, refused like "held". */
export type HoldState = "held" | "free" | "unknown";

/**
 * Whether the product is held, for whatever would read or hand out its content
 * (unit 3a): never throws, and a mark that cannot be read is "unknown", which
 * every reader refuses exactly as it refuses "held", never shows the content.
 */
export async function holdState(store: Pick<Store, "statsId" | "handle">, productId: string): Promise<HoldState> {
  try {
    return (await isHeldForReport(store, productId)) ? "held" : "free";
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return "unknown";
  }
}

/**
 * Whether this session is the store's owner: the only person who reads a
 * held product, from its own pages or the studio. Never someone on the team,
 * a student or a listener. Anything not known is a no.
 */
export async function isOwnerSession(store: Pick<Store, "email">, session: string | undefined): Promise<boolean> {
  if (!session) return false;
  const email = await emailForSession(session).catch(() => null);
  return Boolean(email) && normaliseEmail(email as string) === normaliseEmail(store.email);
}

/**
 * Whether a product's content may be shown to this session: always while it
 * is not held; while it is held, or its mark cannot be read, only to the
 * store's owner. The owner is asked first, so their own pages read no mark.
 */
export async function contentOpenTo(store: Pick<Store, "statsId" | "handle" | "email">, productId: string, session: string | undefined): Promise<boolean> {
  if (await isOwnerSession(store, session)) return true;
  return (await holdState(store, productId)) === "free";
}

/**
 * The answer a studio route gives instead of changing or deleting anything of
 * a product kept for a report, or null to go on: 409 `on_hold` while it is
 * held, 503 when the hold cannot be read, never the change. The id may name
 * the product or one of its price options, whose product is the one held; an
 * id the store does not have reads nothing, since nothing of it can change.
 */
export async function heldRefusal(store: Store, id: string): Promise<Response | null> {
  const productId = productIdFor(store, id);
  if (!productId) return null;
  try {
    if (await isHeldForReport(store, productId)) return Response.json({ ok: false, error: "on_hold" }, { status: 409 });
    return null;
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

/**
 * The same answer for a change that names several products at once, such as
 * the list of a bundle: 409 `on_hold` when any of them is held, 503 when any
 * hold cannot be read, null to go on. One read for all of them.
 */
export async function heldRefusalAmong(store: Store, ids: readonly string[]): Promise<Response | null> {
  const productIds = [...new Set(ids.map((id) => productIdFor(store, id)).filter((id): id is string => id !== null))];
  if (productIds.length === 0) return null;
  try {
    const held = (await heldIdsAmong(store, productIds)).size > 0;
    return held ? Response.json({ ok: false, error: "on_hold" }, { status: 409 }) : null;
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

/**
 * The answer the picture description (app/api/store/ai, kind "alt") gives
 * instead of sending a held product's picture to the AI provider, or null to
 * go on. The request names a product or a page of the store's own and sends
 * a path, so the hold is read on the picture's owner, not on what is named:
 * the picture's own mark (unit 3b, isFileHeld), then the marks of every
 * product of the store (heldInCatalog, two MGETs at most),
 * then, for each held product only, its listing and its sales page (both
 * versions), exactly. 409 `on_hold`, without saying whose, when the path is a
 * held product's picture, its smaller copy or a picture on its page; 503 when
 * a mark, a held product's listing or its page cannot be read. It answers
 * before the file store is read and before any model is asked.
 */
export async function heldPictureRefusal(store: Store, path: string): Promise<Response | null> {
  try {
    // The picture's own mark first (unit 3b, lib/held-files.ts): written when the product was held, whatever has
    // happened to its listing or page since.
    if (await isFileHeld(path)) return Response.json({ ok: false, error: "on_hold" }, { status: 409 });
    for (const id of await heldInCatalog(store, productIds(store))) {
      const listing = await readListingExactly(store, id);
      if (listing === "unknown") throw new Error("A held product could not be read");
      const paths = imagePaths(listing?.image);
      if (store.statsId) {
        const { page } = await readPageExact(store.statsId, id);
        if (page) paths.push(...picturePaths(page));
      }
      if (paths.includes(path)) return Response.json({ ok: false, error: "on_hold" }, { status: 409 });
    }
    return null;
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

/**
 * Whether a checkout for this product would hand over a product kept for a
 * report, read by app/api/store/checkout/route.ts before the checkout is built
 * (lib/store-checkout.ts writes a bundle's list and the ticked boxes onto the
 * order as they stand): "held" when the product itself carries the keep mark
 * (its hidden write may not have landed: holdReported writes the mark first,
 * Claude 6's MEDIUM on #3471), "bundle" when the product is a bundle holding one,
 * "box" when a ticked box's product is held or is a bundle holding one,
 * "unavailable" when a hold cannot be read, null to go on. `bumps` is what the
 * form sent: the ticked boxes' product ids, or "yes" for the first box shown.
 * One read of the boxes' products, only when one is ticked, and one of holds,
 * always (the product's own mark at least).
 */
export async function heldInSale(store: Store, product: Listing, bumps: readonly string[]): Promise<"held" | "bundle" | "box" | "unavailable" | null> {
  try {
    const inBundle = product.bundle ?? [];
    let ticked: Listing[] = [];
    if (bumps.length > 0 && product.bumps.length > 0) {
      const shown = activeBumps(await readListings(store, bumpTargets(product)), product);
      ticked = shown.filter((offer, at) => bumps.includes(offer.target.id) || (at === 0 && bumps.includes("yes"))).map((offer) => offer.target);
    }
    const asked = [...new Set([product.id, ...inBundle, ...ticked.flatMap((target) => [target.id, ...(target.bundle ?? [])])])];
    const held = await heldIdsAmong(store, asked);
    if (held.has(product.id)) return "held";
    if (inBundle.some((id) => held.has(id))) return "bundle";
    if (ticked.some((target) => touchesHeld(target, held))) return "box";
    return null;
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return "unavailable";
  }
}

/**
 * Takes the product a child-safety report points at off the store, without
 * deleting anything. Never throws: an outcome that cannot be confirmed is
 * said as such, and the owner's urgent email asks them to act by hand.
 */
export async function holdReported(report: { kind: ReportKind; url: string }, store: Store, now = Date.now()): Promise<HoldOutcome> {
  if (report.kind !== "child_safety") return "not_held";
  try {
    // Read exactly (rule 24): an address that names no product of this store is no_product; a read that fails or
    // answers off its shape is unknown, never "names nothing" (lib/takedown.ts reportedProduct swallows it).
    const id = productIdIn(report.url, store);
    if (!id) return "no_product";
    const product = await readListingExactly(store, id);
    if (product === "unknown") return "unknown";
    if (!product) return "no_product";
    const key = countKey(store, new Date(now).toISOString().slice(0, 10));
    // The day's cap is counted in products: a second report of the same product, or a retry, adds nothing.
    const replies = repliesFor(
      await redisPipeline([
        ["SADD", key, product.id],
        ["SCARD", key],
        ["EXPIRE", key, COUNT_SECONDS],
      ]),
      3,
    );
    const added = replies?.[0];
    const count = replies?.[1];
    if ((added !== 0 && added !== 1) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return "unknown";
    if (count > CHILD_SAFETY_HOLDS_PER_DAY) {
      // A product over the cap is taken back out of the day's set, so it never passes for one already held.
      if (added === 1) await redisPipeline([["SREM", key, product.id]]).catch(() => console.error("a capped child-safety hold could not be taken out of the day's count"));
      return "capped";
    }
    // Kept before it is taken off: a creator who acts in between can still not remove or change it.
    const kept = repliesFor(await redisPipeline([["SET", keepKey(store, product.id), "1", "EX", KEEP_SECONDS]]), 1);
    if (kept?.[0] !== "OK") return "unknown";
    // Waiting to be taken off before anything else is done: should the files below or the hide not go through (or the
    // request be cut short), the hourly job takes it off (hideHeldProducts). A queue write not confirmed does not stop the hide; the owner's email says what happened.
    const member = hideMember(store, product.id);
    await redisPipeline([["ZADD", HIDE_DUE, now, member], ["EXPIRE", HIDE_DUE, KEEP_SECONDS]]).catch(() => console.error("a held product could not be queued to be taken off"));
    // Its files are kept and closed to everyone before it is taken off (unit 3b, lib/held-files.ts).
    const files = await productFilePaths(product, store.statsId || undefined)
      .then(async ({ paths, complete }) => (await holdFiles(paths)) && (await listHeldFiles(store, product.id, paths)) && complete)
      .catch(() => false);
    const done = await setProductHidden(storeRef(store), product.id, true);
    if (!done.ok) return done.reason === "unknown" ? "unknown" : "failed";
    // Confirmed off: it waits no more. If this is lost, the job confirms it off and lets it go.
    await redisPipeline([["ZREM", HIDE_DUE, member]]).catch(() => console.error("a held product taken off could not leave the queue"));
    return files ? "held" : "files_unconfirmed";
  } catch (error) {
    console.error("a child-safety hold could not be confirmed", error instanceof Error ? error.message : "unknown");
    return "unknown";
  }
}

/** The held products whose taking off the store is not confirmed yet, by when each is next tried. */
export const HIDE_DUE = "nl:csa:hide";
/** How long a held product whose taking off did not go through waits before the next try: the job's own hour. */
export const HIDE_RETRY_MS = 3_600_000;
/** The most held products one run tries to take off; the rest wait for the next run, by when each is due. */
export const HIDES_PER_RUN = 25;
/**
 * How long one run of the step may go on before it stops trying the next product: the step runs inside the hourly
 * route (app/api/cron/quiet, maxDuration 60 s) next to its other work, and a busy store lock is exactly what puts a
 * product here, so it never spends the run on them (Claude 4 on #3486). What it did not reach stays due.
 */
export const HIDE_BUDGET_MS = 5_000;
/** How long the step waits for a store's lock another write holds, against the write's own 8 s: a busy store is tried again an hour later. */
export const HIDE_LOCK_WAIT_MS = 500;

/** One waiting product: the store's ref (lib/store.ts storeRef), the tag its mark is kept under, and the product. */
const hideMember = (store: Store, productId: string) => JSON.stringify([storeRef(store), storeTag(store), productId]);

/**
 * Takes one waiting product off its store, if it still has to be: "hidden" once it is confirmed off (it was, or the
 * write said so), "gone" when there is nothing left to take off (the hold is over, or the store has no such product),
 * "waiting" for anything not confirmed, an unknown reply included, so it is tried again and never dropped for it.
 */
async function hideOne(member: string, lockWaitMs: number): Promise<"hidden" | "gone" | "waiting"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(member);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string" && part)) {
    console.error("a waiting child-safety hide is not one of ours; let go");
    return "gone";
  }
  const [ref, tag, productId] = parsed as [string, string, string];
  // The hold first, read exactly under the tag it was kept under: over is "gone", unknown is "waiting".
  const held = await heldIdsAmong({ statsId: tag, handle: "" }, [productId]).then((ids) => ids.has(productId), () => null);
  if (held === null) return "waiting";
  if (!held) return "gone";
  const store = await storeForEmail(ref).catch(() => null);
  // A store that cannot be read now, or under another tag (its record was written again under the same ref), is tried again.
  if (!store || storeTag(store) !== tag) return "waiting";
  const listing = await readListingExactly(store, productId);
  if (listing === "unknown") return "waiting";
  if (!listing) return "gone";
  if (listing.hidden) return "hidden";
  const done = await setProductHidden(storeRef(store), productId, true, { lockWaitMs });
  return done.ok && done.product.hidden ? "hidden" : "waiting";
}

/**
 * The hourly job's step (app/api/cron/quiet): tries to take off the store each held product whose taking off did not
 * go through (holdReported), up to HIDES_PER_RUN of those due, and lets each go only once it is confirmed off or has
 * nothing left to take off; anything else is tried again an hour later. It tries no product once `until` (by the clock,
 * HIDE_BUDGET_MS from the call unless the caller gives less) is past, and waits at most HIDE_LOCK_WAIT_MS, and never
 * past `until`, for a busy store: what it did not reach stays due as it was, for the next run. Never throws: a queue
 * that cannot be read is left for the next run.
 */
export async function hideHeldProducts(now = Date.now(), until = Date.now() + HIDE_BUDGET_MS): Promise<{ hidden: number; waiting: number; gone: number }> {
  const out = { hidden: 0, waiting: 0, gone: 0 };
  if (Date.now() >= until) return out;
  let due: string[];
  try {
    const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", HIDE_DUE, "-inf", String(now), "LIMIT", 0, HIDES_PER_RUN]]), 1);
    const list = replies?.[0];
    if (!Array.isArray(list) || list.some((member) => typeof member !== "string")) throw new Error("the queue answered off its shape");
    due = list as string[];
  } catch (error) {
    console.error("the held products waiting to be taken off could not be read", error instanceof Error ? error.message : "unknown");
    return out;
  }
  for (const member of due) {
    const left = until - Date.now();
    if (left <= 0) break;
    const done = await hideOne(member, Math.min(HIDE_LOCK_WAIT_MS, left)).catch((error) => {
      console.error("a held product could not be taken off", error instanceof Error ? error.message : "unknown");
      return "waiting" as const;
    });
    out[done] += 1;
    // Tried again in an hour (only while it is still there: XX); if this write is lost it is simply due again sooner.
    const next: (string | number)[] = done === "waiting" ? ["ZADD", HIDE_DUE, "XX", now + HIDE_RETRY_MS, member] : ["ZREM", HIDE_DUE, member];
    await redisPipeline([next]).catch(() => console.error("a waiting child-safety hide could not be moved on"));
  }
  if (out.waiting) console.error(`child safety: ${out.waiting} held product(s) still waiting to be taken off the store`);
  return out;
}

const WHAT_HAPPENED: Record<HoldOutcome, string> = {
  held: "The product it points at was taken off the store at once (unpublished), so visitors can no longer see or buy it. Nothing was deleted: its files and records are kept as they are. For 400 days the creator cannot remove it, change it or publish it again, nor replace or delete its files, price options, picture, page, podcast episodes, course lessons, lesson captions, license keys, bundle list, waitlist or buyers' reviews, from the studio, and it goes into no bundle. A bundle that already held it is not sold, and a checkout box that offered it, or such a bundle, is not shown or charged. Its course pages and files, podcast feed and episodes, preview and shared card are closed to everyone but the store's owner. Its files are kept from deletion, whoever asks, and handed to nobody, buyers included. Two things the site cannot take back: a download address issued before the report works until it expires (up to 4 hours), and a picture of it fetched before may still be served from the CDN's and browsers' caches for up to a year; purge the CDN cache in the hosting dashboard now, as docs/incident-response.md section 8 says.",
  files_unconfirmed: "The product it points at was taken off the store at once (unpublished), but keeping its files from deletion and download could not be confirmed. Suspend the store now, as docs/incident-response.md section 8 says.",
  no_product: "The address does not name a product of a store, so nothing was taken off automatically. Act on it by hand, as docs/incident-response.md section 8 says.",
  not_held: "Nothing was taken off automatically. Act on it by hand, as docs/incident-response.md section 8 says.",
  capped: `This store already had ${CHILD_SAFETY_HOLDS_PER_DAY} products taken off automatically today, so nothing more was. Act on it by hand, as docs/incident-response.md section 8 says.`,
  unknown: "Taking it off the store could not be confirmed. Act on it now by hand, as docs/incident-response.md section 8 says.",
  failed: "Taking it off the store did not work. Act on it now by hand, as docs/incident-response.md section 8 says.",
};

const NOTICE_NOT_KEPT = "The notice itself could not be confirmed as kept, and the person was told to try again: if no notice email with this address reaches the support inbox, act on this email alone.";

/** The product id a store address names (/@handle/p/<product>), or null. */
function productIdIn(url: string, store: Store): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("p");
    const segment = at >= 0 ? decodeURIComponent(parts[at + 1] ?? "") : "";
    return segment ? productIdFromAddress(store, segment) : null;
  } catch {
    return null;
  }
}

/** Only a Marktmorgen address is shown in the urgent email; anything else is named, not quoted. */
function where(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "marktmorgen.com" || host === "www.marktmorgen.com") return url;
  } catch {
    // not an address: said below
  }
  return "an address outside Marktmorgen (see the notice email)";
}

function deadline(ms: number): string {
  const at = new Date(ms);
  const day = at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/**
 * The owner's urgent email, sent to the support inbox beside the notice
 * itself. It names where and what was done; it never quotes the reporter's
 * words, since those may describe the content. False when it was not sent.
 */
export async function alertOwner(
  report: { kind: ReportKind; url: string; work?: string; email?: string },
  outcome: HoldOutcome,
  now = Date.now(),
  noticeKept = true,
): Promise<boolean> {
  if (report.kind !== "child_safety" && report.kind !== "intimate_image") return false;
  const handle = handleIn(report.url);
  const child = report.kind === "child_safety";
  const subject = `${child ? "URGENT: child safety report" : "URGENT: request to remove an intimate image"}${handle ? ` about @${handle}` : ""}`;
  const lines = child
    ? [
        "A report of child sexual exploitation was sent from /report.",
        "",
        `Where: ${where(report.url)}`,
        WHAT_HAPPENED[outcome],
        "",
        "Do not open, download, forward or describe the reported content, and do not ask any AI agent to look at it.",
        "If you have actual knowledge of apparent child sexual abuse material, report it to NCMEC's CyberTipline (report.cybertip.org) as soon as reasonably possible, and keep the content preserved.",
        "The steps, with the law, are in docs/incident-response.md.",
        ...(noticeKept ? [] : ["", NOTICE_NOT_KEPT]),
      ]
    : [
        "A request to remove an intimate image shared without consent was sent from /report (TAKE IT DOWN Act).",
        "",
        `Where: ${where(report.url)}`,
        `Remove it within ${TAKE_IT_DOWN_HOURS} hours: by ${deadline(now + TAKE_IT_DOWN_HOURS * 3_600_000)}, and make reasonable efforts to remove any identical copies on the site.`,
        "",
        "Do not forward or describe the image, and do not ask any AI agent to look at it.",
        noticeKept
          ? "The steps are in docs/incident-response.md. The request itself, with the person's signature, is in the notice email."
          : `The steps are in docs/incident-response.md. ${NOTICE_NOT_KEPT}`,
      ];
  // One request a day: a retry of the same request (address, sender, words) neither sends the urgent email twice nor
  // opens a second reminder; a new request on the same address, by another person or about another image, does both.
  const request = `${report.kind}-${createHash("sha256").update(`${report.url}\n${report.email ?? ""}\n${report.work ?? ""}`).digest("hex").slice(0, 24)}-${new Date(now).toISOString().slice(0, 10)}`;
  // Repeated every 24 hours until it is marked handled, with the link that does so (lib/child-safety-alerts.ts).
  return withReminders({ kind: report.kind, url: report.url, handle: handle || "", outcome, request }, now, (more) =>
    sendEmail({
      meter: { by: "company" },
      from: NIMBUS_FROM,
      to: SUPPORT_EMAIL,
      subject: subject.slice(0, 200),
      text: [...lines, ...more].join("\n"),
      idempotencyKey: `report-urgent-${request}`,
    }),
  )
    .catch(() => false)
    .then((sent) => {
      if (!sent) console.error("the urgent report email was not sent", report.kind);
      return sent;
    });
}
