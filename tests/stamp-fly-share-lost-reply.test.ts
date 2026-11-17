/**
 * A copy made on the fly whose connection's share was added to, but whose reply was lost, never leaves that share
 * debited for work that was not done (Codex C2's MEDIUM on #3899, restated by Claude 2 nuvem L and by Codex X4 at
 * 0ff841cb4e). holdPublicRequests held the store's window, then sent the share's add; Redis applied it and the reply
 * was lost. The hold was refused and the window given back, but the share stayed raised by the whole hold, which can
 * be more than the connection's share of the day: every copy that connection asked for was refused until the day
 * ended, a paid download shut out by one lost reply.
 *
 * Now each hold on the share carries its own token, and a reply that is lost or in another shape is settled by that
 * token alone: a hold found in place is confirmed and the copy goes ahead; a hold found absent is fenced, so it can
 * never land later, and refused with the window given back; a settling that cannot be read either is refused (no
 * copy is made on an unknown). Synthetic Redis; nothing is reached.
 */
import { flyHoldUnits } from "@/lib/stamp-cost-rules";
import { givePublicRequests, holdPublicRequests } from "@/lib/traffic";
import { clientDayShare, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "fly-lost@example.com";
const HANDLE = "flylost";
const MB = 1024 * 1024;
type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);

/** The `:f:` fields of the connections' shares of copies, summed (any key of the traffic family that is a hash). */
async function shareTotal(window: string, counter: string): Promise<{ sum: number; negative: boolean }> {
  let sum = 0;
  let negative = false;
  for (const key of redis.keys().filter((k) => k.startsWith("nl:traffic:") && k.includes(window) && k !== counter)) {
    const [type] = await pipeline([["TYPE", key]]);
    if (type !== "hash") continue;
    const [flat] = await pipeline([["HGETALL", key]]);
    const list = Array.isArray(flat) ? flat : Object.entries(flat ?? {}).flat();
    for (let i = 0; i < list.length; i += 2) {
      if (!/:f:[0-9a-f]+$/.test(String(list[i]))) continue;
      const value = Number(list[i + 1]);
      sum += value;
      if (value < 0) negative = true;
    }
  }
  return { sum, negative };
}

/**
 * Losing replies: "add" loses the reply of the pipeline that raised a share of copies (it is applied first, then the
 * reply throws); "all" also loses every reply after it in this hold, so nothing the hold sends next can be read.
 */
let lose: "add" | "all" | null = null;
let lost = false;
let windowId = "";
let counterKey = "";
redis.pipeline = (async (commands: Command[]) => {
  if (lose === "all" && lost) {
    await pipeline(commands);
    throw new Error("synthetic: the reply was lost after Redis applied the commands");
  }
  if (lose === null || lost) return pipeline(commands);
  const before = (await shareTotal(windowId, counterKey)).sum;
  const replies = await pipeline(commands);
  if ((await shareTotal(windowId, counterKey)).sum > before) {
    lost = true;
    throw new Error("synthetic: the share's add was applied, then its reply was lost");
  }
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  answering(null);
  await claimHandle(OWNER, HANDLE, "Fly Lost", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_flylost001", subscriptionId: "sub_flylost001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const now = Date.now();
  const folder = await storeFolder(OWNER);
  windowId = allowanceWindow(store, now)!.id;
  counterKey = `nl:traffic:r:${folder}:${windowId}`;
  const windowCount = async () => Number((await pipeline([["GET", counterKey]]))[0] ?? 0);
  const share = async () => shareTotal(windowId, counterKey);
  // A copy whose hold is more than the connection's whole share of the day: one such hold left on the share by a lost
  // reply is enough to shut the connection's copies out for the rest of the day.
  const big = flyHoldUnits(45 * MB);
  const used = 80;
  answering(new Request(`https://marktmorgen.com/@${HANDLE}/download`, { headers: { "x-forwarded-for": "203.0.113.91" } }));

  part("Premise: the hold is above the connection's share of copies for the day");
  is("the hold is above the share", big > clientDayShare(requestLimitFor(store, now / 1000)), true);

  part("The share's add is applied and its reply lost: the share is never left debited for a copy that is not made");
  {
    const windowBefore = await windowCount();
    const shareBefore = (await share()).sum;
    lose = "add";
    lost = false;
    const held = await holdPublicRequests(store, big, now, "buyer", { shared: true });
    lose = null;
    is("the add was applied and its reply lost (the scenario took place)", lost, true);
    if (held) {
      // Confirmed by its token: the copy goes ahead, and settles as any other.
      is("held: the window counts the hold", (await windowCount()) - windowBefore, big);
      await givePublicRequests(store, big - used, now, { shared: true });
      is("the window counts what the copy used", (await windowCount()) - windowBefore, used);
      is("and so does the connection's share", (await share()).sum - shareBefore, used);
    } else {
      is("refused: the window is given back", await windowCount(), windowBefore);
      is("and the connection's share is not left debited for it", (await share()).sum, shareBefore);
    }
    is("no share is left below zero", (await share()).negative, false);
  }

  part("The same connection's next copy is not shut out by the lost reply");
  {
    const next = flyHoldUnits(20 * MB);
    const held = await holdPublicRequests(store, next, now, "buyer", { shared: true });
    is("held", held, true);
    if (held) await givePublicRequests(store, next - used, now, { shared: true });
    is("no share is left below zero", (await share()).negative, false);
  }

  part("Nothing after the add can be read either: the copy is refused, never made on an unknown");
  {
    answering(new Request(`https://marktmorgen.com/@${HANDLE}/download`, { headers: { "x-forwarded-for": "203.0.113.92" } }));
    const windowBefore = await windowCount();
    lose = "all";
    lost = false;
    const held = await holdPublicRequests(store, big, now, "buyer", { shared: true });
    lose = null;
    is("the add was applied and its reply lost", lost, true);
    is("the copy is refused", held, false);
    is("the window is given back what it held", await windowCount(), windowBefore);
    is("no share is left below zero", (await share()).negative, false);
  }
  answering(null);
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
