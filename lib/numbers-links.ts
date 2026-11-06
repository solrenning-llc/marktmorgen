/**
 * A read-only link to the store's numbers (added 13 October 2026), for a
 * partner, a co-producer or a sponsor to follow the results without asking
 * for screenshots: at /numbers/<id>, with a password and an end date,
 * showing the numbers this site counted (lib/verified-numbers.ts) and
 * nothing else.
 *
 * Plausible, Fathom, Simple Analytics and Pirsch share a dashboard by link,
 * optionally behind a password. Here every link has both a password and an
 * end, because what it shows is the creator's business:
 *
 *   - the password is kept only as a slow hash (scrypt, with a salt of its
 *     own), so the record cannot give it back;
 *   - a right password is remembered in this browser for twelve hours, by a
 *     cookie signed with a key of this deployment (lib/secret-box.ts) that
 *     names the link and ends with it;
 *   - wrong passwords are limited per connection, and the page opens at most
 *     OPENS_PER_DAY times a day;
 *   - it shows the record kept once a day, so opening it asks nothing of
 *     Stripe, and it can be taken back at once from the studio.
 *
 *   nl:nlink:<id>              the store it belongs to, until it ends
 *   nl:nlink:opens:<id>:<day>  how many times it opened that day
 */
import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { deriveKey } from "@/lib/secret-box";

export type NumbersLink = {
  id: string;
  /** Who it is for, as the creator names it: "Acme sponsorship". */
  label: string;
  /** When it stops working, in seconds. */
  expires: number;
  made: number;
  /** Whether it shows money too, or only visits and sales counted. */
  money: boolean;
  salt: string;
  hash: string;
};

export const MAX_LINKS = 5;
export const LINK_DAYS = [7, 30, 90] as const;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 100;
export const MAX_LABEL = 60;
export const OPENS_PER_DAY = 300;
export const COOKIE_SECONDS = 12 * 3600;
export const LINK_ID = /^[a-z0-9]{20}$/;

const indexKey = (id: string) => `nl:nlink:${id}`;
const opensKey = (id: string, day: string) => `nl:nlink:opens:${id}:${day}`;

const hashOf = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, "hex"), 32).toString("hex");

/** Links read back from the store's record: only whole ones. Pure. */
export function parseLinks(raw: unknown): NumbersLink[] {
  if (!Array.isArray(raw)) return [];
  const out: NumbersLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "string" || !LINK_ID.test(v.id)) continue;
    if (typeof v.salt !== "string" || !/^[0-9a-f]{32}$/.test(v.salt) || typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)) continue;
    const expires = Math.floor(Number(v.expires));
    if (!(expires > 0)) continue;
    out.push({
      id: v.id,
      label: typeof v.label === "string" ? v.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "",
      expires,
      made: Math.floor(Number(v.made)) || 0,
      money: v.money === true,
      salt: v.salt,
      hash: v.hash,
    });
  }
  return out.slice(0, MAX_LINKS);
}

export type NewLink = { ok: true; link: NumbersLink } | { ok: false; reason: "password" | "days" | "label" };

/** A new link from what the creator typed. Pure but for the random id and salt. */
export function makeLink(input: { label: unknown; password: unknown; days: unknown; money: unknown }, now: number): NewLink {
  const label = typeof input.label === "string" ? input.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
  if (!label) return { ok: false, reason: "label" };
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return { ok: false, reason: "password" };
  const days = Number(input.days);
  if (!(LINK_DAYS as readonly number[]).includes(days)) return { ok: false, reason: "days" };
  const salt = randomBytes(16).toString("hex");
  // randomInt draws each letter evenly; a byte taken modulo 36 would favour the first four.
  const id = Array.from({ length: 20 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join("");
  const made = Math.floor(now / 1000);
  return { ok: true, link: { id, label, expires: made + days * 86_400, made, money: input.money === true, salt, hash: hashOf(password, salt) } };
}

/** Whether a password opens a link. */
export function passwordFits(link: NumbersLink, password: unknown): boolean {
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD) return false;
  const made = Buffer.from(hashOf(password, link.salt), "hex");
  const kept = Buffer.from(link.hash, "hex");
  return made.length === kept.length && timingSafeEqual(made, kept);
}

/** The cookie a right password leaves: when it ends, signed. Empty without a key to sign with. */
export function passCookie(link: NumbersLink, now: number): string {
  const key = deriveKey("numbers-link");
  if (!key) return "";
  const until = Math.min(link.expires, Math.floor(now / 1000) + COOKIE_SECONDS);
  // The hash is in what is signed, so a link taken back and made again never opens with the old cookie.
  const sig = createHmac("sha256", key).update(`${link.id}:${until}:${link.hash}`).digest("hex").slice(0, 40);
  return `${until}.${sig}`;
}

/** Whether a cookie still opens a link. */
export function cookieFits(link: NumbersLink, cookie: string | undefined, now: number): boolean {
  const key = deriveKey("numbers-link");
  if (!key || typeof cookie !== "string") return false;
  const match = /^(\d{9,11})\.([0-9a-f]{40})$/.exec(cookie);
  if (!match) return false;
  const until = Number(match[1]);
  if (until < Math.floor(now / 1000) || until > link.expires) return false;
  const made = createHmac("sha256", key).update(`${link.id}:${until}:${link.hash}`).digest("hex").slice(0, 40);
  return timingSafeEqual(Buffer.from(made), Buffer.from(match[2]));
}

export const cookieName = (id: string) => `nl_numbers_${id}`;

/** Points the link's id at its store, until it ends. */
export async function indexLink(sid: string, link: NumbersLink, now: number): Promise<void> {
  const seconds = Math.max(60, link.expires - Math.floor(now / 1000));
  await redisPipeline([["SET", indexKey(link.id), sid, "EX", seconds]]);
}

export async function unindexLink(id: string): Promise<void> {
  await redisPipeline([["DEL", indexKey(id)]]);
}

/** The store a link belongs to, or null when it has ended or was taken back. */
export async function linkStore(id: string): Promise<string | null> {
  if (!LINK_ID.test(id) || !isRedisConfigured()) return null;
  // Only a link that is not there finds nothing; any other reply is unknown and throws (rule 24), never "ended".
  const replies = repliesFor(await redisPipeline([["GET", indexKey(id)]]), 1);
  const sid = replies ? replies[0] : undefined;
  if (sid === null) return null;
  if (typeof sid !== "string" || !sid) throw new UnknownReplyError("a numbers link's store");
  return sid;
}

/** Counts one opening; false once the day's openings are used. */
export async function countOpen(id: string, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  // A count in any other shape is unknown and throws (rule 24), never "opened too many times".
  const n = countOf(repliesFor(await redisPipeline([["INCR", opensKey(id, day)], ["EXPIRE", opensKey(id, day), 2 * 86_400]]), 2)?.[0]);
  if (n === null) throw new UnknownReplyError("a numbers link's openings");
  return n <= OPENS_PER_DAY;
}
