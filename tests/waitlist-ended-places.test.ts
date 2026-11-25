/**
 * A waitlist's ceiling counts only places that can still count (Codex X6's LOW on #3616, the same shape here, Claude 4
 * coordinator's follow-up item): a place nobody confirmed stops holding a place once its confirm link has ended
 * (CONFIRM_SECONDS after its latest join), and the next join that finds the list full drops it, with its link to
 * leave, and gives its room back. And the ceiling is checked in the same step as the write (WAIT_JOIN), so two joins at
 * once for the last place never take it both. Synthetic data; no provider is called.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, leaveWaitlist, setSoon } from "@/lib/waitlist";
import { MAX_WAITLIST } from "@/lib/waitlist-rules";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const links: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    links.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const DAY = 86_400_000;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "The Bread Book", "", "39", null);
  const second = await addProduct(OWNER, "The Soup Book", "", "39", null);
  if (!made.ok || !second.ok) throw new Error("no product");
  await setSoon((await storeForEmail(OWNER))!, made.product.id, true);
  await setSoon((await storeForEmail(OWNER))!, second.product.id, true);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const other = (await readListing(store, second.product.id))!;
  const list = `nl:wl:${store.statsId}:${product.id}`;
  let ip = 0;
  const join = (email: string, on = product) => joinWaitlist({ store, product: on, email, consent: false, ip: `10.0.${Math.floor(++ip / 200)}.${ip % 200}`, origin: "https://marktmorgen.com" });
  const held = (i: number) => JSON.stringify({ at: 1, ok: 2, c: false, t: `${String(i).padStart(8, "0")}${"b".repeat(40)}` });

  part("A place nobody confirmed stops holding a place once its confirm link has ended");
  const realNow = Date.now;
  Date.now = () => realNow() - 8 * DAY;
  let stale: string;
  try {
    stale = await join("stale@example.com");
  } finally {
    Date.now = realNow;
  }
  is("it joined eight days ago", stale, "sent");
  const leaveLink = /waitlist\?leave=([0-9a-f]{48})/.exec(links.at(-1) ?? "")?.[1] ?? "";
  is("its email carried a link to leave", leaveLink.length, 48);
  const fill: string[] = [];
  for (let i = 0; i < MAX_WAITLIST - 1; i += 1) fill.push(`held${i}@example.com`, held(i));
  redis.run(["HSET", list, ...fill]);
  is("the list is at its ceiling with it", redis.run(["HLEN", list]), MAX_WAITLIST);
  const roomBefore = (await dataUsed(store))?.used ?? Number.NaN;
  is("a new address takes the place it held", await join("fresh@example.com"), "sent");
  is("the ended place is gone, the new one is there, the list still at its ceiling", [redis.run(["HEXISTS", list, "stale@example.com"]), redis.run(["HEXISTS", list, "fresh@example.com"]), redis.run(["HLEN", list])], [0, 1, MAX_WAITLIST]);
  is("its link to leave went with it", await leaveWaitlist(leaveLink, store), false);
  const roomAfter = (await dataUsed(store))?.used ?? Number.NaN;
  is("its room came back: the store holds no more than before, besides the new join's confirm link", roomAfter - roomBefore < 600, true);
  is("a confirmed place never stops holding its place", redis.run(["HEXISTS", list, "held0@example.com"]), 1);
  is("and with nothing ended, a full list takes nobody", await join("late@example.com"), "full");

  part("Two joins at once for the last place: the list never goes past its ceiling");
  {
    const last = `nl:wl:${store.statsId}:${other.id}`;
    const filled: string[] = [];
    for (let i = 0; i < MAX_WAITLIST - 1; i += 1) filled.push(`kept${i}@example.com`, held(i));
    redis.run(["HSET", last, ...filled]);
    const real = redis.pipeline.bind(redis);
    // Both read the list's size before either writes: a barrier on the read.
    let waiting = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "HLEN" && c[1] === last)) {
        const reply = await real(commands);
        waiting += 1;
        if (waiting === 2) release();
        await bothRead;
        return reply;
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let results: string[] = [];
    try {
      results = await Promise.all([join("sam@example.com", other), join("tia@example.com", other)]);
    } finally {
      redis.pipeline = real;
    }
    is("one gets the last place", results.filter((r) => r === "sent").length, 1);
    is("the other is told the list is full", results.filter((r) => r !== "sent"), ["full"]);
    is("the list holds exactly its ceiling", redis.run(["HLEN", last]), MAX_WAITLIST);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
