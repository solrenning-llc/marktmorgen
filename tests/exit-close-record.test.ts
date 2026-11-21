/**
 * A closed store's chosen moved notice, kept in its record and written into
 * its old addresses when the record goes (97 [D2-OPEN-EXIT], unit 3:
 * lib/store.ts, parseStore and closeStoreRecord).
 *
 * What fails here:
 *   - a notice in a store's record that does not read whole, kept;
 *   - a store with no notice whose addresses are written or held differently
 *     from before (released, RELEASE_QUARANTINE_DAYS);
 *   - a store with a notice whose addresses do not carry it, lead to a store,
 *     or are held less than until the notice ends.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { RELEASE_QUARANTINE_DAYS, claimHandle, closeStoreRecord, handleLeadsToStore, storeForEmail, storeHandleKey } from "@/lib/store";
import { EXIT_NOTICE_DAYS, exitFromReleased, type ExitNotice } from "@/lib/exit-redirect-rules";

const DAY = 86_400_000;
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;
const get = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
const ttl = async (key: string) => Number((await redis.pipeline([["TTL", key]]))[0]);

async function withRecord(email: string, change: (value: Record<string, unknown>) => void): Promise<void> {
  const raw = await get(ownerKey(email));
  const value = JSON.parse(String(raw)) as Record<string, unknown>;
  change(value);
  await redis.pipeline([["SET", ownerKey(email), JSON.stringify(value)]]);
}

const now = Date.now();
const notice: ExitNotice = { to: "https://example.com/shop", host: "example.com", closedAt: now - DAY, setAt: now - 3 * DAY };

(async () => {
  part("Kept in the store's record");
  is("a store is made", (await claimHandle("leaver@example.com", "leaving-shop", "Leaving", "")).ok, true);
  is("with no notice, none is read", (await storeForEmail("leaver@example.com"))?.exitNotice, undefined);
  await withRecord("leaver@example.com", (value) => { value.exitNotice = notice; });
  is("a notice that reads comes back whole", (await storeForEmail("leaver@example.com"))?.exitNotice, notice);
  for (const [what, bad] of [
    ["an http address", { ...notice, to: "http://example.com/" }],
    ["a field more", { ...notice, ref: "leaver@example.com" }],
    ["text", "https://example.com/"],
    ["a date that is not a number", { ...notice, closedAt: "soon" }],
  ] as [string, unknown][]) {
    await withRecord("leaver@example.com", (value) => { value.exitNotice = bad; });
    is(`dropped: ${what}`, (await storeForEmail("leaver@example.com"))?.exitNotice, undefined);
  }

  part("A store with no notice closes as before");
  is("another store is made", (await claimHandle("plain@example.com", "plain-shop", "Plain", "")).ok, true);
  const plain = await storeForEmail("plain@example.com");
  await closeStoreRecord(plain!);
  const plainValue = await get(storeHandleKey("plain-shop"));
  is("its address is released, as before", /^released:\d{4}-\d{2}-\d{2}T[^ ]+$/.test(String(plainValue)), true);
  is("and leads to no store", handleLeadsToStore(plainValue), false);
  is("held for the quarantine", await ttl(storeHandleKey("plain-shop")), RELEASE_QUARANTINE_DAYS * 86_400);

  part("A store with a notice");
  await withRecord("leaver@example.com", (value) => { value.exitNotice = notice; value.previousHandles = ["leaving-old"]; });
  const leaver = await storeForEmail("leaver@example.com");
  is("the record carries the notice", leaver?.exitNotice, notice);
  await closeStoreRecord(leaver!);
  for (const handle of ["leaving-shop", "leaving-old"]) {
    const value = await get(storeHandleKey(handle));
    is(`${handle}: leads to no store`, handleLeadsToStore(value), false);
    is(`${handle}: carries the notice`, exitFromReleased(value), notice);
    const left = await ttl(storeHandleKey(handle));
    const until = Math.ceil((notice.closedAt + EXIT_NOTICE_DAYS * DAY - Date.now()) / 1000);
    is(`${handle}: held until the notice ends, never less than the quarantine`, left >= Math.max(RELEASE_QUARANTINE_DAYS * 86_400, until) - 5 && left <= Math.max(RELEASE_QUARANTINE_DAYS * 86_400, until), true);
  }
  is("the record itself is gone", await get(ownerKey("leaver@example.com")), null);
  done();
})();
