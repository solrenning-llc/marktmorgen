/**
 * The affiliate spreadsheet's figures and words (app/api/store/affiliates/export; #5010 row 150), kept apart from
 * lib/affiliate-book-export.ts so the studio's page shows them without importing what reads the book.
 */
import { ENDED_BOOK_EXPORTS } from "@/lib/plan-closing-rules";

/**
 * How many tries a month may read the whole book and still not make the file (#5256 audit, coordinator ea4f 2): a
 * record that cannot be read fails every time, after the reading, so each try would spend that reading again. A try
 * takes one of these before it reads and gives it back once the file is made; with none left, the spreadsheet is
 * refused before anything is read. Only while a plan runs: its reading is counted from the studio figure, so this
 * adds no cost of its own and bounds how often that figure is spent on nothing. Once the plan has ended, a failed try
 * is one of the ENDED_BOOK_EXPORTS downloads, which bound it already.
 */
export const BOOK_FAILED_TRIES: number = 1;

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** How long one store's spreadsheet holds its turn (a second click waits for the first; focal 3634, 1). */
export const BOOK_BUSY_SECONDS = 120;

/** Said to a second click while the first is being made: nothing was counted. */
export const BOOK_BUSY_WORDS = "Your affiliate spreadsheet is already being made. It downloads in a moment. Nothing more was counted.";

/** Beside the button while a plan runs: what the download takes, and what a failure counts, before the click. */
export const BOOK_EXPORT_NOTE = "The file is counted from your studio's requests by its size. If it can't be made after your records were read, that reading still counts.";

/** Beside the button once the plan has ended (shown only to the store's owner, the only one who can download it then). */
export const BOOK_EXPORT_ENDED_NOTE = `Since your plan ended, you can download this file ${times(ENDED_BOOK_EXPORTS)} in all. A try that read your records counts, even if the file could not be made.`;

/**
 * Said when a try that read the book could not make the file: what it counted and, while a plan runs, that it is not
 * read again in this `span` ("this month" or "in this trial"; null once the plan has ended).
 */
export function bookFailedWords(ended: boolean, span: string | null): string {
  const counted = ended
    ? `This try counted as one of the ${ENDED_BOOK_EXPORTS} downloads your store keeps after its plan ended, because the book was read.`
    : "Reading the book was counted from your studio's requests.";
  const again = span ? ` It is not read again ${span}, so a record we cannot read does not use them up.` : "";
  return `We could not make your affiliate spreadsheet. ${counted}${again} Your records are unchanged. Write to us and we will look at it.`;
}

/** Said when the book was read and a passing failure on our side stopped the file: what counted, and to try again. */
export function bookPassingWords(ended: boolean): string {
  const counted = ended
    ? `It counted as one of the ${ENDED_BOOK_EXPORTS} downloads your store keeps after its plan ended, because your records were read.`
    : "Reading your records was counted from your studio's requests.";
  return `Something went wrong on our side while your affiliate spreadsheet was being made. ${counted} Try again in a moment.`;
}

/** Said when the failed tries are used: nothing was read or counted. `reset` says when it opens again, if it does. */
export function bookFailedUsedWords(span: string, reset: string): string {
  return `Your affiliate spreadsheet could not be made earlier ${span}, so the book is not read again ${span}. Nothing was read or counted now.${reset ? ` ${reset}` : ""}`;
}
