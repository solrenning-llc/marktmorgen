/**
 * Links in a one-off email that can be sent somewhere else after it went
 * out (124 [F2-EDIT-SENT-LINKS], unit 1; added 6 November 2026).
 *
 * A creator sends an email with a link that turns out wrong, or ends (a
 * call's address changes, a page moves). Until now the email was beyond
 * reach: its links went straight where they were typed. From now on, in a
 * one-off email made from this day, each of its first SENT_LINKS_MAX links
 * goes through one address of ours, app/go/<handle>/<email>/<n><share>,
 * which carries the address the link was sent with, signed with a key of
 * ours. Everybody who got the email gets the same link: nothing of the
 * reader is in it, nothing is counted when it is opened (no open, no
 * click), and the visible words of the link are the address as typed.
 *
 * What it does when opened (app/go/[handle]/[id]/[link]/route.ts): it
 * checks the signature, so it only ever leads to an address one of our
 * emails was sent with, or to a change the creator made to it, under the
 * rules of lib/sent-link-rules.ts. It counts one of the store's public
 * requests before it reads the change. Whatever cannot be read (the
 * store, its count, the change) leads to the address sent, never further.
 *
 *   nl:mail:bc:<id>:go   the changes to one email's links, in order, with
 *                        the list they belong to (JSON); gone
 *                        SENT_LINK_KEEP_DAYS after the first change, and
 *                        with the store (lib/broadcasts.ts, broadcastKeys)
 *
 * Old emails cannot be changed: their links point straight at the address,
 * and the studio says so. Sequence emails are written again for whoever
 * comes next, so they are not part of this.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey, deriveLegacyKey } from "@/lib/secret-box";
import { SITE_URL } from "@/lib/site-url";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { broadcastCampaign, variantCampaign } from "@/lib/mail-links";
import type { Store } from "@/lib/store";
import {
  type LinkChange,
  type SentVariant,
  SENT_LINKS_MAX,
  SENT_LINK_CHANGES_MAX,
  SENT_LINK_KEEP_DAYS,
  SENT_LINK_MAX_LENGTH,
  currentOf,
  destinationProblem,
  linksOf,
} from "@/lib/sent-link-rules";

const KEY_LABEL = "sent-link";
const ID = /^[0-9a-f]{24}$/;
/** The longest address a signed link carries: an address as written, with the email's tag on it. */
const MAX_SIGNED_LENGTH = 4_096;

/** Where the changes to one email's links are kept. */
export const sentLinkKey = (id: string) => `nl:mail:bc:${id}:go`;

/** The changes kept for one email: the list they belong to, when they go (seconds), and every change in order. */
export type SentLinks = { l: string; exp: number; changes: LinkChange[] };

/** The changes could not be read: an unknown reply is not "none". */
export class SentLinksUnreadable extends Error {
  constructor() { super("The changes to this email's links could not be read"); this.name = "SentLinksUnreadable"; }
}
/** A change may have been written though its answer was lost. */
export class SentLinkWriteUnconfirmed extends Error {
  constructor() { super("The change to this link could not be confirmed"); this.name = "SentLinkWriteUnconfirmed"; }
}

/** Whether links can be signed here; without the key, emails keep their links straight to the address. */
export function sentLinksReady(): boolean {
  return deriveKey(KEY_LABEL) !== null;
}

function signature(key: Buffer, handle: string, id: string, n: number, variant: SentVariant, sent: string): string {
  return createHmac("sha256", key).update(`nimbus-sent-link|${handle}|${id}|${n}|${variant}|${sent}`).digest("hex").slice(0, 32);
}

/** The share a campaign of this email is (lib/mail-links.ts): its own, or one subject line's. */
export function variantOf(id: string, campaign: string): SentVariant | null {
  if (campaign === broadcastCampaign(id)) return "x";
  if (campaign === variantCampaign(id, "a")) return "a";
  if (campaign === variantCampaign(id, "b")) return "b";
  return null;
}

/** The campaign a share of this email carries. */
export function campaignOf(id: string, variant: SentVariant): string {
  return variant === "x" ? broadcastCampaign(id) : variantCampaign(id, variant);
}

/**
 * For the email about to go out: where each of its first links leads
 * instead, given the address as written and the address it would have
 * gone to (tagged, lib/mail-links.ts). The same for every reader. Undefined
 * when links cannot be signed here, so they go straight where written.
 */
export function sentLinksFor(handle: string, id: string, campaign: string, body: string): ((href: string, tagged: string) => string) | undefined {
  const key = deriveKey(KEY_LABEL);
  const variant = variantOf(id, campaign);
  if (!key || !variant || !ID.test(id)) return undefined;
  const hrefs = linksOf(body);
  const made = new Map<string, string>();
  return (href, tagged) => {
    const n = hrefs.indexOf(href);
    if (n < 0 || tagged.length > MAX_SIGNED_LENGTH || !/^https:\/\//.test(tagged)) return tagged;
    const known = made.get(`${n}|${tagged}`);
    if (known) return known;
    const link = `${SITE_URL}/go/${encodeURIComponent(handle)}/${id}/${n}${variant}?u=${encodeURIComponent(tagged)}&s=${signature(key, handle, id, n, variant, tagged)}`;
    made.set(`${n}|${tagged}`, link);
    return link;
  };
}

/**
 * The address a link was sent with, when the signature on it is ours for
 * exactly this store, email, link and share; null otherwise. Checked with
 * the key in use and the one before it.
 */
export function sentAddress(handle: string, id: string, n: number, variant: SentVariant, sent: string, given: string): string | null {
  if (!ID.test(id) || !Number.isSafeInteger(n) || n < 0 || n >= SENT_LINKS_MAX) return null;
  if (typeof sent !== "string" || sent.length > MAX_SIGNED_LENGTH || typeof given !== "string" || !/^[0-9a-f]{32}$/.test(given)) return null;
  let url: URL;
  try {
    url = new URL(sent);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  for (const key of [deriveKey(KEY_LABEL), deriveLegacyKey(KEY_LABEL)]) {
    if (!key) continue;
    const made = signature(key, handle, id, n, variant, sent);
    if (timingSafeEqual(Buffer.from(made), Buffer.from(given))) return sent;
  }
  return null;
}

function parseKept(raw: unknown): SentLinks {
  if (typeof raw !== "string") throw new SentLinksUnreadable();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SentLinksUnreadable();
  }
  const kept = value as Partial<SentLinks> | null;
  if (!kept || typeof kept !== "object" || typeof kept.l !== "string" || !Number.isSafeInteger(kept.exp) || !Array.isArray(kept.changes)) throw new SentLinksUnreadable();
  if (kept.changes.length > SENT_LINK_CHANGES_MAX) throw new SentLinksUnreadable();
  for (const change of kept.changes as unknown[]) {
    const c = change as Partial<LinkChange> | null;
    if (!c || typeof c !== "object" || !Number.isSafeInteger(c.n) || (c.n as number) < 0 || (c.n as number) >= SENT_LINKS_MAX) throw new SentLinksUnreadable();
    if (typeof c.to !== "string" || c.to.length > SENT_LINK_MAX_LENGTH || !Number.isSafeInteger(c.at)) throw new SentLinksUnreadable();
  }
  return { l: kept.l, exp: kept.exp as number, changes: (kept.changes as LinkChange[]).map((c) => ({ n: c.n, to: c.to, at: c.at })) };
}

/** The changes kept for one email: null when there are none; SentLinksUnreadable when the answer is not one. */
export async function readSentLinks(id: string): Promise<SentLinks | null> {
  if (!ID.test(id)) return null;
  if (!isRedisConfigured()) throw new SentLinksUnreadable();
  const reply = await redisPipeline([["GET", sentLinkKey(id)]]);
  if (!Array.isArray(reply) || reply.length !== 1) throw new SentLinksUnreadable();
  if (reply[0] === null) return null;
  return parseKept(reply[0]);
}

/** The changes of several emails at once, for the studio: one command each, in one request. Unread ones are missing. */
export async function readSentLinksMany(ids: string[]): Promise<Map<string, SentLinks | null>> {
  const out = new Map<string, SentLinks | null>();
  const wanted = ids.filter((id) => ID.test(id));
  if (!wanted.length || !isRedisConfigured()) return out;
  const replies = await redisPipeline(wanted.map((id) => ["GET", sentLinkKey(id)]));
  if (!Array.isArray(replies) || replies.length !== wanted.length) return out;
  wanted.forEach((id, i) => {
    try {
      out.set(id, replies[i] === null ? null : parseKept(replies[i]));
    } catch {
      // Not shown as "never changed": left out, and the studio says it could not be read.
    }
  });
  return out;
}

/** The email as the studio and the change need it (lib/broadcasts.ts, Broadcast). */
export type SentEmail = { id: string; listId: string; handle: string; body: string; sent: number; links?: true };

export type ChangeResult =
  | { ok: true; changes: LinkChange[] }
  | { ok: false; reason: "none" | "old" | "unsent" | "link" | "to" | "full"; message: string };

export const CHANGE_REFUSALS: Record<Exclude<ChangeResult, { ok: true }>["reason"], string> = {
  none: "That email is not one of this store's.",
  old: "This email was sent before links could be changed. Its links go straight to the addresses written in it.",
  unsent: "This email has not gone to anybody yet. Change its words instead, before it goes.",
  link: "That link is not one of this email's.",
  to: "That address cannot be used.",
  full: `This email's links have been changed ${SENT_LINK_CHANGES_MAX} times, the most kept for one email. Each one keeps going where it goes now.`,
};

/**
 * Sends link `n` of a sent email somewhere else, under the rules of
 * lib/sent-link-rules.ts, kept after every change before it. Its room in
 * the store's data room is taken first (DataRoomError when it does not
 * fit). Throws SentLinksUnreadable when what is kept cannot be read, and
 * SentLinkWriteUnconfirmed when the write's answer is not Redis's "OK".
 */
export async function changeLink(store: Store, email: SentEmail, n: number, raw: string, now = Date.now()): Promise<ChangeResult> {
  const refuse = (reason: Exclude<ChangeResult, { ok: true }>["reason"], message = CHANGE_REFUSALS[reason]): ChangeResult => ({ ok: false, reason, message });
  // The list, not the address: a store that changed its address keeps its list, and its emails stay its own.
  if (!ID.test(email.id) || !store.listId || email.listId !== store.listId) return refuse("none");
  if (email.links !== true) return refuse("old");
  if (!(email.sent > 0)) return refuse("unsent");
  const hrefs = linksOf(email.body);
  if (!Number.isSafeInteger(n) || n < 0 || n >= hrefs.length) return refuse("link");
  const problem = destinationProblem(raw, hrefs[n], store);
  if (problem) return refuse("to", problem);
  const to = raw.trim();
  const kept = await readSentLinks(email.id);
  if (kept && kept.l !== store.listId) return refuse("none");
  const changes = kept?.changes ?? [];
  if ((currentOf(changes, n) ?? hrefs[n]) === to) return { ok: true, changes };
  if (changes.length >= SENT_LINK_CHANGES_MAX) return refuse("full");
  const at = Math.floor(now / 1000);
  const exp = kept?.exp ?? at + SENT_LINK_KEEP_DAYS * 86_400;
  if (exp <= at) return refuse("full");
  const entry: LinkChange = { n, to, at };
  const next: SentLinks = { l: store.listId, exp, changes: [...changes, entry] };
  // The change's bytes, and the record's own the first time, until the record goes.
  await needData(store, [{ until: exp * 1000, bytes: dataBytes([kept ? "" : JSON.stringify({ l: next.l, exp, changes: [] }), `${JSON.stringify(entry)},`], kept ? 0 : 1) }], now);
  let reply: unknown;
  try {
    reply = await redisPipeline([["SET", sentLinkKey(email.id), JSON.stringify(next), "EX", Math.max(1, exp - at)]]);
  } catch {
    throw new SentLinkWriteUnconfirmed();
  }
  if (!Array.isArray(reply) || reply.length !== 1 || reply[0] !== "OK") throw new SentLinkWriteUnconfirmed();
  return { ok: true, changes: next.changes };
}
