/**
 * Who may read a published email kept for members (lib/letter-rules.ts,
 * membersOnly; queue items 28 [E11] and 100 [E2-MEMBER-PUBLICATIONS], added
 * 4 November 2026), asked again on every page.
 *
 * The answer is the one a community's door gives (lib/community-access.ts,
 * holdsProductsOrThrow): the address holds one of the email's products now, read
 * from the creator's Stripe account and the store's own records, never from
 * anything a visitor says: paid and not refunded in full (a dispute lost
 * counts as refunded), a membership still running, given for free, brought
 * over from another platform, or given as a gift. A refund, a lost dispute
 * or a membership that stops closes the email within the minutes the answer
 * is kept. When Stripe cannot be asked, the answer is unknown, said as such,
 * and never kept.
 *
 * The address has to be proved, as a community's is (lib/learn.ts,
 * learnerFrom with the store's pass for every course): a link emailed to it,
 * or a Marktmorgen sign-in with it. A pass made at checkout for one course
 * only is not enough. The creator always reads their own.
 *
 *   nl:letters:ok:<sid>:<products>:<address>   whether the address holds one of the products, for minutes
 *   nl:letters:link:<hash>                     an emailed link: who, which store, which email (1 hour)
 *   nl:letters:link:<hash>:opens               how often it was used (at most 10)
 *   nl:letters:rl:ip:<hash>, nl:letters:rl:addr:<hash>   how often a link was asked for (an hour)
 *
 * What it costs: the page and the form are each one of the store's public
 * requests (lib/buyer-actions.ts takeBuyerRead), the answer is one cached
 * read, and the link is one of the store's access emails, counted and
 * refused past its allowance by the email meter before it is sent. The form
 * answers before any of that is done (requestLetterLink).
 */
import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail, serviceMailKnownUnavailable } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { holdsProductsOrThrow } from "@/lib/community-access";
import { MAX_MOVED_INTO, readMovedIndex } from "@/lib/purchase-move-index";
import { takePublicRequest } from "@/lib/traffic";
import { TOKEN_PATTERN, learnerFrom, storeKey } from "@/lib/learn";
import { LETTER_ID, type Letter, membersOnly } from "@/lib/letter-rules";
import { letterWords } from "@/lib/buyer-words/letters";
import type { Store } from "@/lib/store";

export const LETTER_LINK_SECONDS = 60 * 60;
const MAX_LINK_OPENS = 10;
const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const addressKey = (email: string) => sha(`nimbus-letter-reader:${normaliseEmail(email)}`).slice(0, 32);
/** One answer per address and set of products, so emails kept for the same products share it. */
const okKey = (sid: string, products: string[], email: string) =>
  `nl:letters:ok:${sid}:${sha([...products].sort().join(",")).slice(0, 16)}:${addressKey(email)}`;
const linkKey = (token: string) => `nl:letters:link:${sha(`nimbus-letter:${token}`).slice(0, 40)}`;
const opensKey = (token: string) => `${linkKey(token)}:opens`;

type CookieJar = { get(name: string): { value: string } | undefined };

export type LetterReader =
  /** Everyone may read it. */
  | { state: "public" }
  /** The creator, reading their own. */
  | { state: "owner" }
  /** A proved address that holds one of its products. */
  | { state: "in"; email: string }
  /** Nobody we know: the page asks for an address. */
  | { state: "out" }
  /** A proved address that holds none of them. */
  | { state: "closed"; email: string }
  /**
   * A proved address, but the creator's Stripe account could not be asked
   * (it failed, or did not answer): nobody is let in on a guess, and nobody
   * is told they hold nothing on one either. The page asks them to reload.
   */
  | { state: "unknown"; email: string };

/**
 * Whether this address holds one of the email's products now (cached for
 * minutes). Throws when it cannot be known (Stripe or the database could not
 * be asked), so a failed ask is never read as "holds none of them".
 *
 * A buyer may have moved their purchases at this store to another address
 * (611 [WP10]; lib/purchase-move-index.ts). An address that moved away holds
 * nothing here any more; an address that purchases moved to holds what each
 * of its old addresses (at most MAX_MOVED_INTO) holds, each asked as the
 * address itself is, after one more of the store's public requests is taken
 * for it. When the index cannot be read, the answer is unknown for either
 * address: never restored access or a definite denial from missing evidence.
 */
export async function holdsLetter(store: Store, letter: Letter, email: string): Promise<boolean> {
  if (!membersOnly(letter) || !store.sid) return false;
  const products = letter.products!;
  const sid = store.sid;
  const holds = (address: string) => holdsProductsOrThrow(store, products, address, okKey(sid, products, address), "1");
  // Unknown move evidence must reach both callers' existing unknown/retry
  // handling; falling back would restore access to the abandoned address.
  const moved = await readMovedIndex(sid, email);
  if (moved.movedTo) return false;
  if (moved.movedFrom.length > MAX_MOVED_INTO) throw new UnknownReplyError("too many moved addresses to read completely");
  if (await holds(email)) return true;
  const olds = moved.movedFrom;
  if (!olds.length) return false;
  // Each old address is one more reading, paid before it is made: no room is unknown, never "holds none".
  if (!(await takePublicRequest(store, "buyer", Date.now(), olds.length))) throw new UnknownReplyError("the store's room to read moved purchases");
  for (const old of olds) if (await holds(old)) return true;
  return false;
}

/** Who is looking at this email, and whether they may read its words, asked afresh. */
export async function letterReader(store: Store, letter: Letter, cookies: CookieJar): Promise<LetterReader> {
  if (!membersOnly(letter)) return { state: "public" };
  const learner = await learnerFrom(store, cookies).catch(() => null);
  if (learner?.owner) return { state: "owner" };
  if (!learner || learner.scope !== "all") return { state: "out" };
  let holds: boolean;
  try {
    holds = await holdsLetter(store, letter, learner.email);
  } catch (error) {
    console.error("checking who may read an email kept for members failed", error);
    return { state: "unknown", email: learner.email };
  }
  return holds ? { state: "in", email: learner.email } : { state: "closed", email: learner.email };
}

/**
 * Counts one more under `key`, for LETTER_LINK_SECONDS from the first: the
 * key is made with its end (SET NX EX, the pattern every counter here uses),
 * then counted. A key that ran out between those two commands would be made
 * again by INCR with no end; its TTL, read in the same round, says so (-1),
 * and only then is it given one, so a counting key never stays without an
 * end and a running window is never pushed back.
 *
 * The round is read only in its exact shape (CX-123 rule 24): three
 * replies, the SET's "OK" or null, a whole count from one up and a whole
 * TTL. Anything else is not a count under the limit: it throws
 * UnknownReplyError, so the form says the email could not be sent (the
 * route's "error") and an emailed link opens nothing, and nothing after the
 * count is done. A TTL of another shape leaves the key as it is: whether it
 * has an end is not known, and giving it one could push a running window
 * back.
 */
async function count(key: string): Promise<number> {
  const replies = repliesFor(await redisPipeline([
    ["SET", key, "0", "EX", LETTER_LINK_SECONDS, "NX"],
    ["INCR", key],
    ["TTL", key],
  ]), 3);
  const counted = replies && (replies[0] === "OK" || replies[0] === null) ? countOf(replies[1]) : null;
  const ttl = replies?.[2];
  if (counted === null || counted < 1 || typeof ttl !== "number" || !Number.isSafeInteger(ttl)) throw new UnknownReplyError("a count of links asked for or opened");
  if (ttl === -1) await redisPipeline([["EXPIRE", key, LETTER_LINK_SECONDS]]);
  return counted;
}

async function within(key: string, limit: number): Promise<boolean> {
  return (await count(key)) <= limit;
}

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

export type LetterLinkRequest = "sent" | "email" | "limited" | "error";
export type LetterGrant = { e: string; k: string; h: string; l: string };

/**
 * Emails a way to read the email, when the address holds one of its
 * products. "sent" either way, and at once, right after the limits, for an
 * address that holds one and one that does not: whether it holds one is
 * asked, and its link made and emailed, only after the answer is sent
 * (afterAnswer), so neither the answer's words nor its time tell them apart,
 * and the form cannot be used to find out who bought what or to fill a
 * stranger's inbox. What fails after the answer is said only in the
 * server's log; email known not to go out is said, as "error", to everyone.
 */
export async function requestLetterLink(input: { store: Store; letter: Letter; email: string; ip: string; origin: string }): Promise<LetterLinkRequest> {
  const { store, letter, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!membersOnly(letter) || !store.sid || !isRedisConfigured()) return "error";
  if (!(await within(`nl:letters:rl:ip:${sha(`${ip}|${store.handle}`).slice(0, 32)}`, IP_LIMIT))) return "limited";
  if (!(await within(`nl:letters:rl:addr:${addressKey(raw)}`, ADDRESS_LIMIT))) return "limited";
  // Email that is known not to go out (lib/email.ts, the course link's same
  // check): "error" for everyone, before anything is asked, so it never says
  // a link is on its way and never tells a holder from anyone else.
  if (serviceMailKnownUnavailable()) return "error";
  afterAnswer(() => sendLetterLink(store, letter, raw, origin));
  return "sent";
}

/**
 * The link itself, for an address that holds one of the email's products; nothing for one that does not, or when
 * that cannot be known (logged). The grant's SET is read only in its exact shape (CX-123 rule 24): one reply,
 * "OK". Any other means the link may open nothing, so no email is sent and none of the store's transactional
 * allowance is taken (the meter is taken inside sendEmail); it is said in the server's log, and asking again makes
 * a new link.
 */
async function sendLetterLink(store: Store, letter: Letter, raw: string, origin: string): Promise<void> {
  if (!(await holdsLetter(store, letter, raw))) return;
  const token = randomBytes(32).toString("hex");
  const grant: LetterGrant = { e: normaliseEmail(raw), k: storeKey(store), h: store.handle, l: letter.id };
  const kept = repliesFor(await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LETTER_LINK_SECONDS]]), 1);
  if (kept?.[0] !== "OK") {
    console.error("a link to read an email kept for members was not sent: its grant was not confirmed kept", new UnknownReplyError("an emailed link's grant"));
    return;
  }
  const link = `${origin}/api/store/letters/open?token=${token}`;
  const w = letterWords(store.language);
  const sent = await sendEmail({
    meter: { by: "store", store, kind: "transactional" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: normaliseEmail(raw),
    subject: w.linkSubject(letter.subject).slice(0, 200),
    text: w.linkBody(letter.subject, link, store.name),
  });
  if (!sent) console.error("a link to read an email kept for members was not sent");
}

/**
 * Runs a link's question, grant and email after the answer is sent, inside
 * the route's own time; at once, unwaited, when there is no request to wait
 * for.
 */
function afterAnswer(task: () => Promise<void>): void {
  const run = () =>
    task().catch((error) => {
      console.error("sending a link to read an email failed", error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Who and which email an emailed link is for, read only: nothing is written
 * for a token that is not one, so the route counts its public request
 * (takeBuyerRead) for the store the link names before anything is spent.
 */
export async function readLetterGrant(token: string): Promise<LetterGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const grant = JSON.parse(raw) as LetterGrant;
    return typeof grant.e === "string" && typeof grant.k === "string" && typeof grant.h === "string" && typeof grant.l === "string" && LETTER_ID.test(grant.l) ? grant : null;
  } catch {
    return null;
  }
}

/** Spends one open of a link already read; false past MAX_LINK_OPENS; throws UnknownReplyError when the count could not be read. */
export async function spendLetterOpen(token: string): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return false;
  return (await count(opensKey(token))) <= MAX_LINK_OPENS;
}
