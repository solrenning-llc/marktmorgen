/**
 * Whether the store's list took addresses off for good, read for the store's other bulk email. Its own small module,
 * beside lib/contact-rules.ts, so a sender that only reads a row (community announcements, waitlist launches) does not
 * pull in lib/contacts.ts, and with it sign-in and email.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { leadsKey } from "@/lib/contact-rules";

const TAKEN_OFF = new Set(["bounced", "complained", "refused"]);

/**
 * For each address, whether the store's list took it off for a hard bounce, a spam complaint or a refusal (`unsub` with
 * `gone`, written by lib/contacts.ts stopWriting): such an address is never sent a store's bulk email of another kind
 * either, so a person who marked the store's mail as spam is not written to again and a dead address stops being
 * tried. Used by
 * community announcements (lib/community-mail.ts) and waitlist launches (lib/waitlist.ts, #4638). An address not on
 * the list is not taken off. A plain unsubscribe is not read here: each of those emails has a stop link of its own.
 * One HMGET of the list's rows, read exactly (rule 24): a reply or a row in no known shape throws UnknownReplyError,
 * so the caller's batch waits, never read as "not on the list".
 */
export async function takenOffList(listId: string, emails: readonly string[]): Promise<boolean[]> {
  if (!emails.length) return [];
  const rows = repliesFor(await redisPipeline([["HMGET", leadsKey(listId), ...emails]]), 1)?.[0];
  if (!Array.isArray(rows) || rows.length !== emails.length) throw new UnknownReplyError("the store's list rows of a batch");
  return emails.map((_, i) => {
    if (!Object.hasOwn(rows, i)) throw new UnknownReplyError("a store's list row");
    const raw: unknown = rows[i];
    if (raw === null) return false;
    if (typeof raw !== "string") throw new UnknownReplyError("a store's list row");
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      throw new UnknownReplyError("a store's list row");
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new UnknownReplyError("a store's list row");
    const { unsub, gone } = row as { unsub?: unknown; gone?: unknown };
    return unsub === true && typeof gone === "string" && TAKEN_OFF.has(gone);
  });
}
