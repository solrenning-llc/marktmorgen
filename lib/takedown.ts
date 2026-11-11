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
import { type Store, noteTakedown, removeStoreLink, setKit, setProductHidden, storeForHandle, storeRef } from "@/lib/store";
import { del } from "@/lib/blob";
import { withLock } from "@/lib/redis-lock";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type Listing, productIdFromAddress, readListing } from "@/lib/catalog";
import { REPORT_TITLES, type ReportInput, type ReportKind, canonicalAddress, handleIn, privateReport, statedBySender } from "@/lib/takedown-rules";
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
    subject: `${REPORT_TITLES[report.kind]}${report.handle ? ` about @${report.handle}` : ""}`.slice(0, 200),
    text: [
      `A ${NOTICE_NAMES[report.kind]} was sent from ${origin}/report.`,
      "",
      `Where: ${report.url}`,
      report.handle ? `Store: @${report.handle}` : "Store: not named in the address; check it by hand.",
      report.kind === "child_safety" ? "Do not open, download, forward or describe the reported content; the urgent email says what was done and docs/incident-response.md the steps." : "",
      "",
      ...(report.work ? [WORK_HEADINGS[report.kind], report.work] : []),
      report.original ? `\nWhere the original is: ${report.original}` : "",
      "",
      // A child-safety report asks for no name, signature or statement: only what was given is said (Revisor 2 on #3587).
      `From: ${report.name ? `${report.name} <${report.email}>` : report.email}`,
      report.contact ? `Address or telephone: ${report.contact}` : "",
      statedBySender(report.kind) ? `Signed: ${report.signature}` : "",
      statedBySender(report.kind) ?? "They were asked for no signature or sworn statement, so that nobody is put off reporting.",
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

/** What each kind of notice is, in the first line of the email that brings it to the inbox. */
const NOTICE_NAMES: Record<ReportKind, string> = {
  copyright: "copyright notice (DMCA, 17 U.S.C. § 512(c)(3))",
  other: "notice of illegal content (EU Digital Services Act, Art. 16)",
  child_safety: "report of child sexual exploitation",
  intimate_image: "request to remove an intimate image shared without consent (TAKE IT DOWN Act)",
};

/** The heading over the sender's own words in that email. */
const WORK_HEADINGS: Record<ReportKind, string> = {
  copyright: "The work, as they describe it:",
  other: "Why it is illegal, as they say:",
  child_safety: "What they added to help find it (they were asked never to describe the images):",
  intimate_image: "Which image, as they say:",
};

/**
 * The address a notice names, as the creator is told it: a report about a child or an intimate image gives only the
 * page, never a query or a fragment the reporter added to it (Revisor 2 on #3587).
 */
function addressForCreator(report: Report): string {
  return privateReport(report.kind) ? (canonicalAddress(report.url) ?? "the address in the report") : report.url;
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
 * never moves the picture twice; absent until then.
 */
type Steps = { what: string; howLong: string; at: string; applied: boolean; noted: boolean; counted: boolean; sent: boolean; picture?: PictureNames };

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
      (v.picture !== undefined && !pictureNames(v.picture))) {
    throw new Error("a takedown's steps could not be read");
  }
  const picture = pictureNames(v.picture) ? { path: v.picture.path, small: v.picture.small } : null;
  return { what: v.what, howLong: v.howLong, at: v.at, applied: v.applied === true, noted: v.noted, counted: v.counted, sent: v.sent, ...(picture ? { picture } : {}) };
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
async function stillUp(store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string): Promise<{ what: string; howLong: string } | null> {
  // Art. 17(3)(a), how long: what the code makes it last, for each kind (Claude 5's MEDIUM on #2928). A link and its file
  // are deleted; a product or the media kit is unpublished, and the creator can publish it again (the studio does not
  // stop them), which Terms section 3 lets us answer by suspending the store; a store stays off until we switch it back.
  if (action.type === "link") {
    const link = store.links.find((l) => l.id === action.id && !l.header);
    if (!link) return null;
    return { what: `The link "${link.title}" (${link.url})`, howLong: "How long: for good. The link and its file are deleted, so there is nothing to put back." };
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
async function apply(ref: string, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>): Promise<boolean> {
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
 */
export async function takeDown(report: Report, store: Store, action: TakedownAction, origin: string): Promise<string | null> {
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
      text: [`Your store's pages and sales are switched back on, after the notice about ${addressForCreator(report)}.`, "", `Our policy: ${origin}/copyright.`].join("\n"),
      idempotencyKey: `takedown-${report.id}-restore-${Date.now()}`,
    }).catch(() => false);
    return "The store's pages and sales are back on.";
  }
  return underLock(report, store, action, (now, part, key) => finish(report, now, action, origin, part, key));
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

async function finish(report: Report, store: Store, action: Exclude<TakedownAction, { type: "store"; on: false }>, origin: string, part: string, key: string): Promise<string | null> {
  const ref = storeRef(store);
  const up = await stillUp(store, action, origin);
  let steps: Steps;
  if (up) {
    steps = { ...up, at: String(Date.now()), applied: false, noted: false, counted: false, sent: false };
    // The recovery record first, each write confirmed, so nothing is taken down without it (Codex P on #3087).
    await writeSteps(key, steps);
    // Owed from here until its notice goes out, so a page opened again can still send it (unsentNotices).
    await markOwed(report.id, part);
    if (!(await apply(ref, store, action))) {
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

/** What the creator's statement of reasons (EU DSA Art. 17(3)) says of each kind of notice: what came in, under which rule, on which ground. */
const CREATOR_NOTICE: Record<ReportKind, { received: string; relied: string; ground: string }> = {
  copyright: {
    received: "a copyright notice",
    relied: "a copyright notice under the US Digital Millennium Copyright Act (17 U.S.C. § 512(c)(3))",
    ground: "Legal ground: copyright law. The notice says the content infringes the copyright in the work it names, and we took it down for that reason.",
  },
  other: {
    received: "a notice that content on your store is illegal",
    relied: "a notice of illegal content under Article 16 of the EU Digital Services Act",
    ground: "Legal ground: the law the notice says the content breaks, for the reason it gives above. We took it down for that reason.",
  },
  child_safety: {
    received: "a report that content on your store sexually exploits a child",
    relied: "a report of child sexual exploitation, a notice of illegal content under Article 16 of the EU Digital Services Act",
    ground: "Legal ground: the law against child sexual abuse material. The report says this content sexually exploits a child, and we took it down for that reason.",
  },
  intimate_image: {
    received: "a request to remove an intimate image of a person shared without their consent",
    relied: "a request to remove an intimate image shared without consent, under the US TAKE IT DOWN Act and as a notice of illegal content under Article 16 of the EU Digital Services Act",
    ground: "Legal ground: the law against publishing intimate images without consent. The request says this is an intimate image of a person, published without their consent, and we took it down for that reason.",
  },
};

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
      `We received ${CREATOR_NOTICE[report.kind].received} about ${addressForCreator(report)} and took this down:`,
      "",
      what,
      "",
      "Where: everywhere. It is down for every visitor, in every country.",
      howLong,
      "",
      // A report about a child or an intimate image: the reporter's words are never passed on (Revisor 2 on #3587).
      report.kind === "copyright"
        ? `The notice was sent by ${report.name}, who says it uses: ${report.work.slice(0, 600)}`
        : privateReport(report.kind)
          ? "To protect the people involved, we do not pass on the words of the report."
          : `The notice says: ${report.work.slice(0, 600)}`,
      "",
      `What we relied on: that notice, sent through our form at ${origin}/report as ${CREATOR_NOTICE[report.kind].relied}.`,
      "We used no automated means to find this content or to decide: a person at Marktmorgen read the notice and made this decision.",
      CREATOR_NOTICE[report.kind].ground,
      `Our Terms do not allow content that is unlawful or that infringes someone else's rights: section 3, "Selling through a Marktmorgen store" (${origin}/terms#selling-through-a-marktmorgen-store), and section 4, "Acceptable use" (${origin}/terms#acceptable-use).`,
      "",
      report.kind === "copyright"
        ? "If you believe it was taken down by mistake, or that you have the right to use it, you can send a counter-notice by replying to this email with: your name and signature; what was taken down and where it was; a statement, under penalty of perjury, that you believe in good faith it was taken down by mistake or misidentification; your address and telephone number; and a statement that you consent to the jurisdiction of the federal court for your district (or, outside the US, any judicial district where Marktmorgen may be found) and will accept service from the person who sent the notice. We pass it to them, and put the content back in 10 to 14 business days unless they tell us they have gone to court."
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
  await writeSteps(key, { ...steps, sent: true });
  // No longer owed. If this fails the steps say it was sent, and unsentNotices reads the steps, not the set alone.
  await redisPipeline([["SREM", owedKey(report.id), part]]).catch(() => {});
  return what;
}
