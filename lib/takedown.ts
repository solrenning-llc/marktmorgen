/**
 * Notices about content on a store, and taking it down (added 9 October 2026).
 *
 * Anybody can send a notice from /report: of copyright infringement, with
 * what 17 U.S.C. § 512(c)(3) asks a notice to say, or of other illegal
 * content, as the EU's Digital Services Act asks. Each is kept, with a token
 * of its own, and sent to the support inbox with a link that opens it
 * (app/takedown/[token]). Whoever reads that inbox acts on it from there:
 * removes the link, unpublishes the product, takes the media kit down, or
 * switches the whole store's pages and sales off. Each step is written on
 * the store's record (`strikes`, the repeat-infringer record) and the creator
 * is emailed what was taken down, why, and how to send a counter-notice.
 *
 *   nl:report:<id>            JSON   the notice, 400 days
 *   nl:report:t:<sha(token)>  string its id, 60 days: the link stops working after that
 *
 * The person sending a notice is emailed nothing: a form anybody can fill in
 * must never be a way to send somebody an email. Nothing here is read on a
 * visit to any page.
 */
import { countNotice, countStep } from "@/lib/transparency";
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { type Store, dropHeldLink, holdStoreLink, markHeldLink, noteTakedown, removeStoreLink, restoreHeldLink, setKit, setProductHidden, storeForEmail, storeForHandle, storeRecordKept, storeRef } from "@/lib/store";
import { BlobNotFoundError } from "@vercel/blob";
import { copy, del, head } from "@/lib/blob";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { imageType } from "@/lib/product-image";
import { SITE_URL } from "@/lib/site-url";
import { HELD_INDEX, type HeldLink, NOTICE_PAGE_AFTER_HOLD_DAYS, heldDue, holdUntil, restoreFrom } from "@/lib/takedown-hold";
import { withLock } from "@/lib/redis-lock";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type Listing, productIdFromAddress, readListing } from "@/lib/catalog";
import { type ReportInput, handleIn } from "@/lib/takedown-rules";
import { type PictureNames, withdrawProductPicture } from "@/lib/picture-withdraw";

const REPORT_SECONDS = 400 * 86_400;
const TOKEN_SECONDS = 60 * 86_400;
export const TAKEDOWN_TOKEN = /^[0-9a-f]{48}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const reportKey = (id: string) => `nl:report:${id}`;
const tokenKey = (token: string) => `nl:report:t:${sha(`nimbus-takedown:${token}`)}`;

export type Report = ReportInput & { id: string; at: string; handle: string };

export type FileResult = "sent" | "limited" | "error";

/** Keeps a notice and sends it to the support inbox with the link that acts on it. */
export async function fileReport(input: ReportInput, ip: string, origin: string): Promise<FileResult> {
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  if (!(await withinLimit("report", ip, 5, 3_600))) return "limited";
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(24).toString("hex");
  const report: Report = { ...input, id, at: new Date().toISOString(), handle: handleIn(input.url) };
  await redisPipeline([
    ["SET", reportKey(id), JSON.stringify(report), "EX", REPORT_SECONDS],
    ["SET", tokenKey(token), id, "EX", TOKEN_SECONDS],
  ]);
  const sent = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    replyTo: report.email,
    subject: `${report.kind === "copyright" ? "Copyright notice" : "Notice of illegal content"}${report.handle ? ` about @${report.handle}` : ""}`.slice(0, 200),
    text: [
      `A ${report.kind === "copyright" ? "copyright notice (DMCA, 17 U.S.C. § 512(c)(3))" : "notice of illegal content (EU Digital Services Act, Art. 16)"} was sent from ${origin}/report.`,
      "",
      `Where: ${report.url}`,
      report.handle ? `Store: @${report.handle}` : "Store: not named in the address; check it by hand.",
      "",
      report.kind === "copyright" ? "The work, as they describe it:" : "Why it is illegal, as they say:",
      report.work,
      report.original ? `\nWhere the original is: ${report.original}` : "",
      "",
      `From: ${report.name} <${report.email}>`,
      report.contact ? `Address or telephone: ${report.contact}` : "",
      `Signed: ${report.signature}`,
      "They stated, in good faith, that the use is not authorized, and that the notice is accurate and, under penalty of perjury, that they are authorized to act.",
      "",
      "Open it to act on it (the link works for 60 days):",
      `${origin}/takedown/${token}`,
      "",
      `Notice ${id}, ${report.at}. Reply to this email to answer the sender.`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    idempotencyKey: `report-${id}`,
  }).catch(() => false);
  // The public transparency page counts it (624 [SZ8](47)); nothing about who sent it or which store.
  // Only once it reached the inbox: a try that failed is sent again, and must not count twice.
  if (sent) await countNotice(report.kind);
  return sent ? "sent" : "error";
}

/** The product a notice's address points at (/@handle/p/<product>), when it points at one of this store's. */
export async function reportedProduct(report: Report, store: Store): Promise<Listing | null> {
  try {
    const parts = new URL(report.url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("p");
    const segment = at >= 0 ? decodeURIComponent(parts[at + 1] ?? "") : "";
    const id = segment ? productIdFromAddress(store, segment) : null;
    return id ? await readListing(store, id) : null;
  } catch {
    return null;
  }
}

/** The notice a token opens, and its store when the address names one. */
export async function openReport(token: string): Promise<{ report: Report; store: Store | null } | null> {
  if (!TAKEDOWN_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [id] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof id !== "string" || !id) return null;
  const [raw] = await redisPipeline([["GET", reportKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    const report = JSON.parse(raw) as Report;
    const store = report.handle ? await storeForHandle(report.handle) : null;
    return { report, store };
  } catch {
    return null;
  }
}

/**
 * The takedowns of this notice whose notice to the creator has not been confirmed as sent (the press that took it
 * down could not send it), with what was taken down and the action that sends it (sendOwedNotice). The statement of
 * reasons is owed once the content was restricted, even if it is up again since (EU DSA Art. 17(1)), so content that
 * is up again (a store switched back on, a product published again) stays listed, marked `up`. A takedown whose
 * steps do not say it landed (`applied`) is listed only when the content is down now; while it is up it was never
 * confirmed as taken down, so it is not listed as such (Claude 6, focal 6713440905). Every reply is read in its exact
 * shape (rule 24; Claude 6 on #3087): a read that fails or answers in another shape throws, so an unknown is never
 * "nothing owed".
 */
export async function unsentNotices(report: Pick<Report, "id">, store: Store): Promise<{ action: TakedownAction; what: string; up?: true }[]> {
  const replies = repliesFor(await redisPipeline([["SMEMBERS", owedKey(report.id)]]), 1);
  const members = replies ? stringList(replies[0]) : null;
  if (!members) throw new UnknownReplyError("a notice's owed takedowns");
  const owed: { action: TakedownAction; what: string; up?: true }[] = [];
  for (const part of members.slice().sort().slice(0, MAX_OWED)) {
    const action = actionOfPart(part);
    if (!action || (action.type === "store" && !action.on)) continue;
    const steps = await readSteps(noticeKey(report.id, part));
    if (!steps || steps.sent) continue;
    // Not confirmed as taken down: whether it is down now decides, read exactly (an unknown throws).
    if (!steps.applied && (await stillUp(store, action, ""))) continue;
    // Only a note for the operator: when whether it is up cannot be read, the page claims nothing about it.
    const up = steps.applied && (await stillUp(store, action, "").then(Boolean, () => false));
    owed.push(up ? { action, what: steps.what, up: true } : { action, what: steps.what });
  }
  return owed;
}

/** The action a takedown's part names ("<type>-<id>"), as takeDown wrote it. */
function actionOfPart(part: string): TakedownAction | null {
  const cut = part.indexOf("-");
  if (cut < 0) return null;
  const type = part.slice(0, cut);
  const id = part.slice(cut + 1);
  if ((type === "link" || type === "product") && id) return { type, id };
  if (type === "kit" && !id) return { type: "kit" };
  if (type === "store" && !id) return { type: "store", on: true };
  return null;
}

export type TakedownAction =
  | { type: "link"; id: string }
  | { type: "product"; id: string }
  | { type: "kit" }
  | { type: "store"; on: boolean };

/**
 * The email that tells the creator what was taken down could not be sent (Claude 6's rule-24 MEDIUM, 7 Nov 2026).
 * The law asks for it: the prompt notice of 17 U.S.C. § 512(g)(2)(A), the statement of reasons of EU DSA Art. 17.
 * The content stays down; pressing again sends the notice, once, under the same idempotency key.
 */
export class TakedownNoticeUnsent extends Error {
  constructor() {
    super("the takedown notice to the creator was not sent");
    this.name = "TakedownNoticeUnsent";
  }
}

/**
 *   nl:report:<id>:n:<action>  JSON  what one takedown of that notice took down and which of its steps are done,
 *                                    400 days, like the notice itself (the same company family, nl:report:)
 *
 * Written before the content is touched, so a press after a step failed (above all the notice to the creator)
 * finishes what is left instead of taking "already down" for "done". A notice once sent is never sent again.
 * `at` is when this takedown began: the notice's idempotency key carries it, so every retry of one takedown uses the
 * same key, while content published again and taken down again under the same notice is a new takedown with a new
 * key, whose notice the provider never answers with the first one's receipt.
 */
const noticeKey = (report: string, part: string) => reportKey(`${report}:n:${part}`);
/**
 *   nl:report:<id>:n  set  the takedowns of that notice whose steps were written, until their notice to the creator
 *                          went out, 400 days: what a page opened again lists as still owed (unsentNotices).
 */
const owedKey = (report: string) => reportKey(`${report}:n`);
/** The most takedowns of one notice a page lists as owed: one notice names one address, so a handful at most. */
const MAX_OWED = 50;
/**
 * `applied`: the content was confirmed taken down (apply returned true and this mark was confirmed). Steps written
 * before this field existed have none, and are read as not confirmed. `picture`: a product's old picture names, kept
 * before its record is pointed at the copies (lib/picture-withdraw.ts), so a later press deletes those files and
 * never moves the picture twice; absent until then. `hold`: for a link held after a copyright notice
 * (lib/takedown-hold.ts), the name its picture is kept under, chosen and kept before anything is copied, so a press
 * after a failed step copies to the same name.
 */
type Steps = { what: string; howLong: string; at: string; applied: boolean; noted: boolean; counted: boolean; sent: boolean; picture?: PictureNames; hold?: string };

/** Kept picture names, exactly: a path, and a smaller copy's path or null. */
const pictureNames = (value: unknown): value is PictureNames => {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return Boolean(v && typeof v.path === "string" && v.path && (v.small === null || (typeof v.small === "string" && v.small)));
};

/**
 * A takedown's steps, or null only when Redis itself answers null (no steps). A pipeline that answers nothing, or a
 * reply of any other shape, throws (Codex P on #3087, MEDIUM 1): an unknown is never "nothing owed".
 */
async function readSteps(key: string): Promise<Steps | null> {
  const replies = repliesFor(await redisPipeline([["GET", key]]), 1);
  if (!replies) throw new UnknownReplyError("a takedown's steps");
  const raw = replies[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a takedown's steps");
  const value: unknown = JSON.parse(raw);
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!v || typeof v.what !== "string" || !v.what || typeof v.howLong !== "string" || typeof v.at !== "string" || !/^\d+$/.test(v.at) ||
      (v.applied !== undefined && typeof v.applied !== "boolean") || typeof v.noted !== "boolean" || typeof v.counted !== "boolean" || typeof v.sent !== "boolean" ||
      (v.picture !== undefined && !pictureNames(v.picture)) || (v.hold !== undefined && !(typeof v.hold === "string" && v.hold.startsWith("images/")))) {
    throw new Error("a takedown's steps could not be read");
  }
  const picture = pictureNames(v.picture) ? { path: v.picture.path, small: v.picture.small } : null;
  return { what: v.what, howLong: v.howLong, at: v.at, applied: v.applied === true, noted: v.noted, counted: v.counted, sent: v.sent, ...(picture ? { picture } : {}), ...(typeof v.hold === "string" ? { hold: v.hold } : {}) };
}

/**
 * Writes a takedown's steps, and throws unless Redis answers exactly "OK" (Codex P on #3087, MEDIUM 2): the first
 * write is the recovery record, so content is never taken down without it being confirmed.
 */
async function writeSteps(key: string, steps: Steps): Promise<void> {
  const replies = repliesFor(await redisPipeline([["SET", key, JSON.stringify(steps), "EX", REPORT_SECONDS]]), 1);
  if (!replies || replies[0] !== "OK") throw new UnknownReplyError("a takedown's steps write");
}

/** Lists a takedown as owed until its notice goes out; throws unless both replies are in their exact shape. */
async function markOwed(report: string, part: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([["SADD", owedKey(report), part], ["EXPIRE", owedKey(report), REPORT_SECONDS]]), 2);
  if (!replies || countOf(replies[0]) === null || replies[1] !== 1) throw new UnknownReplyError("a notice's owed takedowns write");
}

/**
 * What the action would take down, in words, while it is up; null when it is down or not there. A read that fails,
 * or a product the store lists whose record answers nothing, throws: an unknown is never "already down".
 */
async function stillUp(store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string, kind: Report["kind"] | null = null, at = Date.now()): Promise<{ what: string; howLong: string } | null> {
  // Art. 17(3)(a), how long: what the code makes it last, for each kind (Claude 5's MEDIUM on #2928). A link taken down
  // for a copyright notice is held until the counter-notice window ends, and put back after a counter-notice
  // (lib/takedown-hold.ts, C6-92); after any other notice a link and its file are deleted; a product or the media kit is
  // unpublished, and the creator can publish it again (the studio does not stop them), which Terms section 3 lets us
  // answer by suspending the store; a store stays off until we switch it back.
  if (action.type === "link") {
    const link = store.links.find((l) => l.id === action.id && !l.header);
    if (!link) return null;
    const what = `The link "${link.title}" (${link.url})`;
    if (kind === "copyright") {
      const day = dateWords(holdUntil(at));
      return {
        what,
        howLong: `How long: until ${day}. We keep the link${link.image ? " and its picture" : ""}, hidden from everyone, until then. If you send us a counter-notice by that day (see below), we put ${link.image ? "them" : "it"} back as ${link.image ? "they were" : "it was"} 10 to 14 business days after we receive it, unless the person who sent the notice tells us first that they have gone to court. If you do not, ${link.image ? "they are" : "it is"} deleted on ${day}.`,
      };
    }
    return { what, howLong: "How long: for good. The link and its file are deleted, so there is nothing to put back." };
  }
  if (action.type === "product") {
    if (!store.catalog.items.some((item) => item.id === action.id)) return null;
    // Read by id, however far down the store's list it is (lib/catalog.ts). A failed read throws to the caller.
    const product = await readListing(store, action.id);
    if (!product) throw new Error("the store lists this product, but its record could not be read");
    if (product.hidden) return null;
    return {
      what: `The product "${product.title}", now unpublished`,
      howLong: `How long: until you publish it again. Publishing it again while the notice stands may lead us to suspend your store (Terms, section 3, ${origin}/terms#selling-through-a-marktmorgen-store).`,
    };
  }
  if (action.type === "kit") {
    if (!store.kit.on) return null;
    return {
      what: "Your media kit, now unpublished",
      howLong: `How long: until you switch it on again. Switching it on again while the notice stands may lead us to suspend your store (Terms, section 3, ${origin}/terms#selling-through-a-marktmorgen-store).`,
    };
  }
  if (store.suspended) return null;
  return { what: "Your store's pages and sales, now switched off", howLong: "How long: until we switch your store back on, for example after your answer below." };
}

/** Takes it down. False when it went in the meantime (nothing was done); throws when the write's outcome is unknown. */
async function apply(ref: string, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, hold: { report: Report; steps: Steps; token: string } | null = null): Promise<boolean> {
  if (action.type === "link" && hold) return holdLink(ref, store, action.id, hold.report, hold.steps, hold.token);
  if (action.type === "link") {
    const done = await removeStoreLink(ref, action.id);
    if (!done.ok) {
      if (done.reason === "unknown") return false;
      throw new Error("the store could not be written");
    }
    if (done.removed) await del(done.removed.path).catch(() => {});
    return true;
  }
  if (action.type === "product") {
    const done = await setProductHidden(ref, action.id, true);
    if (!done.ok) {
      if (done.reason === "unknown") return false;
      throw new Error("the store could not be written");
    }
    return true;
  }
  if (action.type === "kit") {
    if (!(await setKit(ref, { ...store.kit, on: false }))) throw new Error("the store could not be written");
    return true;
  }
  if (!(await noteTakedown(ref, null, true))) throw new Error("the store could not be written");
  return true;
}

/**
 * Takes one piece of content down, or switches the store off or back on,
 * writes it on the store's record and tells the creator. Returns what was
 * done, in words, or null when there was nothing to do it to. Throws when
 * what is there cannot be known or written, and TakedownNoticeUnsent when
 * the content is down but the creator could not be told: pressing again
 * then sends the notice without taking anything down or writing it twice.
 * `token`: the notice's page token, kept working while a link it took down
 * is held (lib/takedown-hold.ts).
 */
export async function takeDown(report: Report, store: Store, action: TakedownAction, origin: string, token = ""): Promise<string | null> {
  const ref = storeRef(store);
  if (action.type === "store" && !action.on) {
    if (!store.suspended) return null;
    if (!(await noteTakedown(ref, null, false))) throw new Error("the store could not be written");
    // A switch-off whose notice was not sent stays owed: the statement of reasons is owed once the restriction was
    // imposed, even after it is lifted (EU DSA Art. 17(1)); the page still offers it (sendOwedNotice).
    // Back on: the creator is told, and nothing is added to the record.
    await sendEmail({ meter: { by: "company" },
      from: NIMBUS_FROM,
      to: store.email,
      replyTo: SUPPORT_EMAIL,
      subject: `Your store @${store.handle} is back on`,
      text: [`Your store's pages and sales are switched back on, after the notice about ${report.url}.`, "", `Our policy: ${origin}/copyright.`].join("\n"),
      idempotencyKey: `takedown-${report.id}-restore-${Date.now()}`,
    }).catch(() => false);
    return "The store's pages and sales are back on.";
  }
  return underLock(report, store, action, (now, part, key) => finish(report, now, action, origin, part, key, token));
}

/**
 * The email still owed for a takedown of this notice, from the page's "Send the email to the creator" (Claude 6 on
 * #3087, MEDIUM 3): it only finishes the kept steps and never takes anything down, so content the operator switched
 * back on, or the creator published again, stays up. Finishing writes the original takedown's strike (dated from its
 * `at`) when it was not written yet, the count, and the statement of reasons in the kept words, under the same
 * idempotency key. The statement is still sent after a restore: it is owed once the restriction was imposed, even if
 * it was lifted since (EU DSA Art. 17(1)). Nothing kept, or a notice already sent, is null.
 *
 * Steps not confirmed as applied (Claude 6, focal 6713440905): they are written before the content is touched, so they
 * say a takedown started, not that it is down. The content's state now decides, read exactly (an unknown throws):
 * down, the write landed, so it is marked applied and finished; up, it is "unconfirmed": no strike, no email, and the
 * takedown is no longer owed. That includes the case nobody can tell apart from it, a write that landed without being
 * confirmed and content that went back up before this press: we could not confirm it was taken down, so we say so and
 * tell the creator nothing that may be false.
 */
export async function sendOwedNotice(report: Report, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string): Promise<{ done: string } | "unconfirmed" | null> {
  return underLock(report, store, action, async (now, part, key) => {
    let kept = await readSteps(key);
    if (!kept || kept.sent) return null;
    if (!kept.applied) {
      if (await stillUp(now, action, origin)) {
        const replies = repliesFor(await redisPipeline([["SREM", owedKey(report.id), part]]), 1);
        if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("a notice's owed takedowns write");
        return "unconfirmed" as const;
      }
      kept = { ...kept, applied: true };
      await writeSteps(key, kept);
    }
    // The picture too, while the product is still off the store (R44); one the creator published again keeps it.
    if (action.type === "product") kept = await withdrawPicture(storeRef(now), action.id, key, kept);
    return { done: await complete(report, now, action, origin, part, key, kept) };
  });
}

/**
 * One press at a time for one piece of content under one notice (Claude 6, #3087, LEVE 3): two presses at once
 * would both see it up, both write it on the store's record and both tell the creator. The second waits, then reads
 * the store again, so it finds the content down and the first one's steps, and has only what is left to finish.
 */
async function underLock<T>(report: Report, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, work: (now: Store, part: string, key: string) => Promise<T>): Promise<T> {
  const ref = storeRef(store);
  const part = `${action.type}-${"id" in action ? action.id : ""}`;
  const key = noticeKey(report.id, part);
  return withLock(`${key}:lock`, TAKEDOWN_LOCK_SECONDS, TAKEDOWN_LOCK_WAIT_MS, async () => {
    const now = await storeForHandle(store.handle);
    if (!now || storeRef(now) !== ref) throw new Error("the store could not be read again");
    return work(now, part, key);
  });
}

/** How long one press may hold the content's lock (the notice's send included), and how long another waits for it. */
const TAKEDOWN_LOCK_SECONDS = 120;
const TAKEDOWN_LOCK_WAIT_MS = 10_000;

async function finish(report: Report, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string, part: string, key: string, token: string): Promise<string | null> {
  const ref = storeRef(store);
  const at = Date.now();
  const holding = action.type === "link" && report.kind === "copyright";
  const up = await stillUp(store, action, origin, report.kind, at);
  let steps: Steps;
  if (up) {
    // A link held after a copyright notice: the name its picture is kept under, chosen now and kept with the steps.
    const picture = holding ? store.links.find((l) => l.id === (action as { id: string }).id)?.image?.path ?? null : null;
    steps = { ...up, at: String(at), applied: false, noted: false, counted: false, sent: false, ...(picture ? { hold: heldName(picture) } : {}) };
    // The recovery record first, each write confirmed, so nothing is taken down without it (Codex P on #3087).
    await writeSteps(key, steps);
    // Owed from here until its notice goes out, so a page opened again can still send it (unsentNotices).
    await markOwed(report.id, part);
    if (!(await apply(ref, store, action, holding ? { report, steps, token } : null))) {
      await redisPipeline([["DEL", key], ["SREM", owedKey(report.id), part]]).catch(() => {});
      return null;
    }
    // Down, confirmed: from here the steps say it landed (Claude 6, focal 6713440905).
    steps = { ...steps, applied: true };
    await writeSteps(key, steps);
  } else {
    // Down already: only a takedown of this notice whose steps are not all done is left to finish. Steps not marked
    // applied, with the content down now, mean the write landed without its mark being confirmed.
    const kept = await readSteps(key);
    if (!kept || kept.sent) return null;
    steps = kept;
    if (!steps.applied) {
      steps = { ...steps, applied: true };
      await writeSteps(key, steps);
    }
    // Held, and the delete of its picture's old file not confirmed: done again before the creator is told.
    if (holding) await withdrawHeldOriginal(store, report.id, (action as { id: string }).id);
  }
  // A product's picture leaves the address its pages gave out before the creator is told it is down (R44).
  if (action.type === "product") steps = await withdrawPicture(ref, action.id, key, steps);
  return complete(report, store, action, origin, part, key, steps);
}

/** Moves a product's picture (lib/picture-withdraw.ts), its old names kept with the steps first; the steps as they are now. */
async function withdrawPicture(ref: string, id: string, key: string, steps: Steps): Promise<Steps> {
  let kept = steps;
  await withdrawProductPicture(ref, id, kept.picture ?? null, async (picture) => {
    kept = { ...kept, picture };
    await writeSteps(key, kept);
  });
  return kept;
}

/** Whether the store already keeps this strike (as lib/store.ts parseStrikes keeps it: report, time and words). */
function heldStrike(store: Store, strike: { at: string; what: string; report: string }): boolean {
  return store.strikes.some((s) => s.report === strike.report.slice(0, 40) && s.at === strike.at.slice(0, 30) && s.what === strike.what.slice(0, 200));
}

/** The steps left after the content is down: the strike, the count, the notice to the creator, each once. */
async function complete(report: Report, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string, part: string, key: string, kept: Steps): Promise<string> {
  const ref = storeRef(store);
  let steps = kept;
  const { what, howLong } = steps;
  if (!steps.noted) {
    // One strike per takedown (Claude 6 on #3087, MEDIUM 2): dated when this takedown began, so a retry after the
    // mark below failed finds it on the store, read under this content's lock (underLock), and writes none.
    const strike = { at: new Date(Number(steps.at)).toISOString(), what, report: report.id };
    if (!heldStrike(store, strike) && !(await noteTakedown(ref, strike))) throw new Error("the store could not be written");
    steps = { ...steps, noted: true };
    await writeSteps(key, steps);
  }
  if (!steps.counted) {
    // Marked before counting: if the count is then lost, the transparency figure is one short, never one too many
    // (countStep itself never throws and already drops a count it could not write).
    steps = { ...steps, counted: true };
    await writeSteps(key, steps);
    await countStep(report, action.type);
  }
  const sent = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: store.email,
    replyTo: SUPPORT_EMAIL,
    subject: `Content taken down from your store @${store.handle}`,
    text: [
      `We received a ${report.kind === "copyright" ? "copyright notice" : "notice that content on your store is illegal"} about ${report.url} and took this down:`,
      "",
      what,
      "",
      "Where: everywhere. It is down for every visitor, in every country.",
      howLong,
      "",
      report.kind === "copyright" ? `The notice was sent by ${report.name}, who says it uses: ${report.work.slice(0, 600)}` : `The notice says: ${report.work.slice(0, 600)}`,
      "",
      `What we relied on: that notice, sent through our form at ${origin}/report as ${report.kind === "copyright" ? "a copyright notice under the US Digital Millennium Copyright Act (17 U.S.C. § 512(c)(3))" : "a notice of illegal content under Article 16 of the EU Digital Services Act"}.`,
      "We used no automated means to find this content or to decide: a person at Marktmorgen read the notice and made this decision.",
      report.kind === "copyright"
        ? "Legal ground: copyright law. The notice says the content infringes the copyright in the work it names, and we took it down for that reason."
        : "Legal ground: the law the notice says the content breaks, for the reason it gives above. We took it down for that reason.",
      `Our Terms do not allow content that is unlawful or that infringes someone else's rights: section 3, "Selling through a Marktmorgen store" (${origin}/terms#selling-through-a-marktmorgen-store), and section 4, "Acceptable use" (${origin}/terms#acceptable-use).`,
      "",
      report.kind === "copyright"
        ? `If you believe it was taken down by mistake, or that you have the right to use it, you can send a counter-notice by replying to this email with: your name and signature; what was taken down and where it was; a statement, under penalty of perjury, that you believe in good faith it was taken down by mistake or misidentification; your address and telephone number; and a statement that you consent to the jurisdiction of the federal court for your district (or, outside the US, any judicial district where Marktmorgen may be found) and will accept service from the person who sent the notice. We pass it to them, and put the content back 10 to 14 business days after we receive it unless they tell us first that they have gone to court.${action.type === "link" ? ` For this link, the counter-notice has to reach us by the day above.` : ""}`
        : "If you believe this was a mistake, reply to this email and say why; we look at it again and tell you what we decided.",
      `You can also take our decision to a court. Section 16 of our Terms, "Governing law", says which law and courts apply (${origin}/terms#governing-law).`,
      "",
      `Our policy: ${origin}/copyright. Stores that are the subject of repeated valid notices are switched off.`,
    ].join("\n"),
    // The same key on every try of this takedown, so a notice the provider took is never sent twice; a later
    // takedown of the same content under the same notice has its own `at`, so its notice is a new email.
    idempotencyKey: `takedown-${report.id}-${part}-${steps.at}`,
  }).catch(() => false);
  if (!sent) throw new TakedownNoticeUnsent();
  // When the creator was told, kept before the steps say "sent" and only once (NX): a retry after a lost mark sends
  // under the same idempotency key and keeps the first confirmed time (noticeSentAt; the six months to ask us to
  // look again start here, lib/takedown-appeals.ts).
  await keepSentAt(report.id, { at: new Date(Number(steps.at)).toISOString(), what }, Date.now());
  await writeSteps(key, { ...steps, sent: true });
  // No longer owed. If this fails the steps say it was sent, and unsentNotices reads the steps, not the set alone.
  await redisPipeline([["SREM", owedKey(report.id), part]]).catch(() => {});
  return what;
}

// ---------------------------------------------------------------------------------------------------------------
// When the creator was told (C6-92, for 646 [WG6]: the six months to ask us to look again start then)
// ---------------------------------------------------------------------------------------------------------------

/**
 *   nl:report:<id>:s:<sha(at, what)>  string  when the notice of one takedown of that notice went out to the creator
 *                                             (ISO, the time the email service confirmed it), 400 days like the
 *                                             notice; written once. The company's, like the notice (nl:report:).
 * Named by the takedown's strike as the store keeps it (lib/store.ts parseStrikes: `at` and `what`, cut the same way),
 * so whoever reads a store's strikes finds it.
 */
const sentKey = (report: string, strike: { at: string; what: string }) =>
  reportKey(`${report}:s:${sha(`nimbus-told:${strike.at.slice(0, 30)}\n${strike.what.slice(0, 200)}`).slice(0, 24)}`);

/** Keeps when a takedown's notice went out; throws unless Redis answers OK (written now) or null (kept already). */
async function keepSentAt(report: string, strike: { at: string; what: string }, now: number): Promise<void> {
  const replies = repliesFor(await redisPipeline([["SET", sentKey(report, strike), new Date(now).toISOString(), "NX", "EX", REPORT_SECONDS]]), 1);
  if (!replies || (replies[0] !== "OK" && replies[0] !== null)) throw new UnknownReplyError("a takedown notice's send time write");
}

/**
 * When the creator was sent the notice of the takedown this strike records (ISO), or null when none is kept: the
 * notice has not gone out, or went out before this was kept (10 November 2026). Read exactly (rule 24): a reply of
 * any other shape, or a value that is not a time, throws; it is never "now" and never "not sent".
 */
export async function noticeSentAt(report: string, strike: { at: string; what: string }): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(report)) return null;
  const replies = repliesFor(await redisPipeline([["GET", sentKey(report, strike)]]), 1);
  if (!replies) throw new UnknownReplyError("a takedown notice's send time");
  const value = replies[0];
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new UnknownReplyError("a takedown notice's send time");
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Links held after a copyright notice (C6-92, lib/takedown-hold.ts)
// ---------------------------------------------------------------------------------------------------------------

/** "December 10, 2026": a day as the creator's email and the notice's page say it, in UTC. */
const dateWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });

/**
 * The name a held link's picture is kept under: the same folder of the store's own (so it stays the store's), the
 * same type, and a random name no page ever gives out; the old address answers "not found" from us meanwhile.
 */
function heldName(path: string): string {
  return `${path.slice(0, path.lastIndexOf("/"))}/${randomBytes(16).toString("hex")}${path.slice(path.lastIndexOf("."))}`;
}

/**
 *   nl:report:held                 zset  store ref -> when its held links next need a look (ms), for the daily job
 *   nl:report:held:<sha(ref)>:lock string one change at a time to one store's held links
 *   nl:report:held:run             string one run of the daily job at a time
 * The company's, like the notices themselves (the nl:report: family).
 */
const heldLockKey = (ref: string) => `${HELD_INDEX}:${sha(`nimbus-held:${ref}`)}:lock`;
const HELD_RUN = reportKey("held:run");
const HELD_LOCK_SECONDS = 120;
const HELD_LOCK_WAIT_MS = 10_000;
/** The most stores one run of the daily job looks at; the rest wait for the next run. */
const HELD_PER_RUN = 100;
/** A store that could not be read is looked at again a week later, never forgotten. */
const UNREAD_AGAIN_MS = 7 * 86_400_000;

/**
 * Takes a store off the daily job's index; throws unless Redis confirms it. One member is named, so only 0 or 1 is a
 * receipt: any other count is unknown (review of #3539), never a removal.
 */
async function dropFromIndex(ref: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([["ZREM", HELD_INDEX, ref]]), 1);
  const removed = replies ? countOf(replies[0]) : null;
  if (removed !== 0 && removed !== 1) throw new UnknownReplyError("the held links' index write");
}

/** Asks the daily job to look at this store's held links at its next run; throws unless Redis confirms it. */
async function lookAgain(ref: string, at: number): Promise<void> {
  const replies = repliesFor(await redisPipeline([["ZADD", HELD_INDEX, at, ref]]), 1);
  const added = replies ? countOf(replies[0]) : null;
  if (added !== 0 && added !== 1) throw new UnknownReplyError("the held links' index write");
}

/**
 * Keeps the notice's page working while a link it took down is held, and for the put-back after it
 * (NOTICE_PAGE_AFTER_HOLD_DAYS): the operator records a counter-notice there. Never shortens it; throws unless Redis
 * confirms, so nothing is held that its page could not reach.
 */
async function keepNoticePage(token: string, until: number): Promise<void> {
  if (!TAKEDOWN_TOKEN.test(token)) return;
  const want = Math.ceil((until + NOTICE_PAGE_AFTER_HOLD_DAYS * 86_400_000 - Date.now()) / 1000);
  const replies = repliesFor(await redisPipeline([["TTL", tokenKey(token)]]), 1);
  const ttl = replies && typeof replies[0] === "number" && Number.isSafeInteger(replies[0]) ? replies[0] : null;
  if (ttl === null) throw new UnknownReplyError("a notice page's lifetime");
  // -2: the page is gone already; -1: it never expires, so it already lasts long enough.
  if (ttl === -2 || ttl === -1 || ttl >= want) return;
  const set = repliesFor(await redisPipeline([["EXPIRE", tokenKey(token), want]]), 1);
  if (!set || set[0] !== 1) throw new UnknownReplyError("a notice page's lifetime write");
}

/** Copies one file; "copied" when the copy is there (made now or before), "absent" only when neither is there. */
async function copyFile(from: string, to: string): Promise<"copied" | "absent"> {
  try {
    await copy(from, to, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: imageType(to) });
    return "copied";
  } catch (error) {
    if (await fileThere(to)) return "copied";
    if (!(await fileThere(from))) return "absent";
    throw error;
  }
}

/** Whether a file is there: false only when the file store says it is not; anything else throws. */
async function fileThere(path: string): Promise<boolean> {
  try {
    await head(path);
    return true;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false;
    throw error;
  }
}

/**
 * Holds a link after a copyright notice: its page token kept working, the daily job told, its picture copied to the
 * kept name, the link moved from the page to the held list with its place, and only then its picture's old file
 * deleted. Each step confirmed or it throws, and the next press finishes (finish, withdrawHeldOriginal). False when
 * the link went in the meantime. One change to one store's held links at a time (heldLockKey).
 */
async function holdLink(ref: string, store: Store, id: string, report: Report, steps: Steps, token: string): Promise<boolean> {
  const link = store.links.find((l) => l.id === id && !l.header);
  if (!link) return false;
  const until = holdUntil(Number(steps.at));
  await keepNoticePage(token, until);
  return withLock(heldLockKey(ref), HELD_LOCK_SECONDS, HELD_LOCK_WAIT_MS, async () => {
    await lookAgain(ref, Date.now());
    const original = link.image?.path ?? null;
    let kept: string | null = null;
    if (original) {
      if (!steps.hold) throw new Error("a held link's picture has no name to be kept under");
      kept = (await copyFile(original, steps.hold)) === "copied" ? steps.hold : null;
    }
    const done = await holdStoreLink(ref, id, original, { report: report.id, heldAt: new Date(Number(steps.at)).toISOString(), until: new Date(until).toISOString(), picture: kept });
    if (!done.ok) {
      if (kept) await del(kept).catch((error: unknown) => console.error("could not delete the copy of a link's picture that was not held", error));
      if (done.reason === "unknown") return false;
      throw new Error(done.reason === "changed" ? "the link's picture changed while it was being taken down" : "the store could not be written");
    }
    // The old address stops answering only now that the record keeps the copy; a delete not confirmed throws, and the
    // next press deletes it again (withdrawHeldOriginal) before the creator is told.
    if (original) await del(original);
    return true;
  });
}

/** For a link held under this notice: deletes its picture's old file again (idempotent); throws unless confirmed. */
async function withdrawHeldOriginal(store: Store, report: string, id: string): Promise<void> {
  const held = (store.heldLinks ?? []).find((h) => h.report === report && h.link.id === id);
  if (held?.link.image) await del(held.link.image.path);
}

/**
 * Puts a held link back: its picture copied back to its old address first (a counter-notice made it due, so the
 * address answering again before the record does is what the law asks), then the link at its place, then the kept
 * copy deleted, and the creator told. Throws unless each step is confirmed: the link stays held for the next try.
 */
async function putBack(ref: string, held: HeldLink, origin: string): Promise<boolean> {
  let copiedBack = false;
  if (held.picture && held.link.image) {
    const back = await copyFile(held.picture, held.link.image.path);
    if (back === "absent") console.error("a held link's picture was not found; it goes back without it");
    copiedBack = back === "copied";
  }
  const done = await restoreHeldLink(ref, held.report, held.link.id, held.heldAt);
  if (!done.ok) {
    await afterNoPutBack(ref, held, copiedBack);
    if (done.reason === "none") return false;
    throw new Error("the store's list of links is full");
  }
  if (held.picture) await del(held.picture).catch((error: unknown) => console.error("could not delete the kept copy of a link's picture put back", error));
  const now = await storeForEmail(ref);
  if (now) {
    await sendEmail({ meter: { by: "company" },
      from: NIMBUS_FROM,
      to: now.email,
      replyTo: SUPPORT_EMAIL,
      subject: `Your link "${held.link.title}" is back on your store @${now.handle}`.slice(0, 200),
      text: [
        `We received your counter-notice about the link "${held.link.title}" (${held.link.url}), and the person who sent the copyright notice did not tell us they have gone to court.`,
        "",
        `So it is back on your store, as it was${held.picture ? ", with its picture" : ""}.`,
        "",
        `Our policy: ${origin}/copyright.`,
      ].join("\n"),
      idempotencyKey: `takedown-${held.report}-link-${held.link.id}-${Date.parse(held.heldAt)}-back`,
    }).catch(() => false);
  }
  return true;
}

/**
 * After a put-back that did not happen, by the store as it is now (review of #3539): while the link is still held, the
 * picture copied back to its old address is deleted again, so that address keeps answering "not found"; once the hold
 * is gone and the link is not on the page with that picture, the copy back and the kept copy are deleted too; once
 * the link is back with it, only the kept copy. A store that cannot be read leaves every file as it is (rule 24), and
 * the next try settles it. A delete that fails is logged; the next run or press deletes it again.
 */
async function afterNoPutBack(ref: string, held: HeldLink, copiedBack: boolean): Promise<void> {
  const oldPath = copiedBack && held.link.image ? held.link.image.path : null;
  const store = await storeForEmail(ref);
  let files: string[];
  if (store) {
    const stillHeld = (store.heldLinks ?? []).some((h) => h.report === held.report && h.link.id === held.link.id && h.heldAt === held.heldAt);
    const live = oldPath !== null && store.links.some((l) => l.image?.path === oldPath);
    files = stillHeld ? (oldPath ? [oldPath] : []) : [...(held.picture ? [held.picture] : []), ...(oldPath && !live ? [oldPath] : [])];
  } else if ((await storeRecordKept(ref)) === false) {
    files = [...(held.picture ? [held.picture] : []), ...(oldPath ? [oldPath] : [])];
  } else {
    return;
  }
  if (files.length) await del(files).catch((error: unknown) => console.error("could not delete a held link's picture after a put-back that did not happen", error));
}

/** Deletes a held link whose window ended: its kept picture first, then the record. Throws unless confirmed. */
async function deleteHeld(ref: string, held: HeldLink): Promise<boolean> {
  const files = [...(held.picture ? [held.picture] : []), ...(held.link.image ? [held.link.image.path] : [])];
  if (files.length) await del(files);
  return dropHeldLink(ref, held.report, held.link.id, held.heldAt);
}

export type HeldCounts = { restored: number; deleted: number; waiting: number; failed: number; busy?: true };

/** One store's held links, under its lock: what is due is done, and the daily job told when to look next. */
async function settleStore(ref: string, now: number, counts: HeldCounts): Promise<void> {
  await withLock(heldLockKey(ref), HELD_LOCK_SECONDS, HELD_LOCK_WAIT_MS, async () => {
    const store = await storeForEmail(ref);
    if (!store) {
      // A store that is gone has nothing held left to settle: its entry leaves the index, so no address stays in it.
      // One that could not be read is never taken for gone (rule 24): looked at again later.
      if ((await storeRecordKept(ref)) === false) {
        await dropFromIndex(ref);
        return;
      }
      counts.failed += 1;
      await lookAgain(ref, now + UNREAD_AGAIN_MS);
      return;
    }
    if (store.heldUnread?.length) console.error("a store keeps held links that could not be read; they are left as they are", { count: store.heldUnread.length });
    let next = Number.POSITIVE_INFINITY;
    for (const held of store.heldLinks ?? []) {
      const due = heldDue(held, now);
      if (due.act === "wait") {
        counts.waiting += 1;
        next = Math.min(next, due.next);
        continue;
      }
      try {
        if (due.act === "restore" ? await putBack(ref, held, SITE_URL) : await deleteHeld(ref, held)) counts[due.act === "restore" ? "restored" : "deleted"] += 1;
      } catch (error) {
        console.error("a held link could not be settled; it stays held", error);
        counts.failed += 1;
        next = Math.min(next, now);
      }
    }
    if (Number.isFinite(next)) {
      await lookAgain(ref, next);
      return;
    }
    await dropFromIndex(ref);
  });
}

/**
 * The daily job (app/api/cron/takedowns): every store whose held links are due by `now`, at most HELD_PER_RUN, one
 * run at a time. A held link goes back once its counter-notice is RESTORE_AFTER_WEEKDAYS weekdays old; one with no
 * counter-notice, or whose sender went to court, is deleted when its window ends. A list or a store that answers in
 * an unknown shape does nothing: never put back, never deleted, looked at again (rule 24).
 */
export async function settleHeld(now = Date.now()): Promise<HeldCounts> {
  const counts: HeldCounts = { restored: 0, deleted: 0, waiting: 0, failed: 0 };
  const lock = claimValue();
  const got = await claimMark(HELD_RUN, 300, lock);
  if (got === "taken") return { ...counts, busy: true };
  if (got !== "ours") return { ...counts, failed: 1 };
  try {
    const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", HELD_INDEX, "-inf", now, "LIMIT", 0, HELD_PER_RUN]]), 1);
    const refs = replies ? stringList(replies[0]) : null;
    if (!refs) throw new UnknownReplyError("the held links' index");
    for (const ref of refs) {
      try {
        await settleStore(ref, now, counts);
      } catch (error) {
        console.error("a store's held links could not be looked at", error);
        counts.failed += 1;
      }
    }
    return counts;
  } finally {
    await releaseMark(HELD_RUN, lock);
  }
}

/**
 * The links this notice holds on this store, for its page: when each goes back (once its counter-notice is in), and
 * which of the page's buttons acts on it now, by the same rules as actOnHeld.
 */
export function heldByNotice(report: Pick<Report, "id">, store: Store, now = Date.now()): (HeldLink & { back: number | null; canCounter: boolean; canRestore: boolean })[] {
  return (store.heldLinks ?? []).filter((h) => h.report === report.id).map((h) => ({
    ...h,
    back: h.counter && !h.court ? restoreFrom(Date.parse(h.counter)) : null,
    canCounter: !h.counter && now < Date.parse(h.until),
    canRestore: heldDue(h, now).act === "restore",
  }));
}

export type HeldOp = "counter" | "court" | "restore";

/**
 * From the notice's page: a counter-notice came in (only inside the window, once), the sender says they went to court
 * (only after a counter-notice, once), or put it back now (only once it is due, as the daily job would). What was
 * done, in words, or null when there was nothing to do. Throws when a step is not confirmed.
 */
export async function actOnHeld(report: Report, store: Store, id: string, op: HeldOp, origin: string, now = Date.now()): Promise<string | null> {
  const ref = storeRef(store);
  return withLock(heldLockKey(ref), HELD_LOCK_SECONDS, HELD_LOCK_WAIT_MS, async () => {
    const fresh = await storeForEmail(ref);
    if (!fresh) throw new Error("the store could not be read again");
    const held = (fresh.heldLinks ?? []).find((h) => h.report === report.id && h.link.id === id);
    if (!held) return null;
    const title = `The link "${held.link.title}"`;
    if (op === "counter") {
      if (held.counter || now >= Date.parse(held.until)) return null;
      await lookAgain(ref, now);
      const marked = await markHeldLink(ref, held.report, held.link.id, held.heldAt, { counter: new Date(now).toISOString() });
      if (!marked) throw new Error("the store could not be written");
      return `Counter-notice recorded. ${title} goes back on ${dateWords(restoreFrom(now))}, unless the sender tells us first that they have gone to court. Send them a copy of the counter-notice now.`;
    }
    if (op === "court") {
      if (!held.counter || held.court) return null;
      await lookAgain(ref, now);
      const marked = await markHeldLink(ref, held.report, held.link.id, held.heldAt, { court: true });
      if (!marked) throw new Error("the store could not be written");
      return `Recorded. ${title} stays down and is deleted on ${dateWords(Math.max(now, Date.parse(held.until)))}.`;
    }
    if (heldDue(held, now).act !== "restore") return null;
    return (await putBack(ref, held, origin)) ? `${title} is back on the store.` : null;
  });
}
