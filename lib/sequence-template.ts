/**
 * The file a sequence is brought in from (544 [SQ9]): its columns, its
 * largest size, the limits an email of a sequence holds, and the template the
 * studio offers for download. Pure and browser-safe: the studio checks the
 * size before sending, and the file is read on the server with the same
 * numbers (lib/sequence-import.ts).
 */
import { csvLine } from "@/lib/csv";

/** The template's columns, in order. */
export const SEQUENCE_TEMPLATE = ["order", "days_after", "subject", "preview", "body"] as const;

/** The largest file read, kept well inside what the studio's mail route takes in one request. */
export const MAX_SEQUENCE_FILE_BYTES = 150_000;

/**
 * What one email of a sequence holds, as lib/mail.ts keeps it (MAX_SUBJECT,
 * MAX_MAIL_BODY); written here so this stays pure, and held equal to those by
 * tests/sequence-import.test.ts.
 */
export const SEQUENCE_SUBJECT_MAX = 150;
export const SEQUENCE_BODY_MAX = 20_000;

/** The template as a file: its header and two example emails. */
export function sequenceTemplateCsv(): string {
  return [
    csvLine([...SEQUENCE_TEMPLATE]),
    csvLine(["1", "0", "Welcome! Here is your guide", "Everything you need to start", "Hi,\n\nThank you for joining. Your guide is on my store.\n\nTalk soon"]),
    csvLine(["2", "3", "A tip for your first week", "", "Hi again,\n\nHere is one thing that helps most people in their first week."]),
  ].join("\n");
}
