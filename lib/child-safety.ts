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
 *
 * Unit 2: the hold also marks the product for KEEP_SECONDS, before it is
 * taken off, and while the mark is there no studio route removes, edits,
 * publishes it or changes or deletes any of its files, options, picture,
 * page, episodes or lessons (heldRefusal): the law asks for what was reported to
 * be kept for a year from the report (18 U.S.C. § 2258A(h), as the REPORT Act
 * amended it), and a creator could otherwise delete it from the studio.
 */
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { type Store, setProductHidden, storeRef } from "@/lib/store";
import { type Report, reportedProduct } from "@/lib/takedown";
import { handleIn, type ReportKind } from "@/lib/takedown-rules";
import { productIdFor } from "@/lib/catalog";

/** Automatic holds a store takes from child-safety reports in one UTC day; past them the owner decides. */
export const CHILD_SAFETY_HOLDS_PER_DAY = 3;
/** The time the TAKE IT DOWN Act gives to remove an intimate image once a valid request is received. */
export const TAKE_IT_DOWN_HOURS = 48;
const COUNT_SECONDS = 2 * 86_400;
/** How long a reported product is kept from removal, editing and publishing: a year from the report and a margin. */
export const KEEP_SECONDS = 400 * 86_400;

export type HoldOutcome = "held" | "no_product" | "not_held" | "capped" | "unknown" | "failed";

const storeTag = (store: Pick<Store, "statsId" | "handle">) => store.statsId || `h:${store.handle}`;
const countKey = (store: Pick<Store, "statsId" | "handle">, day: string) => `nl:csa:held:${storeTag(store)}:${day}`;
const keepKey = (store: Pick<Store, "statsId" | "handle">, productId: string) => `nl:csa:keep:${storeTag(store)}:${productId}`;

/** Whether the product is kept for a report; a reply that cannot be read throws, so the caller refuses the change. */
export async function isHeldForReport(store: Pick<Store, "statsId" | "handle">, productId: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["GET", keepKey(store, productId)]]), 1);
  const value = replies?.[0];
  if (value === null) return false;
  if (value === "1") return true;
  throw new Error("A preservation hold could not be read");
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
 * Takes the product a child-safety report points at off the store, without
 * deleting anything. Never throws: an outcome that cannot be confirmed is
 * said as such, and the owner's urgent email asks them to act by hand.
 */
export async function holdReported(report: { kind: ReportKind; url: string }, store: Store, now = Date.now()): Promise<HoldOutcome> {
  if (report.kind !== "child_safety") return "not_held";
  try {
    const product = await reportedProduct({ url: report.url } as Report, store);
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
    const done = await setProductHidden(storeRef(store), product.id, true);
    return done.ok ? "held" : done.reason === "unknown" ? "unknown" : "failed";
  } catch (error) {
    console.error("a child-safety hold could not be confirmed", error instanceof Error ? error.message : "unknown");
    return "unknown";
  }
}

const WHAT_HAPPENED: Record<HoldOutcome, string> = {
  held: "The product it points at was taken off the store at once (unpublished), so visitors can no longer see or buy it. Nothing was deleted: its files and records are kept as they are. For 400 days the creator cannot remove it, change it or publish it again, nor replace or delete its files, price options, picture, page, podcast episodes or course lessons, from the studio. People who bought it before may still reach its files: switching that off is not automatic yet.",
  no_product: "The address does not name a product of a store, so nothing was taken off automatically. Act on it by hand, as docs/incident-response.md section 8 says.",
  not_held: "Nothing was taken off automatically. Act on it by hand, as docs/incident-response.md section 8 says.",
  capped: `This store already had ${CHILD_SAFETY_HOLDS_PER_DAY} products taken off automatically today, so nothing more was. Act on it by hand, as docs/incident-response.md section 8 says.`,
  unknown: "Taking it off the store could not be confirmed. Act on it now by hand, as docs/incident-response.md section 8 says.",
  failed: "Taking it off the store did not work. Act on it now by hand, as docs/incident-response.md section 8 says.",
};

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
export async function alertOwner(report: { kind: ReportKind; url: string; work?: string }, outcome: HoldOutcome, now = Date.now()): Promise<boolean> {
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
      ]
    : [
        "A request to remove an intimate image shared without consent was sent from /report (TAKE IT DOWN Act).",
        "",
        `Where: ${where(report.url)}`,
        `Remove it within ${TAKE_IT_DOWN_HOURS} hours: by ${deadline(now + TAKE_IT_DOWN_HOURS * 3_600_000)}, and make reasonable efforts to remove any identical copies on the site.`,
        "",
        "Do not forward or describe the image, and do not ask any AI agent to look at it.",
        "The steps are in docs/incident-response.md. The request itself, with the person's signature, is in the notice email.",
      ];
  return sendEmail({
    meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    subject: subject.slice(0, 200),
    text: lines.join("\n"),
    idempotencyKey: `report-urgent-${report.kind}-${now}-${handle || "none"}`,
  })
    .catch(() => false)
    .then((sent) => {
      if (!sent) console.error("the urgent report email was not sent", report.kind);
      return sent;
    });
}
