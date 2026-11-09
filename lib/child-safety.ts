/**
 * Reports of child sexual exploitation and of intimate images shared without
 * consent (C1-20261109-1546-TODOS-70; procedure in docs/incident-response.md).
 *
 * A child-safety report from /report takes the product it points at off the
 * store at once: it is unpublished, never deleted, so the files and records
 * stay as they are for the report to NCMEC and for the time the law asks them
 * to be kept (18 U.S.C. § 2258A(h)). Anybody can fill in the form, so the
 * automatic step is capped per store per day (CHILD_SAFETY_HOLDS_PER_DAY);
 * past it, the owner decides. A request to remove an intimate image shared
 * without consent is not taken down automatically: the owner has 48 hours to
 * remove it (TAKE_IT_DOWN_HOURS) and is told by when.
 *
 * Either way the owner gets an urgent email that carries only where it is and
 * what was done: never the reported content, a preview of it or the reporter's
 * description, and it says that nobody, person or AI agent, opens, downloads,
 * forwards or describes the content.
 *
 *   nl:csa:held:<store>:<YYYY-MM-DD>   counter  automatic holds that day, 2 days
 *   nl:csa:keep:<store>:<product>      "1"      preservation hold, 400 days (unit 2)
 *
 * Unit 2: the hold also marks the product for KEEP_SECONDS, before it is
 * taken off, and while the mark is there the product route refuses to remove,
 * edit or publish it (isHeldForReport): the law asks for what was reported to
 * be kept for a year from the report (18 U.S.C. § 2258A(h), as the REPORT Act
 * amended it), and a creator could otherwise delete it from the studio.
 *
 * Unit 3a: while the mark is there, nobody but the store's owner reads what the
 * product holds: its course pages and worksheets, its podcast page, feed and
 * episodes, its PDF preview, its shared card, its file from the studio (the
 * team is refused) and the AI writing help (refused for everyone, so nothing
 * of it goes to an AI provider). A mark that cannot be read refuses the same
 * way (holdState, contentOpenTo).
 */
import { emailForSession, normaliseEmail } from "@/lib/auth";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { type Store, setProductHidden, storeRef } from "@/lib/store";
import { type Report, reportedProduct } from "@/lib/takedown";
import { handleIn, type ReportKind } from "@/lib/takedown-rules";

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
 * Takes the product a child-safety report points at off the store, without
 * deleting anything. Never throws: an outcome that cannot be confirmed is
 * said as such, and the owner's urgent email asks them to act by hand.
 */
export async function holdReported(report: { kind: ReportKind; url: string }, store: Store, now = Date.now()): Promise<HoldOutcome> {
  if (report.kind !== "child_safety") return "not_held";
  try {
    const product = await reportedProduct({ url: report.url } as Report, store);
    if (!product) return "no_product";
    const replies = repliesFor(
      await redisPipeline([
        ["INCR", countKey(store, new Date(now).toISOString().slice(0, 10))],
        ["EXPIRE", countKey(store, new Date(now).toISOString().slice(0, 10)), COUNT_SECONDS],
      ]),
      2,
    );
    const count = replies?.[0];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return "unknown";
    if (count > CHILD_SAFETY_HOLDS_PER_DAY) return "capped";
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
  held: "The product it points at was taken off the store at once (unpublished). Nothing was deleted: its files and records are kept as they are, and the creator cannot remove, edit or publish it for 400 days.",
  no_product: "The address does not name a product of a store, so nothing was taken off automatically. Act on it from the notice email.",
  not_held: "Nothing was taken off automatically. Act on it from the notice email.",
  capped: `This store already had ${CHILD_SAFETY_HOLDS_PER_DAY} products taken off automatically today, so nothing more was. Act on it from the notice email.`,
  unknown: "Taking it off the store could not be confirmed. Act on it now from the notice email.",
  failed: "Taking it off the store did not work. Act on it now from the notice email.",
};

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
        `Where: ${report.url}`,
        WHAT_HAPPENED[outcome],
        "",
        "Do not open, download, forward or describe the reported content, and do not ask any AI agent to look at it.",
        "If you have actual knowledge of apparent child sexual abuse material, report it to NCMEC's CyberTipline (report.cybertip.org) as soon as reasonably possible, and keep the content preserved.",
        "The steps, with the law, are in docs/incident-response.md.",
      ]
    : [
        "A request to remove an intimate image shared without consent was sent from /report (TAKE IT DOWN Act).",
        "",
        `Where: ${report.url}`,
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
  }).catch(() => false);
}
