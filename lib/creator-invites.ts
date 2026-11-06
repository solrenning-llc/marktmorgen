/**
 * Creators inviting creators: the link, who came through it, and the ledger
 * of credit it has earned. The terms are in lib/creator-invite-rules.ts; the
 * daily job that reads Stripe and adds the credit is in
 * lib/creator-invite-credit.ts.
 *
 * How someone counts as invited, and why each rule is there:
 *
 *   - They pressed "Accept the invite" on the invite page, which leaves the
 *     code in a first-party cookie for INVITE_COOKIE_DAYS. Pressing it is
 *     asking for the invite's credit, so the cookie is the thing they asked
 *     for, not tracking — and nobody is counted for merely opening a link.
 *   - They then made their FIRST store. An account that already had one is
 *     not new to us, whoever's link it followed.
 *   - The invite is not their own: the inviting store's owner is someone
 *     else.
 *   - It is written once and never changed. The first invite accepted is the
 *     one that counts; nobody can take a creator over from whoever brought
 *     them.
 *
 * The daily job adds one more: an account that had already paid us before it
 * was invited — somebody who left and came back through a friend's link —
 * earns nobody anything.
 *
 * Kept:
 *
 *   nl:ref:code:<code>    the store (sid) whose link it is
 *   nl:ref:mycode:<sid>   that store's code
 *   nl:ref:by:<sid>       who invited this store, and when: { r, at, back? }
 *   nl:ref:list:<sid>     the stores this one invited, by when
 *   nl:ref:all            every invited store, by when (the job's walk)
 *   nl:ref:c:<id>         one credit: a share of an invoice, or a new
 *                         creator's first-payment credit
 *   nl:ref:mine:<sid>     the credits owed to this store, by when earned
 *   nl:ref:owed           credits earned and not yet on anyone's plan
 */
import { randomInt } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { normaliseEmail } from "@/lib/auth";
import { type Store, storeForId } from "@/lib/store";
import { INVITE_CODE_ALPHABET, INVITE_CODE_PATTERN, currentInviteTerms, readInviteTerms, INVITE_PROGRAM_OPEN, mayRecordAcceptedInvite, type InviteTerms } from "@/lib/creator-invite-rules";

const SID_PATTERN = /^[0-9a-f]{32}$/;

export const codeKey = (code: string) => `nl:ref:code:${code}`;
export const myCodeKey = (sid: string) => `nl:ref:mycode:${sid}`;
export const byKey = (sid: string) => `nl:ref:by:${sid}`;
export const listKey = (sid: string) => `nl:ref:list:${sid}`;
export const ALL_KEY = "nl:ref:all";
export const creditKey = (id: string) => `nl:ref:c:${id}`;
export const mineKey = (sid: string) => `nl:ref:mine:${sid}`;
export const OWED_KEY = "nl:ref:owed";

/** Who invited a store. `back` once the job found it had paid us before. */
export type InvitedBy = { r: string; at: number; back?: boolean; terms?: InviteTerms };

export function parseBy(raw: unknown): InvitedBy | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<InvitedBy>;
    if (typeof v.r !== "string" || !SID_PATTERN.test(v.r) || typeof v.at !== "number") return null;
    const terms = readInviteTerms(v.terms);
    if (!terms) return null;
    return { r: v.r, at: v.at, terms, ...(v.back === true ? { back: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * One credit.
 *
 *   share   INVITE_SHARE_PERCENT of one invoice an invited creator paid, to
 *           whoever invited them; its id is the invoice's.
 *   bonus   the invited creator's own credit after their first payment; its
 *           id is "bonus_" and their store's.
 *
 * `state`: owed until it is on the plan at Stripe, then done. "none" for an
 * invoice read and found to earn nothing (refunded, or paid by credit), so it
 * is not read again. "gone" when the store it was for no longer exists.
 */
export type Credit = {
  id: string;
  kind: "share" | "bonus";
  to: string;
  from: string;
  cents: number;
  cur: string;
  at: number;
  state: "owed" | "done" | "none" | "gone";
  txn?: string;
  doneAt?: number;
};

export function parseCredit(raw: unknown): Credit | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Credit>;
    if (typeof v.id !== "string" || (v.kind !== "share" && v.kind !== "bonus")) return null;
    if (typeof v.to !== "string" || !SID_PATTERN.test(v.to) || typeof v.from !== "string") return null;
    if (typeof v.cents !== "number" || typeof v.cur !== "string" || typeof v.at !== "number") return null;
    if (v.state !== "owed" && v.state !== "done" && v.state !== "none" && v.state !== "gone") return null;
    return v as Credit;
  } catch {
    return null;
  }
}

/** A store's invite code, made the first time it is asked for. */
export async function inviteCode(sid: string): Promise<string | null> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return null;
  const [have] = await redisPipeline([["GET", myCodeKey(sid)]]);
  if (typeof have === "string" && INVITE_CODE_PATTERN.test(have)) return have;
  for (let tries = 0; tries < 5; tries += 1) {
    // randomInt draws each letter evenly; a byte taken modulo the alphabet would favour its first letters.
    const code = Array.from({ length: 8 }, () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)]).join("");
    const [took] = await redisPipeline([["SET", codeKey(code), sid, "NX"]]);
    if (took === null) continue;
    const [mine] = await redisPipeline([["SET", myCodeKey(sid), code, "NX"]]);
    if (mine !== null) return code;
    // Two tabs asked at once and the other won: give this code back and use
    // that one, so a store only ever has one link.
    const [, won] = await redisPipeline([["DEL", codeKey(code)], ["GET", myCodeKey(sid)]]);
    return typeof won === "string" ? won : null;
  }
  return null;
}

/** The store whose invite this is, or null. */
export async function inviterFor(code: string): Promise<Store | null> {
  if (!INVITE_CODE_PATTERN.test(code) || !isRedisConfigured()) return null;
  const [sid] = await redisPipeline([["GET", codeKey(code)]]);
  if (typeof sid !== "string") return null;
  return storeForId(sid);
}

export type RecordResult = "recorded" | "no_code" | "own" | "already" | "paused";

/**
 * Writes down who invited a store that was just made: the account's first.
 * Called by the route that makes it, with the code from the invite cookie.
 */
export async function recordInvite(store: Pick<Store, "sid" | "email" | "extra">, code: string, now = Date.now()): Promise<RecordResult> {
  if (!mayRecordAcceptedInvite(now)) return "paused";
  if (store.extra || !SID_PATTERN.test(store.sid)) return "already";
  const inviter = await inviterFor(code);
  if (!inviter?.sid) return "no_code";
  if (inviter.sid === store.sid || normaliseEmail(inviter.email) === normaliseEmail(store.email)) return "own";
  const at = Math.floor(now / 1000);
  const [set] = await redisPipeline([["SET", byKey(store.sid), JSON.stringify({ r: inviter.sid, at, terms: INVITE_PROGRAM_OPEN ? currentInviteTerms() : readInviteTerms(undefined) }), "NX"]]);
  if (set === null) return "already";
  await redisPipeline([
    ["ZADD", listKey(inviter.sid), at, store.sid],
    ["ZADD", ALL_KEY, at, store.sid],
  ]);
  return "recorded";
}

/** Who invited this store, if anyone. */
export async function invitedBy(sid: string): Promise<InvitedBy | null> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", byKey(sid)]]);
  return parseBy(raw);
}

/** Where an invited creator stands with us, as the one who invited them is told it. */
export type InvitedState = "trial" | "paying" | "not_started" | "stopped" | "returning";

export type InvitedRow = {
  handle: string;
  name: string;
  at: number;
  state: InvitedState;
  /** Credit from their payments already on the inviter's plan, in cents. */
  added: number;
  /** Credit from their payments earned and on its way to the plan. */
  owed: number;
};

export type InviteView = {
  code: string;
  invited: InvitedRow[];
  /** How many invited stores there are, when more than the list shows. */
  total: number;
  added: number;
  owed: number;
  currency: string;
};

const SHOWN = 200;

function stateOf(store: Store, by: InvitedBy, nowSeconds: number): InvitedState {
  if (by.back) return "returning";
  if (!store.subscriptionId) return "not_started";
  if (!store.subscriptionActive) return "stopped";
  return store.trialEnds > nowSeconds ? "trial" : "paying";
}

/** What the studio's invite page shows its owner. */
export async function inviteView(store: Store, now = Date.now()): Promise<InviteView | null> {
  const code = await inviteCode(store.sid);
  if (!code) return null;
  const [sids, count, creditIds] = await redisPipeline([
    ["ZREVRANGE", listKey(store.sid), 0, SHOWN - 1],
    ["ZCARD", listKey(store.sid)],
    ["ZREVRANGE", mineKey(store.sid), 0, 4999],
  ]);
  const ids = Array.isArray(sids) ? sids.map(String) : [];
  const cids = Array.isArray(creditIds) ? creditIds.map(String) : [];

  const [bys, credits] = await Promise.all([
    ids.length ? redisPipeline(ids.map((sid) => ["GET", byKey(sid)])) : Promise.resolve([]),
    cids.length ? redisPipeline(cids.map((id) => ["GET", creditKey(id)])) : Promise.resolve([]),
  ]);
  const stores = await Promise.all(ids.map((sid) => storeForId(sid)));

  const perFrom = new Map<string, { added: number; owed: number }>();
  let added = 0;
  let owed = 0;
  let currency = "usd";
  for (const raw of credits) {
    const credit = parseCredit(raw);
    if (!credit || credit.to !== store.sid) continue;
    currency = credit.cur || currency;
    const row = perFrom.get(credit.from) ?? { added: 0, owed: 0 };
    if (credit.state === "done") {
      added += credit.cents;
      if (credit.kind === "share") row.added += credit.cents;
    } else if (credit.state === "owed") {
      owed += credit.cents;
      if (credit.kind === "share") row.owed += credit.cents;
    }
    perFrom.set(credit.from, row);
  }

  const nowSeconds = Math.floor(now / 1000);
  const invited: InvitedRow[] = [];
  ids.forEach((sid, i) => {
    const found = stores[i];
    const by = parseBy(bys[i]);
    if (!found || !by) return;
    const money = perFrom.get(sid) ?? { added: 0, owed: 0 };
    invited.push({ handle: found.handle, name: found.name, at: by.at, state: stateOf(found, by, nowSeconds), added: money.added, owed: money.owed });
  });
  return { code, invited, total: Number(count) || invited.length, added, owed, currency };
}
