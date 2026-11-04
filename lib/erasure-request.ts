/**
 * A person deleting themselves from a store, or from every store, without
 * asking anybody (added 17 October 2026). The page is /privacy/delete.
 *
 * They type their address, and the store's name when they came from one. If
 * that address is known there — on its list, as a buyer, or as having joined
 * it — a link is emailed to it; the page says the same whether or not it is,
 * so the form cannot be used to learn who buys from whom, and nothing is
 * sent to an address the stores do not know. The link works for an hour and
 * opens a page that says what will be deleted and what is kept; pressing
 * the button there deletes them (lib/person-erasure.ts), and each store's
 * owner is told it was done. Nobody is asked to approve it.
 *
 * Every store is the stores the address bought from or joined itself, as
 * lib/buyer-library.ts notes them: a store whose list an import alone put
 * them on is found when they ask from that store.
 *
 * Bounded like the library's link: a few asks an hour from one network
 * address and for one email address, one email per ask (taken from the
 * first store's figure for such emails, only up to the share a visitor's
 * typed address may take, as the sign-up box's are), and each store's own erasure
 * counted against that store's studio figure (lib/person-erasure.ts).
 *
 *   nl:erase:link:<hash of a token>  { e: address, s: [store ids still to do] }, an hour
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { type Store, storeForHandle, storeForId } from "@/lib/store";
import { leadsKey } from "@/lib/contacts";
import { storesKnownFor } from "@/lib/buyer-library";
import { erasePerson } from "@/lib/person-erasure";
import {
  ERASE_ASKS_PER_ADDRESS_HOUR,
  ERASE_ASKS_PER_IP_HOUR,
  ERASE_LINK_SECONDS,
  ERASE_TOKEN,
  MAX_ERASE_STORES,
} from "@/lib/erasure-rules";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:erase:link:${sha(`nimbus-erase-link:${token}`).slice(0, 40)}`;
const STORE_ID = /^[0-9a-f]{32}$/;
/** How long one press keeps deleting before it hands the rest to the next press. */
const PRESS_MS = 40_000;

type Grant = { e: string; s: string[] };

export type EraseAsk = "sent" | "email" | "limited" | "error";

/** Whether this store holds the address: on its list, or as a buyer or a joiner it noted. */
async function knows(store: Store, email: string, known: Set<string>): Promise<boolean> {
  if (store.sid && known.has(store.sid)) return true;
  if (!store.listId) return false;
  const [held] = await redisPipeline([["HEXISTS", leadsKey(store.listId), email]]);
  return Number(held) === 1;
}

/**
 * Emails a link that deletes this address from one store (by its address on
 * Marktmorgen) or from every store that knows it. "sent" whether or not any
 * does; nothing is sent when none does.
 */
export async function requestErasureLink(input: { email: string; ip: string; origin: string; handle?: string }): Promise<EraseAsk> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinLimit("erase-ip", input.ip, ERASE_ASKS_PER_IP_HOUR, 3_600))) return "limited";
  if (!(await withinLimit("erase-address", sha(email), ERASE_ASKS_PER_ADDRESS_HOUR, 3_600))) return "limited";
  const known = new Set(await storesKnownFor(email));
  const stores: Store[] = [];
  if (input.handle) {
    const store = await storeForHandle(input.handle).catch(() => null);
    if (store?.sid && (await knows(store, email, known))) stores.push(store);
  } else {
    for (const sid of [...known].slice(0, MAX_ERASE_STORES)) {
      const store = await storeForId(sid).catch(() => null);
      if (store?.sid) stores.push(store);
    }
  }
  if (!stores.length) return "sent";
  const token = randomBytes(32).toString("hex");
  const grant: Grant = { e: email, s: stores.map((s) => s.sid) };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", ERASE_LINK_SECONDS]]);
  const names = stores.map((s) => s.name).slice(0, 10);
  const more = stores.length - names.length;
  const sent = await sendEmail({
    // `asked` (MM-SA-05): the address was typed by a visitor, and a store knows every address on its
    // list, which a stranger can fill through the sign-up box, so these links take only the share of
    // the access emails such confirmations may (askedCeiling); the rest is kept for buyers' own links.
    meter: { by: "store", store: stores[0], kind: "transactional", asked: true },
    from: NIMBUS_FROM,
    to: email,
    subject: stores.length === 1 ? `Delete your data from ${stores[0].name}` : "Delete your data from stores on Marktmorgen",
    text: [
      stores.length === 1
        ? `Someone asked to delete everything ${stores[0].name} keeps about this address on Marktmorgen.`
        : `Someone asked to delete everything these stores on Marktmorgen keep about this address: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
      "",
      "To see what will be deleted and what has to be kept, and to delete it, open this link within an hour:",
      "",
      `${input.origin}/privacy/delete?token=${token}`,
      "",
      "Nothing is deleted until you press the button on that page. If you did not ask for this, ignore this email: nobody can delete your data without it.",
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/** The address a live link was sent to, and the stores it still deletes from; null when it has run out. */
export async function readErasureLink(token: string): Promise<{ email: string; stores: Store[] } | null> {
  if (!ERASE_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant) return null;
  const stores = (await Promise.all(grant.s.map((sid) => storeForId(sid).catch(() => null)))).filter((s): s is Store => s !== null);
  return { email: grant.e, stores };
}

function parseGrant(raw: unknown): Grant | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Grant>;
    if (typeof v.e !== "string" || !EMAIL_PATTERN.test(v.e) || !Array.isArray(v.s)) return null;
    return { e: v.e, s: v.s.filter((s): s is string => typeof s === "string" && STORE_ID.test(s)).slice(0, MAX_ERASE_STORES) };
  } catch {
    return null;
  }
}

export type EraseDone = {
  state: "done" | "more" | "gone";
  /** The stores they were deleted from by this press. */
  deleted: string[];
  /** The stores that could not finish now, kept on the link to press again. */
  later: string[];
};

/**
 * Deletes the address from the link's stores, one after the other, until
 * they are done or PRESS_MS have gone; what is left stays on the link, so
 * pressing again finishes it. Each store's owner is told, with the address,
 * so they can delete it from their own tools too (Stripe, an email platform).
 */
export async function confirmErasure(token: string, now = Date.now()): Promise<EraseDone> {
  if (!ERASE_TOKEN.test(token) || !isRedisConfigured()) return { state: "gone", deleted: [], later: [] };
  const key = linkKey(token);
  const [raw, ttl] = await redisPipeline([["GET", key], ["TTL", key]]);
  const grant = parseGrant(raw);
  if (!grant) return { state: "gone", deleted: [], later: [] };
  const deleted: string[] = [];
  const later: string[] = [];
  for (const sid of grant.s) {
    if (Date.now() - now > PRESS_MS) {
      later.push(sid);
      continue;
    }
    const store = await storeForId(sid).catch(() => null);
    if (!store) continue;
    const result = await erasePerson(store, grant.e, { kind: "person" }).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
    if (!result.ok) {
      later.push(sid);
      continue;
    }
    deleted.push(store.name);
    await tellOwner(store, grant.e).catch((error: unknown) => console.error("telling a store's owner about a deletion failed", error));
  }
  if (later.length) {
    await redisPipeline([["SET", key, JSON.stringify({ e: grant.e, s: later } satisfies Grant), "EX", Math.max(60, Number(ttl) || ERASE_LINK_SECONDS)]]);
    return { state: "more", deleted, later };
  }
  await redisPipeline([["DEL", key]]);
  return { state: "done", deleted, later };
}

/** The owner's note: done, not asked. One of the store's own emails (lib/store-allowance-rules.ts, "email"). */
async function tellOwner(store: Store, email: string): Promise<void> {
  await sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `A person deleted their data from ${store.name}`,
    text: [
      `${email} asked, through the link we emailed them, to be deleted from ${store.name}, and it is done.`,
      "",
      "Deleted: their place on your list, your fields, notes and deals about them, your team's tasks about them, their form answers, workflow history, course progress, community record, reviews, waitlist places and inbox conversations. Your store will not email them again; only they can change that, by joining your list again themselves.",
      "",
      "Not deleted yet: posts and comments they wrote in your community stay, shown without their name. Delete them from the community if they ask.",
      "",
      "Kept: their payments on your own Stripe account, which are your sales and tax records, and the order records a sale or a refund still needs. Each one is listed at marktmorgen.com/privacy#delete.",
      "",
      "If you also keep them anywhere else (a connected email platform, your own files), delete them there too.",
    ].join("\n"),
  });
}
