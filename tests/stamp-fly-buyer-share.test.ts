/**
 * A copy stamped on the fly is held from the store's window alone, never from the buyer's connection's share of the
 * day (Claude 1 cloud's triage MEDIUM on #3899).
 *
 * The share of one connection on the Store plan (lib/traffic-rules.ts, clientDayShare) is smaller than the hold of
 * a big file made on the fly (lib/stamp-cost-rules.ts, flyHoldUnits): a 45 MB file holds more than the whole share.
 * Held from that share, such a download could never be made, and the buyer was told to try again in a few minutes,
 * which was false; worse, the refused hold stayed added to the connection's share, so that buyer's connection was
 * shut out of the whole store for the rest of the day. The work is done once for the order, bounded by the order
 * link's opens an hour, and its money ceiling is the store's window, so it is held there only.
 *
 * What is checked:
 *   - premise: the hold of a 45 MB file is above one connection's share of the day on the Store plan;
 *   - a shared hold of it passes while the store's window has room, and the same connection still gets its next
 *     request; a second copy on the fly the same day is held too;
 *   - the window still bounds it: a shared hold past the window is refused and left uncounted;
 *   - the download route holds its copies that way.
 */
import { readFileSync } from "node:fs";
import { flyHoldUnits } from "@/lib/stamp-cost-rules";
import { givePublicRequests, holdPublicRequests, takePublicRequest } from "@/lib/traffic";
import { clientDayShare, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "fly-share@example.com";
const HANDLE = "flyshare";
const MB = 1024 * 1024;

async function main(): Promise<void> {
  redis.clear();
  answering(null);
  await claimHandle(OWNER, HANDLE, "Fly Share", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_flyshare01", subscriptionId: "sub_flyshare01", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const now = Date.now();
  const whole = requestLimitFor(store, now / 1000);
  const share = clientDayShare(whole);
  const big = flyHoldUnits(45 * MB);
  const folder = await storeFolder(OWNER);
  const counter = `nl:traffic:r:${folder}:${allowanceWindow(store, now)!.id}`;
  const count = async () => Number((await redis.pipeline([["GET", counter]]))[0] ?? 0);
  const buyer = () => answering(new Request(`https://marktmorgen.com/@${HANDLE}/download`, { headers: { "x-forwarded-for": "203.0.113.77" } }));

  part("Premise: a 45 MB copy made on the fly holds more than one connection's share of the day");
  is("the hold is above the share", big > share, true);
  is("the window has room for it", big < whole, true);

  part("A copy made on the fly is held from the store's window, not the buyer's share");
  {
    buyer();
    is("the 45 MB hold passes", await holdPublicRequests(store, big, now, "buyer", { shared: true }), true);
    is("the window counts it", await count(), big);
    is("the same connection still gets its next request", await takePublicRequest(store, "buyer", now), true);
    await givePublicRequests(store, big - 20, now);
    const small = flyHoldUnits(20 * MB);
    is("a second copy on the fly the same day is held too", await holdPublicRequests(store, small, now, "buyer", { shared: true }), true);
    is("and a third", await holdPublicRequests(store, small, now, "buyer", { shared: true }), true);
    is("the connection is still let in", await takePublicRequest(store, "buyer", now), true);
    answering(null);
  }

  part("The store's window still bounds it");
  {
    buyer();
    const before = await count();
    is("a hold past the window is refused", await holdPublicRequests(store, whole, now, "buyer", { shared: true }), false);
    is("and left uncounted", await count(), before);
    answering(null);
  }

  // Claude 2 nuvem I's focal MEDIUM on #3899: with the connection's share out of it, one order's link (240 opens an
  // hour) could stamp copies until the store's whole window was spent, and every visitor after was refused. What a copy
  // used counts on its connection's share of the day: once past it, that connection makes no more copies today, while
  // the store's window stays open to everybody else.
  part("One connection's copies made on the fly stop at its share of the day; the store stays open to others");
  {
    redis.clear();
    await claimHandle(OWNER, HANDLE, "Fly Share", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_flyshare01", subscriptionId: "sub_flyshare01", active: true, tier: "creator", period: paidPeriod() });
    const fresh = (await storeForEmail(OWNER)) as Store;
    const hold = flyHoldUnits(20 * MB);
    const used = 80;
    buyer();
    let copies = 0;
    while (copies < 200 && (await holdPublicRequests(fresh, hold, now, "buyer", { shared: true }))) {
      await givePublicRequests(fresh, hold - used, now, { shared: true });
      copies += 1;
    }
    is("one connection stops within its share of the day", copies > 0 && copies * used <= share + hold, true);
    answering(new Request(`https://marktmorgen.com/@${HANDLE}/download`, { headers: { "x-forwarded-for": "198.51.100.23" } }));
    is("and another visitor is still let in", await takePublicRequest(fresh, "buyer", now), true);
    is("who can make a copy on the fly too", await holdPublicRequests(fresh, hold, now, "buyer", { shared: true }), true);
    answering(null);
  }

  part("The download route holds its copies made on the fly from the store's window alone");
  {
    const route = readFileSync("app/api/store/download/route.ts", "utf8");
    const take = /take: \(units\) => holdPublicRequests\(([^)]*)\)/.exec(route)?.[1] ?? "";
    is("the copy meter's take is found", take.length > 0, true);
    is("it holds with shared: true", /shared: true/.test(take), true);
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
