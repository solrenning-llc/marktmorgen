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
import { type Listing, productIdFromAddress, readListing } from "@/lib/catalog";
import { type ReportInput, handleIn } from "@/lib/takedown-rules";

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
 */
const noticeKey = (report: string, part: string) => reportKey(`${report}:n:${part}`);
type Steps = { what: string; howLong: string; noted: boolean; counted: boolean; sent: boolean };

async function readSteps(key: string): Promise<Steps | null> {
  const [raw] = await redisPipeline([["GET", key]]);
  if (raw === null || raw === undefined) return null;
  // A mark that cannot be read is an unknown, never "nothing owed".
  if (typeof raw !== "string") throw new Error("a takedown's steps could not be read");
  const value: unknown = JSON.parse(raw);
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!v || typeof v.what !== "string" || !v.what || typeof v.howLong !== "string" ||
      typeof v.noted !== "boolean" || typeof v.counted !== "boolean" || typeof v.sent !== "boolean") {
    throw new Error("a takedown's steps could not be read");
  }
  return { what: v.what, howLong: v.howLong, noted: v.noted, counted: v.counted, sent: v.sent };
}

async function writeSteps(key: string, steps: Steps): Promise<void> {
  await redisPipeline([["SET", key, JSON.stringify(steps), "EX", REPORT_SECONDS]]);
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
  const part = `${action.type}-${"id" in action ? action.id : ""}`;
  const key = noticeKey(report.id, part);
  const up = await stillUp(store, action, origin);
  let steps: Steps;
  if (up) {
    steps = { ...up, noted: false, counted: false, sent: false };
    await writeSteps(key, steps);
    if (!(await apply(ref, store, action))) {
      await redisPipeline([["DEL", key]]).catch(() => {});
      return null;
    }
  } else {
    // Down already: only a takedown of this notice whose steps are not all done is left to finish.
    const kept = await readSteps(key);
    if (!kept || kept.sent) return null;
    steps = kept;
  }
  const { what, howLong } = steps;
  if (!steps.noted) {
    if (!(await noteTakedown(ref, { at: new Date().toISOString(), what, report: report.id }))) throw new Error("the store could not be written");
    steps = { ...steps, noted: true };
    await writeSteps(key, steps);
  }
  if (!steps.counted) {
    await countStep(report, action.type);
    steps = { ...steps, counted: true };
    await writeSteps(key, steps);
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
        ? "If you believe it was taken down by mistake, or that you have the right to use it, you can send a counter-notice by replying to this email with: your name and signature; what was taken down and where it was; a statement, under penalty of perjury, that you believe in good faith it was taken down by mistake or misidentification; your address and telephone number; and a statement that you consent to the jurisdiction of the federal court for your district (or, outside the US, any judicial district where Marktmorgen may be found) and will accept service from the person who sent the notice. We pass it to them, and put the content back in 10 to 14 business days unless they tell us they have gone to court."
        : "If you believe this was a mistake, reply to this email and say why; we look at it again and tell you what we decided.",
      `You can also take our decision to a court. Section 16 of our Terms, "Governing law", says which law and courts apply (${origin}/terms#governing-law).`,
      "",
      `Our policy: ${origin}/copyright. Stores that are the subject of repeated valid notices are switched off.`,
    ].join("\n"),
    // The same key on every try, so a notice the provider took is never sent twice.
    idempotencyKey: `takedown-${report.id}-${part}`,
  }).catch(() => false);
  if (!sent) throw new TakedownNoticeUnsent();
  await writeSteps(key, { ...steps, sent: true });
  return what;
}
