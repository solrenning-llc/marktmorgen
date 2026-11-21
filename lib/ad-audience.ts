/**
 * The store's buyers as a file the ad platforms take (added 11 October 2026):
 * Meta's customer list and TikTok's customer file both read a column of email
 * addresses named "email".
 *
 * What it is for. Two things that make ads cheaper: leaving out the people
 * who already bought, so the creator stops paying to show them the thing
 * they own; and asking the platform for more people like those who bought (a
 * lookalike audience), which is how ad platforms find buyers fastest. Cometly
 * and Polar sell sending audiences to ad platforms; here it is a file the
 * creator uploads themselves, so nothing of theirs is connected to anybody.
 *
 * Who is in it: only buyers on the creator's list who agreed to hear from the
 * creator and have not left it (lib/contacts.ts, mailable) — never somebody
 * who bought without ticking the box, unsubscribed, or whose address
 * bounced. The address and nothing else: no name, no product, no amount.
 * Using it is the creator's to answer for, as the terms say: the platforms
 * require that they have their customers' permission, and in some places
 * that means asking for it in so many words.
 */
import { type ListRead, audience, plainRead } from "@/lib/contacts";
import { csvCell } from "@/lib/csv";
import { whoOf } from "@/lib/broadcasts";
import { isRedisConfigured } from "@/lib/redis";
import type { Store } from "@/lib/store";

/**
 * The file: a header, then one address a line. The header is the bare word
 * both platforms name the column with; each address is one cell under the
 * platform's one rule for a spreadsheet cell (lib/csv.ts, csvCell): quoted,
 * with a ' in front of one that begins like a formula, so a spreadsheet
 * opening the file shows every address as text. A real address only gains
 * the quotes, which a CSV reader drops.
 */
export function audienceCsv(emails: string[]): string {
  const addresses = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))].sort();
  const rows = ["email", ...addresses.map(csvCell)];
  return `${rows.join("\r\n")}\r\n`;
}

/** The buyers' file; the list's pages read through `read` (a download's metered read, lib/list-download.ts). */
export async function buyerAudience(store: Store, read: ListRead = plainRead): Promise<{ csv: string; rows: number }> {
  if (!store.listId || !isRedisConfigured()) return { csv: audienceCsv([]), rows: 0 };
  const emails = await audience(store.listId, undefined, undefined, whoOf(store, "buyers"), undefined, undefined, read);
  const csv = audienceCsv(emails);
  return { csv, rows: csv.split("\r\n").length - 2 };
}
