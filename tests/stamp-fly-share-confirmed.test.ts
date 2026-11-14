/**
 * A copy made on the fly is let through only once its connection's share of copies is confirmed held (Codex X8's
 * MEDIUM on #3899). holdPublicRequests held the store's window, then added the hold to the connection's share with a
 * best-effort HINCRBY whose failure it swallowed: the copy went ahead with nothing on the share, and the give-back
 * after it then subtracted the unused part from a share that never held it, leaving a credit below zero that the next
 * copies spent. Now the share's HINCRBY and EXPIRE must answer in their exact shape (a whole count of at least the
 * hold, and 1); otherwise the window's hold is given back, nothing is left on the share, and the copy is refused.
 * Synthetic Redis; nothing is reached.
 */
import { flyHoldUnits } from "@/lib/stamp-cost-rules";
import { givePublicRequests, holdPublicRequests } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "fly-confirm@example.com";
const HANDLE = "flyconfirm";
const MB = 1024 * 1024;
type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
let refuseShareAdd: "throw" | "odd" | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const adds = commands.some((c) => c[0] === "HINCRBY" && String(c[2]).includes(":f:") && Number(c[3]) > 0);
  if (adds && refuseShareAdd === "throw") throw new Error("synthetic: the share's write refused before it was applied");
  if (adds && refuseShareAdd === "odd") return commands.map(() => "QUEUED");
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  answering(null);
  await claimHandle(OWNER, HANDLE, "Fly Confirm", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_flyconfirm1", subscriptionId: "sub_flyconfirm1", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const now = Date.now();
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store, now)!.id;
  const counter = `nl:traffic:r:${folder}:${window}`;
  const windowCount = async () => Number((await pipeline([["GET", counter]]))[0] ?? 0);
  const shareFields = async () => {
    const all = redis.keys().filter((key) => key.startsWith("nl:traffic:") && key.includes(window) && key !== counter);
    const values: number[] = [];
    for (const key of all) {
      const [type] = await pipeline([["TYPE", key]]);
      if (type !== "hash") continue;
      const [flat] = await pipeline([["HGETALL", key]]);
      const list = Array.isArray(flat) ? flat : Object.entries(flat ?? {}).flat();
      for (let i = 0; i < list.length; i += 2) if (String(list[i]).includes(":f:")) values.push(Number(list[i + 1]));
    }
    return values;
  };
  const hold = flyHoldUnits(20 * MB);
  answering(new Request(`https://marktmorgen.com/@${HANDLE}/download`, { headers: { "x-forwarded-for": "203.0.113.90" } }));

  for (const how of ["throw", "odd"] as const) {
    part(`The share's add ${how === "throw" ? "is refused before it is applied" : "answers in another shape"}`);
    const before = await windowCount();
    refuseShareAdd = how;
    const held = await holdPublicRequests(store, hold, now, "buyer", { shared: true });
    refuseShareAdd = null;
    if (held) await givePublicRequests(store, hold - 80, now, { shared: true });
    is("the copy is not let through", held, false);
    is("the store's window is given back what it held", await windowCount(), before);
    is("and the share has no credit below zero", (await shareFields()).every((v) => v >= 0), true);
  }

  part("Control: a confirmed hold still lets the copy through, and its unused part comes back");
  const before = await windowCount();
  is("held", await holdPublicRequests(store, hold, now, "buyer", { shared: true }), true);
  await givePublicRequests(store, hold - 80, now, { shared: true });
  is("the window counts what the copy used", (await windowCount()) - before, 80);
  is("and so does the connection's share", await shareFields(), [80]);
  answering(null);
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
