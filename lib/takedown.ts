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
  // The public transparency page counts it (624 [SZ8](47)); nothing about who sent it or which store.
  await countNotice(report.kind);
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
 * Takes one piece of content down, or switches the store off or back on,
 * writes it on the store's record and tells the creator. Returns what was
 * done, in words, or null when there was nothing to do it to.
 */
export async function takeDown(report: Report, store: Store, action: TakedownAction, origin: string): Promise<string | null> {
  const ref = storeRef(store);
  let what = "";
  if (action.type === "link") {
    const link = store.links.find((l) => l.id === action.id && !l.header);
    if (!link) return null;
    const done = await removeStoreLink(ref, link.id);
    if (!done.ok) return null;
    if (done.removed) await del(done.removed.path).catch(() => {});
    what = `The link "${link.title}" (${link.url})`;
  } else if (action.type === "product") {
    // Read by id, however far down the store's list it is (lib/catalog.ts).
    const product = await readListing(store, action.id).catch(() => null);
    if (!product || product.hidden) return null;
    const done = await setProductHidden(ref, product.id, true);
    if (!done.ok) return null;
    what = `The product "${product.title}", now unpublished`;
  } else if (action.type === "kit") {
    if (!store.kit.on) return null;
    await setKit(ref, { ...store.kit, on: false });
    what = "Your media kit, now unpublished";
  } else {
    if (Boolean(store.suspended) === action.on) return null;
    await noteTakedown(ref, null, action.on);
    if (!action.on) {
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
    what = "Your store's pages and sales, now switched off";
  }
  await noteTakedown(ref, { at: new Date().toISOString(), what, report: report.id });
  await countStep(report, action.type);
  await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: store.email,
    replyTo: SUPPORT_EMAIL,
    subject: `Content taken down from your store @${store.handle}`,
    text: [
      `We received a ${report.kind === "copyright" ? "copyright notice" : "notice that content on your store is illegal"} about ${report.url} and took this down:`,
      "",
      what,
      "",
      report.kind === "copyright" ? `The notice was sent by ${report.name}, who says it uses: ${report.work.slice(0, 600)}` : `The notice says: ${report.work.slice(0, 600)}`,
      "",
      report.kind === "copyright"
        ? "If you believe it was taken down by mistake, or that you have the right to use it, you can send a counter-notice by replying to this email with: your name and signature; what was taken down and where it was; a statement, under penalty of perjury, that you believe in good faith it was taken down by mistake or misidentification; your address and telephone number; and a statement that you consent to the jurisdiction of the federal court for your district (or, outside the US, any judicial district where Marktmorgen may be found) and will accept service from the person who sent the notice. We pass it to them, and put the content back in 10 to 14 business days unless they tell us they have gone to court."
        : "If you believe this was a mistake, reply to this email and say why; we look at it again and tell you what we decided.",
      "",
      `Our policy: ${origin}/copyright. Stores that are the subject of repeated valid notices are switched off.`,
    ].join("\n"),
    idempotencyKey: `takedown-${report.id}-${action.type}-${"id" in action ? action.id : ""}`,
  }).catch(() => false);
  return what;
}
