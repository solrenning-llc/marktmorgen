/**
 * Leaving a list takes back the permission to see one's link use (lib/mail-clicks.ts
 * header), so what was already counted of it is deleted with the unsubscribe
 * (tracking-consent hunt, November 2026), as "stop counting" (stopCounting)
 * and a person's erasure (forgetClicksPerson) already did. On main, the
 * unsubscribe only dropped the row's `clicks` flag: the link use counted
 * before stayed up to 90 days and the link key 400, and a return to the list
 * within those days (same token) read the old clicks into a sequence's
 * "clicked" branch.
 *
 * The real route (app/api/mail/unsubscribe) over the in-memory Redis.
 * Control: another person on the same list keeps theirs. Synthetic records.
 */
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { tokensFor, upsertContact } from "@/lib/contacts";
import { noteClick, rememberLinkKeys } from "@/lib/mail-clicks";
import { claimHandle, ensureListId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No real provider call allowed");
}) as typeof fetch;

const OWNER = "clicks-owner@example.test";
const HANDLE = "clickskiln";
const CAMPAIGN = "s-0123456789abcdef-0123456789abcdef";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Clicks Kiln", "");
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  const tokens: Record<string, string> = {};
  for (const email of ["leaver@example.test", "stayer@example.test"]) {
    await upsertContact(listId, email, { agreed: true, explicit: true, source: "free", sid: store.sid, clicks: true, title: "The Guide" }, ROOM);
    const token = (await tokensFor(listId, [email], store.handle)).get(email);
    if (!token) throw new Error("no unsubscribe token");
    tokens[email] = token;
    const keys = await rememberLinkKeys([token]);
    await noteClick(keys.get(token) as string, CAMPAIGN);
  }
  const clickKeys = () => redis.keys().filter((key) => key.startsWith(`nl:mail:clk:${listId}:`)).length;
  const linkKeys = () => redis.keys().filter((key) => key.startsWith("nl:mail:mk:")).length;
  is("set up: two people's link use and two link keys", [clickKeys(), linkKeys()], [2, 2]);

  part("Unsubscribing");
  const response = await unsubscribePost(
    new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?t=${tokens["leaver@example.test"]}`, { method: "POST", headers: { host: "marktmorgen.com" } }),
  );
  is("says so", [response.status, await response.text()], [200, "Unsubscribed."]);
  is("deletes the link use they had counted, and their link key", [clickKeys(), linkKeys()], [1, 1]);
  const again = await unsubscribePost(
    new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?t=${tokens["leaver@example.test"]}`, { method: "POST", headers: { host: "marktmorgen.com" } }),
  );
  is("pressed twice: still fine, nothing else touched", [again.status, clickKeys(), linkKeys()], [200, 1, 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
