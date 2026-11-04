/**
 * Who may read a published email kept for members (lib/letter-rules.ts,
 * membersOnly; queue items 28 [E11] and 100 [E2-MEMBER-PUBLICATIONS], added
 * 4 November 2026), asked again on every page.
 *
 * The answer is the one a community's door gives (lib/community-access.ts,
 * holdsProducts): the address holds one of the email's products now, read
 * from the creator's Stripe account and the store's own records, never from
 * anything a visitor says: paid and not refunded in full (a dispute lost
 * counts as refunded), a membership still running, given for free, brought
 * over from another platform, or given as a gift. A refund, a lost dispute
 * or a membership that stops closes the email within the minutes the answer
 * is kept.
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
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { holdsProducts } from "@/lib/community-access";
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
  | { state: "closed"; email: string };

/** Whether this address holds one of the email's products now (cached for minutes). */
export async function holdsLetter(store: Store, letter: Letter, email: string): Promise<boolean> {
  if (!membersOnly(letter) || !store.sid) return false;
  const products = letter.products!;
  return holdsProducts(store, products, email, okKey(store.sid, products, email), "1");
}

/** Who is looking at this email, and whether they may read its words, asked afresh. */
export async function letterReader(store: Store, letter: Letter, cookies: CookieJar): Promise<LetterReader> {
  if (!membersOnly(letter)) return { state: "public" };
  const learner = await learnerFrom(store, cookies).catch(() => null);
  if (learner?.owner) return { state: "owner" };
  if (!learner || learner.scope !== "all") return { state: "out" };
  return (await holdsLetter(store, letter, learner.email)) ? { state: "in", email: learner.email } : { state: "closed", email: learner.email };
}

/**
 * Counts one more under `key` for LETTER_LINK_SECONDS from its first. The
 * count and its end are set together, the end only when the key has none, so
 * a key that ran out between two commands is never left without one.
 */
async function within(key: string, limit: number): Promise<boolean> {
  const [count] = await redisPipeline([
    ["INCR", key],
    ["EXPIRE", key, LETTER_LINK_SECONDS, "NX"],
  ]);
  return Number(count) <= limit;
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
 * server's log.
 */
export async function requestLetterLink(input: { store: Store; letter: Letter; email: string; ip: string; origin: string }): Promise<LetterLinkRequest> {
  const { store, letter, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!membersOnly(letter) || !store.sid || !isRedisConfigured()) return "error";
  if (!(await within(`nl:letters:rl:ip:${sha(`${ip}|${store.handle}`).slice(0, 32)}`, IP_LIMIT))) return "limited";
  if (!(await within(`nl:letters:rl:addr:${addressKey(raw)}`, ADDRESS_LIMIT))) return "limited";
  afterAnswer(() => sendLetterLink(store, letter, raw, origin));
  return "sent";
}

/** The link itself, for an address that holds one of the email's products; nothing for one that does not. */
async function sendLetterLink(store: Store, letter: Letter, raw: string, origin: string): Promise<void> {
  if (!(await holdsLetter(store, letter, raw))) return;
  const token = randomBytes(32).toString("hex");
  const grant: LetterGrant = { e: normaliseEmail(raw), k: storeKey(store), h: store.handle, l: letter.id };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LETTER_LINK_SECONDS]]);
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

/** Spends one open of an emailed link, and says who and which email it was for. */
export async function openLetterLink(token: string): Promise<LetterGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw, opens] = await redisPipeline([
    ["GET", linkKey(token)],
    ["INCR", opensKey(token)],
    ["EXPIRE", opensKey(token), LETTER_LINK_SECONDS, "NX"],
  ]);
  if (typeof raw !== "string" || Number(opens) > MAX_LINK_OPENS) return null;
  try {
    const grant = JSON.parse(raw) as LetterGrant;
    return typeof grant.e === "string" && typeof grant.k === "string" && typeof grant.h === "string" && typeof grant.l === "string" && LETTER_ID.test(grant.l) ? grant : null;
  } catch {
    return null;
  }
}
