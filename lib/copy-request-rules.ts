/**
 * The door to a copy of one's own data, its rules (619 [SZ3]). Pure, so the
 * page, the route and the test read the same.
 *
 * The owner's decision of 2 November 2026, 22h27 (Claude 1's inbox message
 * C3-5): a request for a copy is always answered, never refused because of a
 * store's plan or its figures. Its cost is the company's, a funded exposure
 * (lib/funded-exposure-rules.ts, "data_copy") reserved before it is spent.
 * One new copy per person per store every COPY_AGAIN_DAYS; asked again
 * within them, the copy already made is given (GDPR art. 12(5) allows
 * refusing a manifestly excessive request only with reasons, so the made one
 * is given instead). When the company's exposure cannot be reserved, the
 * request waits in a queue and is answered within the legal time (art.
 * 12(3): without undue delay and within one month), with the date shown.
 * The articles are cited from the official text read on 2 November 2026
 * (docs/official-texts-eu-2026-11-02.md).
 */
import { csvLine } from "@/lib/csv";

/** How often one network address and one email address may ask, in an hour. */
export const COPY_ASKS_PER_IP_HOUR = 10;
export const COPY_ASKS_PER_ADDRESS_HOUR = 3;
/** How long the emailed link that opens one's copies works. */
export const COPY_LINK_SECONDS = 60 * 60;
export const COPY_TOKEN = /^[0-9a-f]{64}$/;
/** The most stores one request for every store may give copies from. */
export const MAX_COPY_STORES = 60;
/** One new copy per person per store in this many days; within them, the one already made. */
export const COPY_AGAIN_DAYS = 30;
/** A made copy is kept this long, to give it again: as long as a new one is not made. */
export const COPY_KEEP_SECONDS = COPY_AGAIN_DAYS * 86_400;
/** The legal time to answer, from the day it was asked: one month, counted short at 30 days. */
export const COPY_DUE_DAYS = 30;

export type CopyFormat = "json" | "csv";
export const COPY_FORMATS: readonly CopyFormat[] = ["json", "csv"];

/** The case a copy's cost is reserved under: one store and one person, never their address. */
export function copyCase(sid: string, person: string): string {
  return `${sid}_${person}`.slice(0, 128);
}

/** The day a request asked at `askedMs` must be answered by, as an ISO day. */
export function copyDueDay(askedMs: number): string {
  return new Date(askedMs + COPY_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

type Copy = { store: { name: string; handle: string }; email: string; made: string; sections: { module: string; what: string; records: unknown[] }[]; marks: string[]; elsewhere: string[] };

/**
 * The copy as a spreadsheet: one row per record, with what it is and the
 * record itself as text a person can read, then what is held only as marks
 * and what is held elsewhere. Every cell is quoted and never a formula
 * (lib/csv.ts).
 */
export function copyCsv(copy: Copy): string {
  const rows: (string | number)[][] = [["Store", "What it is", "Record"]];
  for (const section of copy.sections) for (const record of section.records) rows.push([copy.store.name, section.what, JSON.stringify(record)]);
  for (const mark of copy.marks) rows.push([copy.store.name, "Held only as a mark", mark]);
  for (const note of copy.elsewhere) rows.push([copy.store.name, "Held elsewhere", note]);
  return rows.map(csvLine).join("\r\n") + "\r\n";
}

/** The copy as JSON, readable and the same every time for the same data. */
export function copyJson(copy: Copy): string {
  return JSON.stringify(copy, null, 2) + "\n";
}
