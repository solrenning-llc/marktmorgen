/**
 * Choosing a closing store's new address in the studio (97 [D2-OPEN-EXIT],
 * unit 5: chooseExitNotice in lib/store.ts, app/api/store/exit,
 * app/studio/moved).
 *
 * What fails here:
 *   - an address kept that is not a public https address outside this site;
 *   - a choice taken for a store that does not close whole, on or after its
 *     closing day, or with an unknown closing;
 *   - a refused choice that changes what was kept;
 *   - the notice kept with any other closing day than the store's own, or
 *     not taken away when the creator removes it;
 *   - the route taken without the settings permission, or without reading
 *     the store's own closing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./redis-stub";
import { done, is, part } from "./check";
import { chooseExitNotice, claimHandle, closeStoreRecord, storeForEmail, storeHandleKey, storeRef } from "@/lib/store";
import { exitFromReleased } from "@/lib/exit-redirect-rules";
import { KEEP_NOTHING_FROM } from "@/lib/plan-closing-rules";
import { redisPipeline } from "@/lib/redis";

const DAY = 86_400_000;
const root = process.cwd();

(async () => {
  is("a store is made", (await claimHandle("chooser@example.com", "choosing-shop", "Choosing", "")).ok, true);
  const ref = storeRef((await storeForEmail("chooser@example.com"))!);
  const endedAt = Math.max(KEEP_NOTHING_FROM, Date.now()) + DAY;
  const day = endedAt + 30 * DAY;
  const now = endedAt + DAY;
  const closing = { endedAt, day };

  part("Chosen before the closing day");
  const chosen = await chooseExitNotice(ref, "https://example.com/new-shop#top", closing, now);
  is("accepted", chosen.ok, true);
  is("kept with the store's own closing day and the time it was chosen", (await storeForEmail("chooser@example.com"))?.exitNotice, { to: "https://example.com/new-shop", host: "example.com", closedAt: day, setAt: now });
  is("an address that changes is kept again", (await chooseExitNotice(ref, "https://shop.example.org/", closing, now + 1)).ok, true);
  is("the newest one", (await storeForEmail("chooser@example.com"))?.exitNotice?.to, "https://shop.example.org/");

  part("Refused, and nothing changes");
  for (const [what, raw, reason] of [
    ["plain http", "http://example.com/", "not_https"],
    ["this site", "https://marktmorgen.com/@someone", "own_site"],
    ["an IP", "https://10.0.0.1/", "not_public"],
    ["a password in it", "https://a:b@example.com/", "credentials"],
    ["not an address", "my new shop", "not_address"],
  ] as [string, string, string][]) {
    is(`${what}: refused as ${reason}`, await chooseExitNotice(ref, raw, closing, now), { ok: false, reason });
  }
  is("the kept address is still the last good one", (await storeForEmail("chooser@example.com"))?.exitNotice?.to, "https://shop.example.org/");
  is("on the closing day: refused", await chooseExitNotice(ref, "https://example.com/", closing, day), { ok: false, reason: "not_closing" });
  is("a plan that ended before stores closed whole: refused", await chooseExitNotice(ref, "https://example.com/", { endedAt: KEEP_NOTHING_FROM - DAY, day: KEEP_NOTHING_FROM + 29 * DAY }, KEEP_NOTHING_FROM), { ok: false, reason: "not_closing" });
  is("an unknown closing day: refused", await chooseExitNotice(ref, "https://example.com/", { endedAt, day: Number.NaN }, now), { ok: false, reason: "not_closing" });
  is("an unknown clock: refused", await chooseExitNotice(ref, "https://example.com/", closing, Number.NaN), { ok: false, reason: "not_closing" });
  is("no such store", await chooseExitNotice("nobody@example.com", "https://example.com/", closing, now), { ok: false, reason: "none" });

  part("Removed");
  is("an empty address takes it away", (await chooseExitNotice(ref, "", closing, now)).ok, true);
  is("nothing kept", (await storeForEmail("chooser@example.com"))?.exitNotice, undefined);
  is("removing is refused too on the closing day", await chooseExitNotice(ref, "", closing, day), { ok: false, reason: "not_closing" });

  part("Kept until the store's record goes");
  await chooseExitNotice(ref, "https://example.com/new-shop", closing, now);
  await closeStoreRecord((await storeForEmail("chooser@example.com"))!);
  const [value] = await redisPipeline([["GET", storeHandleKey("choosing-shop")]]);
  is("the old address carries it", exitFromReleased(value)?.to, "https://example.com/new-shop");

  part("The route");
  const route = readFileSync(join(root, "app/api/store/exit/route.ts"), "utf8");
  is("needs the settings permission", /guardStoreWrite\(request, "settings"/.test(route), true);
  is("reads the store's own closing", /closingOf\(guarded\.store\)/.test(route), true);
  is("writes through chooseExitNotice", /chooseExitNotice\(guarded\.ref,/.test(route), true);

  done();
})();
