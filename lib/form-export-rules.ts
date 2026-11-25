/**
 * What a form's answers as a file (app/api/store/forms/export) reads, at its
 * most, held before any answer is read (#5010 row 145; measured in
 * tests/forms-export-held.test.ts). Nothing imported, so the route's tests
 * can stand in for the form store without these.
 */

/**
 * Its commands past the request: the size (its EVAL and the LRANGE inside it, billed one by one as Upstash bills a
 * script's inner commands; Claude 6 UoHAG's LOW on #5268), then the responses and their count in one pipeline.
 */
export const FORM_EXPORT_COMMANDS = 4;
/** The most bytes of the database's answer for each byte kept: a character escaped as \u0000 is six. */
export const FORM_EXPORT_WIDEST = 6;
/** Around each response in the answer (its quotes and comma) and around the answer itself and its count. */
export const FORM_EXPORT_FRAME_BYTES = 3;
export const FORM_EXPORT_ANSWER_BYTES = 64;

/** The bytes reading `count` responses of `bytes` bytes in all can move, at their widest. */
export function formExportReadMost(size: { count: number; bytes: number }): number {
  return size.bytes * FORM_EXPORT_WIDEST + size.count * FORM_EXPORT_FRAME_BYTES + FORM_EXPORT_ANSWER_BYTES;
}

/**
 * What the studio's invoices page says of it, beside the essential requests a download of the store's data takes
 * (Claude 5 icEJ on #5268): a form's answers as a file also takes studio requests by its size.
 */
export const FORM_FILE_WORDS = "Downloading a form's answers as a file also takes your studio's monthly requests by its size, about one for each megabyte it reads and sends, so a large file is counted there too.";
