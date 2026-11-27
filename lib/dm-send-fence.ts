import type { SendFence } from "@/lib/community-dm";
import type { Store } from "@/lib/store";
import { listForNaming } from "@/lib/store-readings";

/**
 * What a private message is written against (DM_SEND_UNLESS_ERASED, lib/community-dm.ts): the store's list of deleted
 * people, the addresses of the members in it and how long the request has run. The store was read when the request
 * began, so its copy can say "no list" while an erasure that runs alongside gives the store one first
 * (lib/person-erasure.ts asks ensureListId) and then writes the person's print in it: a copy with no list asks the
 * store for its list the erasure's way, at its one try of the UTC day (lib/store-readings.ts, listForNaming, the mark
 * shared with the sales readings and the calendar feed and priced once a day in the store-readings line), so that
 * erasure is always the one asked (Codex L on #5495). With no list to ask, it throws before anything is written: the
 * route answers 503 "nothing changed", never an ordinary write that could put a deleted person's words back.
 * null only when the message names nobody (the creator has no print).
 */
export async function dmSendFence(store: Store, emails: string[], startedAt: number, now = Date.now()): Promise<SendFence | null> {
  const named = emails.filter((email) => email !== "");
  if (!named.length) return null;
  const listId = store.listId ?? (await listForNaming(store, now));
  if (!listId) throw new Error("a private message has no list of deleted people to be written against");
  return { listId, emails: named, ranSeconds: (Date.now() - startedAt) / 1000 };
}
