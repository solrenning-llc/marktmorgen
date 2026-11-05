/**
 * Giving something away for an email address, and the list that builds.
 *
 * The flow is the one every creator store has, with two differences that are
 * the point of doing it here:
 *
 *   1. The copy is sent to the address typed, and the address joins the list
 *      only when the link in that email is used. So every address on the list
 *      is one somebody really holds — no typos, no strangers signed up by a
 *      prankster — and a creator who later writes to the list is not writing
 *      into a void that hurts their sender reputation.
 *   2. Asking for the file and agreeing to hear from the creator are two
 *      different things, and the list keeps them apart. The box is never
 *      ticked for the visitor, and the export says, address by address, who
 *      ticked it.
 *
 * Records in Redis, every key hashed so no raw token or address rests in a
 * key name:
 *
 *   nl:free:claim:<hash>          -> who asked for what, 7 days
 *   nl:free:uses:<hash>           -> how often that link was used, 7 days
 *   nl:store:leads:<listId>       -> the list: address -> what we know
 *   nl:store:leads:<listId>:agreed -> how many on it ticked the box
 *
 * The list is keyed by the store's own list id, not by the sign-in address,
 * so moving the account to another address takes the list along untouched.
 */
import { admitOrders, settleAdmitted } from "@/lib/order-admission";
import { allValues, readFields } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { countOrder, storeOrdersThisMonth } from "@/lib/orders";
import { freeCopiesLimitFor } from "@/lib/order-rules";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isPaidUp } from "@/lib/billing";
import { csvCell } from "@/lib/csv";
import { type Listing, type Store, isFree } from "@/lib/store";
import { givingWords } from "@/lib/buyer-words/giving";
import {
  type AddResult,
  MAX_LEADS,
  leadsKey,
  listCounts,
  mailable,
  parseContact,
  upsertContact,
  orderRoom,
} from "@/lib/contacts";
import { noteForErasure } from "@/lib/erasure-index";

export { MAX_LEADS };

/** How long the emailed link keeps working. */
export const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many times one emailed link may be used.
 *
 * Enough for a download that fails halfway, a second device and a change of
 * mind. Not enough for a link pasted into a forum to become a public mirror
 * whose every download is counted against the creator's month.
 */
export const MAX_CLAIM_USES = 10;

/** Requests from one connection to one store, per hour. */
const IP_LIMIT = 20;
/**
 * Requests for one inbox, per hour, across every store.
 *
 * This is the one that matters: it is what stops anyone from using this form
 * to bury somebody else's inbox in emails they did not ask for.
 */
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const claimKey = async (token: string) =>
  `nl:free:claim:${(await sha256Hex(`nimbus-free-claim:${token}`)).slice(0, 40)}`;
const usesKey = async (token: string) =>
  `nl:free:uses:${(await sha256Hex(`nimbus-free-uses:${token}`)).slice(0, 40)}`;
const ipKey = async (ip: string, handle: string) =>
  `nl:rl:free:ip:${(await sha256Hex(`nimbus-free-ip:${ip}:${handle}`)).slice(0, 32)}`;
const addressKey = async (email: string) =>
  `nl:rl:free:addr:${(await sha256Hex(`nimbus-free-addr:${email}`)).slice(0, 32)}`;

/**
 * Whether a product can be given away from this store right now.
 *
 * Free is not the same as outside the subscription: handing files out costs
 * delivery, and the email that carries each one costs a send. So a free
 * product needs what a paid one needs from the creator — a subscription in
 * good standing, the trial included — and something behind it to hand over.
 * It does not need a Stripe account, because no money moves.
 */
export function canGiveProduct(store: Store, product: Listing): boolean {
  return (
    isFree(product) &&
    // A draft is not given away until it is published.
    !product.hidden &&
    product.recurring === null &&
    product.options.length === 0 &&
    (product.file !== null || product.link !== null) &&
    store.listId !== null &&
    isPaidUp(store) &&
    isRedisConfigured() &&
    isSenderConfigured()
  );
}

/** A name that can sit inside the quotes of an email's From line. */
function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

/** The address part of NIMBUS_FROM, whatever form it was written in. */
function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

async function within(key: string, limit: number): Promise<boolean> {
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= limit;
}

export type RequestResult = "sent" | "email" | "limited" | "unavailable" | "error";

export type Claim = {
  /** The store's address when the copy was asked for. */
  h: string;
  /** The product. */
  p: string;
  /** The address the copy was sent to. */
  e: string;
  /** Whether the box was ticked. */
  c: boolean;
  /** Whether the second box was ticked too, allowing their link use to be seen (lib/mail-clicks.ts). */
  k?: boolean;
  /** When it was asked for. */
  at: string;
  /** The affiliate the visit was credited to, where the store pays per free product claimed (lib/affiliate-leads.ts). */
  a?: string;
};

/**
 * Sends a free copy to the address typed.
 *
 * Nothing is added to the creator's list here. The address is only on its
 * way to being checked, and it joins the list when the link in the email is
 * used — which is the proof that whoever typed it holds that inbox.
 */
export async function requestCopy(input: {
  store: Store;
  product: Listing;
  email: string;
  consent: boolean;
  /** The second box, allowing their link use in sequences to be seen; only with the first. */
  clicks?: boolean;
  ip: string;
  origin: string;
  /** The affiliate a claim would be credited to once the link is used (lib/affiliate-leads.ts leadAffiliate). */
  lead?: string | null;
}): Promise<RequestResult> {
  const { store, product, consent, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) {
    return "email";
  }
  const email = normaliseEmail(raw);
  if (!canGiveProduct(store, product)) return "unavailable";

  if (!(await within(await ipKey(ip, store.handle), IP_LIMIT))) return "limited";
  if (!(await within(await addressKey(email), ADDRESS_LIMIT))) return "limited";
  // Free copies stop at what the month allows (lib/order-rules.ts): a trial's
  // figure in a free trial, nothing without a plan, and for a store that pays
  // its plan's figure, admitted with its paid orders (lib/order-admission.ts).
  const cap = freeCopiesLimitFor(store);
  if ((await storeOrdersThisMonth(store)) >= cap) return "unavailable";
  const admitted = await admitOrders(store, 1);
  if (!admitted.ok) return "unavailable";

  const token = randomToken();
  const claim: Claim = {
    h: store.handle,
    p: product.id,
    e: email,
    c: consent,
    ...(consent && input.clicks ? { k: true } : {}),
    at: new Date().toISOString(),
    ...(input.lead && /^[0-9a-f]{12}$/.test(input.lead) ? { a: input.lead } : {}),
  };
  const claimed = await claimKey(token);
  await redisPipeline([["SET", claimed, JSON.stringify(claim), "EX", CLAIM_TTL_SECONDS], ...noteForErasure(store.statsId, email, claimed)]);

  const name = store.name;
  const g = givingWords(store.language);
  const link = `${origin}/@${store.handle}/free?token=${token}`;
  const sent = await sendEmail({ meter: { by: "order" },
    from: `"${displayName(name)} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject: g.freeSubject(product.title),
    text: [
      g.freeAsked(name, product.title),
      "",
      link,
      "",
      g.freeOpen,
      "",
      consent ? g.freeConsented(name) : g.freeNotConsented(name),
      "",
      g.freeIgnore,
      "",
      g.freeSentBy(name),
    ].join("\n"),
  });
  // One of the month's orders (lib/orders.ts): nothing was paid, so it always counts.
  if (sent) await countOrder(store, `free:${token}`, 0);
  await settleAdmitted(store, admitted.hour);
  return sent ? "sent" : "error";
}

/** What an emailed link names, without spending anything. For the page. */
export async function readClaim(
  token: string,
): Promise<{ handle: string; productId: string } | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", await claimKey(token)]]);
  const claim = parseClaim(raw);
  return claim ? { handle: claim.h, productId: claim.p } : null;
}

/** The whole of what an emailed link names, address included, without spending anything. */
export async function readClaimFull(token: string): Promise<Claim | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", await claimKey(token)]]);
  return parseClaim(raw);
}

function parseClaim(raw: unknown): Claim | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Claim>;
    if (typeof value.h !== "string" || typeof value.p !== "string") return null;
    if (typeof value.e !== "string" || !EMAIL_PATTERN.test(value.e)) return null;
    return {
      h: value.h,
      p: value.p,
      e: value.e,
      c: value.c === true,
      ...(value.c === true && value.k === true ? { k: true } : {}),
      at: typeof value.at === "string" ? value.at : "",
      ...(typeof value.a === "string" && /^[0-9a-f]{12}$/.test(value.a) ? { a: value.a } : {}),
    };
  } catch {
    return null;
  }
}

export type UseResult =
  | { ok: true; claim: Claim }
  | { ok: false; reason: "expired" | "spent" };

/** Counts one use of an emailed link, and says whether it is still good. */
export async function spendClaim(token: string): Promise<UseResult> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) {
    return { ok: false, reason: "expired" };
  }
  const key = await claimKey(token);
  const [raw] = await redisPipeline([["GET", key]]);
  const claim = parseClaim(raw);
  if (!claim) return { ok: false, reason: "expired" };

  const uses = await usesKey(token);
  const [count] = await redisPipeline([
    ["INCR", uses],
    ["EXPIRE", uses, CLAIM_TTL_SECONDS],
  ]);
  if (Number(count) > MAX_CLAIM_USES) return { ok: false, reason: "spent" };
  return { ok: true, claim };
}

/**
 * Puts a confirmed address on the store's list.
 *
 * Called when the emailed link is used, never before. Agreeing is kept once
 * given: asking for a second free thing without ticking the box again is not
 * a withdrawal, and withdrawing is done by unsubscribing from the creator's
 * own emails, which is where that choice belongs.
 *
 * Never throws. A list that cannot be written must not cost somebody the file
 * they were promised.
 */
export async function recordLead(
  store: Store,
  claim: Claim,
  title: string,
): Promise<AddResult | null> {
  if (!store.listId || !isRedisConfigured()) return null;
  try {
    // A free copy is an order: its contact is counted at what it really adds (lib/order-data.ts).
    const result = await upsertContact(store.listId, claim.e, {
      agreed: claim.c,
      explicit: claim.c,
      clicks: claim.k === true,
      source: "free",
      sid: store.sid,
      productId: claim.p,
      title,
      at: claim.at,
    }, orderRoom(store));
    if (result.full) console.error("a store's list is full", store.handle);
    return result;
  } catch (error) {
    console.error("could not record an address on a list", error);
    return null;
  }
}

export type ListSize = { total: number; agreed: number; full: boolean };

/** How many addresses the list holds, and how many may be written to. */
export async function listSize(store: Store): Promise<ListSize> {
  try {
    const counts = await listCounts(store.listId);
    return { total: counts.total, agreed: counts.mailable, full: counts.full };
  } catch (error) {
    console.error("could not read a list's size", error);
    return { total: 0, agreed: 0, full: false };
  }
}

/**
 * One spreadsheet cell.
 *
 * Quoted always, and a leading character a spreadsheet would read as a
 * formula is defused, because an address, a product name — or a name or a
 * label an import brought from another platform's file (lib/imports.ts) — is
 * text somebody else typed and it must never run as a command on the
 * creator's computer. The rule is lib/csv.ts's, which also looks past
 * leading spaces (" =HYPERLINK(…)").
 */
function cell(value: string): string {
  return csvCell(value);
}

/**
 * The whole list as CSV, ready for any email tool.
 *
 * Read in pages, so a large list never has to fit in one answer from Redis.
 * With `onlyAgreed`, the file holds only the people who ticked the box —
 * the ones a creator in Europe may write to about anything new.
 */
export async function listAsCsv(store: Store, onlyAgreed: boolean): Promise<string> {
  const fields = await readFields(store.statsId).catch(() => []);
  const answers = fields.length ? await allValues(store.statsId, fields).catch(() => ({}) as Record<string, Record<string, string>>) : {};
  const rows = [
    // And the store's own fields, each a column of its own (lib/crm-rules.ts).
    ["email", "agreed_to_emails", "agreed_at", "first_at", "last_at", "asked_for", "unsubscribed_at", "name", "tags", "source", "imported_at", ...fields.map((f) => f.name)]
      .map(cell)
      .join(","),
  ];
  if (!store.listId || !isRedisConfigured()) return `${rows.join("\r\n")}\r\n`;

  const key = leadsKey(store.listId);
  let cursor = "0";
  // Bounded, so a cursor that never comes back to zero cannot hold the
  // function forever.
  for (let page = 0; page < MAX_LEADS / 500 + 10; page += 1) {
    const [reply] = await redisPipeline([["HSCAN", key, cursor, "COUNT", 1000]]);
    if (!Array.isArray(reply) || reply.length < 2) break;
    cursor = String(reply[0]);
    const flat = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const email = String(flat[i]);
      const lead = parseContact(flat[i + 1]);
      if (!lead) continue;
      if (onlyAgreed && !mailable(lead)) continue;
      rows.push(
        [
          email,
          lead.agreed ? "yes" : "no",
          lead.agreedAt,
          lead.firstAt,
          lead.lastAt,
          lead.titles.join("; "),
          lead.unsubAt,
          lead.name,
          lead.tags.join("; "),
          lead.source,
          lead.importedAt,
          ...fields.map((f) => (store.statsId ? answers[f.id]?.[personKey(store.statsId, email)] ?? "" : "")),
        ]
          .map(cell)
          .join(","),
      );
    }
    if (cursor === "0") break;
  }
  return `${rows.join("\r\n")}\r\n`;
}
