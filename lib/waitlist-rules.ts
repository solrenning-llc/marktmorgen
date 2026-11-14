/**
 * A waitlist on a product that is not on sale yet, as rules the browser can
 * read too. The part that keeps it is lib/waitlist.ts.
 *
 * Measured before it was built (30 September 2026): Stan has no waitlist —
 * its "Product coming soon!" notice only means the store has no way to pay
 * connected (help.stan.store, article 367). Whop's waitlist takes addresses
 * and answers to questions and admits people one by one, and says nothing of
 * an email when the product comes out (docs.whop.com, "Create a waitlist").
 *
 * How it works here:
 *
 *   - The creator marks a paid product "coming soon". Its card and its page
 *     show a waitlist form instead of a buy button, and no checkout opens.
 *   - A visitor types their address. It counts only once they press the
 *     button in the email it gets, so nobody is put on a waitlist by someone
 *     else, and the box to hear from the creator beyond it starts empty.
 *   - The creator presses "Put it on sale and tell the waitlist". The product
 *     goes on sale that moment, and everyone who confirmed gets one email
 *     with its link, its price and, if the creator wrote one, a short note.
 *     That email is the only one the waitlist sends; afterward the addresses
 *     are deleted, except where their owner also asked to hear from the
 *     creator, in which case they are on the creator's list.
 */
import { givingWords } from "@/lib/buyer-words/giving";

/** People one product's waitlist can hold. */
export const MAX_WAITLIST = 10_000;
/** The longest note the creator adds to the launch email. */
export const MAX_LAUNCH_NOTE = 600;
/** The longest postal address at the bottom of the launch email. */
export const MAX_LAUNCH_ADDRESS = 200;
/** How long the link to confirm a spot works. */
export const CONFIRM_SECONDS = 7 * 86_400;
/** How long a confirmed address may wait for the launch before it is let go. */
export const WAIT_SECONDS = 365 * 86_400;
/** Emails in one request to the sender, and one piece of the five-minute job's work. */
export const LAUNCH_BATCH = 100;
/**
 * How long a launch may wait, from its start, while its store is switched off
 * after notices (lib/waitlist.ts runLaunches): each held run keeps its record
 * and send list alive, and past this the launch stops, keeping whoever was not
 * emailed yet on the waitlist so it can be started again.
 */
export const LAUNCH_HOLD_SECONDS = 120 * 86_400;

export type WaitEntry = {
  /** When they typed their address, in seconds. */
  at: number;
  /** When they pressed the button in the email; 0 until then. */
  ok: number;
  /** They also asked to hear from the creator. */
  c: boolean;
  /** And allowed their link use in sequences to be seen (lib/mail-clicks.ts); only with `c`. */
  k?: boolean;
  /** The token behind their link to leave. */
  t: string;
};

export function parseEntry(raw: unknown): WaitEntry | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.t !== "string") return null;
    return { at: Number(v.at) || 0, ok: Number(v.ok) || 0, c: v.c === true, ...(v.c === true && v.k === true ? { k: true } : {}), t: v.t };
  } catch {
    return null;
  }
}

export type LaunchJob = {
  handle: string;
  note: string;
  address: string;
  /** Confirmed addresses when it started, sorted, so batches never shift. */
  total: number;
  /** How many of them have been handled. */
  cursor: number;
  sent: number;
  started: number;
  finished: number;
  /** When it stopped unfinished because its store stayed switched off (LAUNCH_HOLD_SECONDS); 0 otherwise. */
  stopped: number;
};

export function parseJob(raw: unknown): LaunchJob | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<LaunchJob>;
    if (typeof v.handle !== "string") return null;
    return {
      handle: v.handle,
      note: typeof v.note === "string" ? v.note : "",
      address: typeof v.address === "string" ? v.address : "",
      total: Number(v.total) || 0,
      cursor: Number(v.cursor) || 0,
      sent: Number(v.sent) || 0,
      started: Number(v.started) || 0,
      finished: Number(v.finished) || 0,
      stopped: Number(v.stopped) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * The launch email's own words, before the bottom of every email carries, in
 * the store's language (lib/buyer-words/giving.ts); English when none is
 * given. `price` is already written the store's way.
 */
export function launchBody(
  input: { storeName: string; title: string; price: string; link: string; note: string },
  language: unknown = "en",
): { subject: string; body: string } {
  const g = givingWords(language);
  const lines = [g.launchLead(input.storeName, input.title, input.price), "", input.link];
  if (input.note.trim()) lines.push("", input.note.trim());
  return { subject: g.launchSubject(input.title).slice(0, 150), body: lines.join("\n") };
}
