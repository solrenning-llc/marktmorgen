/**
 * A reading's token sent again costs nothing on a server that spent it, and on any other server it takes one of its
 * window's readings, so all the times it is sent, on every server, stay inside the window's ceiling that the cost
 * registry prices at readBeaconCost each (Claude 5's second review of #2571, MEDIUM 1: one token sent 201 times cost
 * 206 commands, with nothing bounding the sends). The real route, a real paying store, its real page check and token
 * (MemoryRedis); no outside request.
 */
import { POST as readRoute } from "@/app/api/store/read/route";
import { allowanceWindow } from "@/lib/allowance-window";
import { forgetReadingsSeen, noteReadStore, readSampled, readSlot, readToken, readTokenPass } from "@/lib/page-read";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { COMMANDS } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PRODUCT = "prod000001";
let commands = 0;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return real(list);
}) as typeof redis.pipeline;

let seed = 0;
const drawn = () => {
  for (;;) {
    const n = `visit${String((seed += 1)).padStart(11, "0")}`;
    if (readSampled(n)) return n;
  }
};
const sale = (t: string) => readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify({ t, k: "d", p: PRODUCT, b: "blok0001", s: 42 }) }) as never);

async function main(): Promise<void> {
  redis.clear();
  forgetReadingsSeen();
  await claimHandle("replay@example.test", "replayshop", "Replay Shop", "");
  await ensureStatsId("replay@example.test");
  await setSubscription("replay@example.test", { customerId: "cus_replay0000", subscriptionId: "sub_replay0000", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("replay@example.test"))!;
  const now = Date.now();
  const window = allowanceWindow(store, now)!.id;
  let place = 0;
  const token = () => {
    do place += 1;
    while (!readSlot(window, place));
    noteReadStore(store.statsId, store, now, place);
    return readToken(store.statsId, PRODUCT, now, drawn());
  };
  const one = token();
  const cap = readTokenPass(one, PRODUCT)!.cap;
  is("(a real token, with its window's ceiling)", cap > 0, true);

  part("The same server");
  commands = 0;
  await sale(one);
  const first = commands;
  commands = 0;
  for (let i = 0; i < 200; i += 1) await sale(one);
  is("sent again 200 times where it was spent: no command at all", commands, 0);
  is("(the reading itself stays inside its priced commands)", first <= COMMANDS.readBeacon, true);

  part("Sent again on other servers");
  // Five servers, each sent the token again three times the window's ceiling: on each, the sends that reach the
  // database take the window's readings, and once that server saw the ceiling reached it asks nothing more.
  const SERVERS = 5;
  commands = 0;
  for (let server = 0; server < SERVERS; server += 1) {
    forgetReadingsSeen();
    for (let i = 0; i < cap * 3; i += 1) await sale(one);
  }
  const [count] = (await real([["GET", `nl:traffic:read:${store.statsId}:${window}`]])) as string[];
  is("once a server, then never again there: one send a server reached the database and took one of the window's readings", Number(count), 1 + SERVERS);
  // Every place of the ceiling is priced at a reading's commands (COMMANDS.readBeacon); a server that had not seen it
  // full pays one refusal more: the token's mark and the count's two, and the count's expiry again.
  const REFUSAL = 4;
  is(`all ${SERVERS * cap * 3} sends stay inside the ceiling's priced commands and one refusal a server`, commands <= cap * COMMANDS.readBeacon + SERVERS * REFUSAL, true);
  commands = 0;
  await sale(one);
  is("past the ceiling, a server that saw it full asks nothing", commands, 0);
  is("no outside request", outside, 0);
  done();
}
void main();
