/**
 * Marks the numbers put on their own chart (added 12 October 2026): the days
 * an email went to the list, a product was added and a store sale began or
 * ended, so a rise or a fall is explained without anyone having had to note
 * it down. Beside the notes a creator types (lib/stats-notes.ts).
 *
 * Read before it was built: Fathom's Chart Milestones, DataFast's notes made
 * from GitHub commits, Plausible's and Pirsch's annotations. Each mark here
 * comes from something the store itself recorded — an email's send time, a
 * product's creation, a sale's dates — so nothing on the chart is guessed.
 * Days are UTC, like every day of the numbers.
 */
import { listBroadcastsStrict } from "@/lib/broadcasts";
import { readListings } from "@/lib/catalog";
import type { Store } from "@/lib/store";

export type MarkKind = "email" | "product" | "sale";
export type AutoMark = { day: string; kind: MarkKind; text: string };

const dayOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const MAX_MARKS = 200;

type EmailLike = { subject: string; status: string; sendAt: number; finishedAt: number; sent: number };
type ProductLike = { title: string; createdAt: string; hidden?: boolean };
type SaleLike = { name: string; percent: number; starts: number; ends: number };

/** The marks from what the store recorded, between two days, oldest first. Pure. */
export function marksFrom(input: { emails: EmailLike[]; products: ProductLike[]; sales: SaleLike[]; from: string; to: string; now: number }): AutoMark[] {
  const marks: AutoMark[] = [];
  const nowSeconds = Math.floor(input.now / 1000);
  for (const email of input.emails) {
    const at = email.finishedAt || (email.status === "sent" || email.status === "sending" ? email.sendAt : 0);
    if (!at || at > nowSeconds || email.sent <= 0) continue;
    marks.push({ day: dayOf(at), kind: "email", text: `Email sent: “${email.subject.slice(0, 80)}” to ${email.sent.toLocaleString("en-US")}` });
  }
  for (const product of input.products) {
    const at = Date.parse(product.createdAt);
    if (!Number.isFinite(at) || product.hidden) continue;
    marks.push({ day: new Date(at).toISOString().slice(0, 10), kind: "product", text: `Product added: ${product.title.slice(0, 80)}` });
  }
  for (const sale of input.sales) {
    if (!(sale.percent > 0) || !sale.starts || sale.starts > nowSeconds) continue;
    const name = sale.name ? `${sale.name}, ` : "";
    marks.push({ day: dayOf(sale.starts), kind: "sale", text: `Sale began: ${name}${sale.percent}% off` });
    if (sale.ends && sale.ends <= nowSeconds) marks.push({ day: dayOf(sale.ends), kind: "sale", text: `Sale ended: ${name}${sale.percent}% off` });
  }
  return marks
    .filter((m) => m.day >= input.from && m.day <= input.to)
    .sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind))
    .slice(-MAX_MARKS);
}

/**
 * The marks for the days the chart can show, read from the store's own records: one list of emails and the catalog.
 * A read that fails rejects: marks that could not be read are unknown, never none (VR2 audit, rule 24), and the caller
 * says so.
 */
export async function readMarks(store: Store, from: string, to: string, now = Date.now()): Promise<AutoMark[]> {
  // Strict reader: a malformed list or record reply rejects instead of reading as no campaigns; a record Redis
  // answers as its own nil expired (RECORD_DAYS) and is left out, known (Codex M, #3146).
  const [emails, products] = await Promise.all([listBroadcastsStrict(store.listId, 50, { expired: "skip" }), readListings(store)]);
  return marksFrom({ emails, products, sales: [...(store.pastSales ?? []), store.sale], from, to, now });
}
