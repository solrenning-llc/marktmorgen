/**
 * A pitch refused for an unknown stop list or day's count reserves nothing
 * (audit SG2, CX-123 rule 24).
 *
 * startPitch (lib/outreach.ts) reserved the store's paid resource window
 * first and only then read the stop lists and the day's count, so a pitch
 * refused as "unavailable" on an unknown answer had already bound the
 * window, while the studio said nothing was changed. The stop lists (for
 * the address's own domain) and the day's count are now read before the
 * window is reserved; the reservation (a stand-in that counts,
 * tests/sg2-l1-reserve-world.ts) is asked only on exact answers.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, saveSender, startPitch } from "@/lib/outreach";
import { store as redis } from "./redis-stub";
import { reserveWorld } from "./sg2-l1-reserve-world";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

let checkReply: unknown = undefined;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const check = commands.length === 3 && commands[0]?.[0] === "SISMEMBER" && commands[1]?.[0] === "GET" && commands[2]?.[0] === "SISMEMBER";
  if (check && checkReply === "throw") throw new Error("the database did not answer");
  if (check && checkReply !== undefined) return checkReply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

const PAGE = "https://copperoak.com/partners";
const SITE: Record<string, string> = {
  "https://copperoak.com/robots.txt": "User-agent: *\nDisallow: /cart\n",
  [PAGE]: "<p>Creators and sponsors: write to partnerships@copperoak.com.</p>",
};
const reader: PageReader = async (url) => (url in SITE ? { url, html: SITE[url] } : null);

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }) });
  const plain = (await storeForEmail("owner@example.com"))!;
  const store = { ...plain, period: { ...plain.period!, funded: true as const } };
  await saveSender(store, { name: "Jenny Park", address: "PO Box 12, Columbus, OH 43004, USA" });
  const input = { goal: "sponsor" as const, country: "US", isCompany: false, page: PAGE, email: "partnerships@copperoak.com", company: "Copper & Oak", about: "Pans.", notes: "I post three family recipes a week." };
  const NOW = Math.floor(Date.now() / 1000) - 86_400;
  const attempt = async (reply: unknown) => {
    checkReply = reply;
    const before = reserveWorld.reserved;
    const result = await startPitch(store, input, { reader, now: NOW }).catch(() => ({ ok: false as const, reason: "threw" }));
    return [result.ok ? "written" : result.reason, reserveWorld.reserved - before];
  };

  part("an unknown answer refuses before the paid window is reserved");
  for (const [label, reply] of [
    ["the store's stop answered null", [null, null, 0]],
    ["everyone's stop as text", [0, null, "0"]],
    ["the day's count not a number", [0, "many", 0]],
    ["one reply missing", [0, null]],
    ["a reply that is not a list", { result: [0, null, 0] }],
  ] as [string, unknown][]) {
    is(`${label}: unavailable, and no window reserved`, await attempt(reply), ["unavailable", 0]);
  }
  part("a known refusal also comes before the reservation");
  is("stopped: refused, no window reserved", await attempt([1, null, 0]), ["stopped", 0]);
  part("exact answers go on to reserve the window, as before");
  const fine = await attempt([0, null, 0]);
  is("the window is reserved once", fine[1], 1);
  checkReply = undefined;

  done();
}

void main();
