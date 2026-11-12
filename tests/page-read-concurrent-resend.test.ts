/**
 * One spent reading token sent many times AT ONCE to one server (Claude 1 cloud's review of #2571 at dc928d74ee,
 * MEDIUM 2): every send passed the "spent here" check before the first one's mark was answered, so each took one of
 * the window's readings (19,066 commands against 12,710 priced, the count five times the ceiling). The token is noted
 * as being spent on this server before its mark is asked, so sends at once cost what one send costs there: the mark,
 * and one of the window's readings, never one each. And a reading is priced at 11 commands (MEDIUM 1, the decision
 * recorded under ALL-160): a new server still counts once past a ceiling another server saw. The real route, a real
 * paying store, its real page check and token (MemoryRedis); no outside request.
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
  await claimHandle("burst@example.test", "burstshop", "Burst Shop", "");
  await ensureStatsId("burst@example.test");
  await setSubscription("burst@example.test", { customerId: "cus_burst00000", subscriptionId: "sub_burst00000", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("burst@example.test"))!;
  const now = Date.now();
  const window = allowanceWindow(store, now)!.id;
  let place = 0;
  do place += 1;
  while (!readSlot(window, place));
  noteReadStore(store.statsId, store, now, place);
  const one = readToken(store.statsId, PRODUCT, now, drawn());
  const cap = readTokenPass(one, PRODUCT)!.cap;
  is("(a real token, with its window's ceiling)", cap > 0, true);
  const counted = async () => Number(((await real([["GET", `nl:traffic:read:${store.statsId}:${window}`]])) as (string | null)[])[0] ?? 0);

  part("A reading is priced honestly");
  is("a reading costs 11 commands at the worst (ALL-160), never fewer", COMMANDS.readBeacon >= 11, true);

  part("Sent at once, where it was spent first");
  commands = 0;
  await sale(one);
  const first = commands;
  is("(the reading itself stays inside its priced commands)", first <= COMMANDS.readBeacon, true);
  commands = 0;
  await Promise.all(Array.from({ length: 200 }, () => sale(one)));
  is("200 sends at once where it was spent: no command at all", commands, 0);

  part("Sent at once on a server that has not seen it");
  forgetReadingsSeen();
  commands = 0;
  await Promise.all(Array.from({ length: cap * 5 }, () => sale(one)));
  const REFUSAL = 4;
  is(`${cap * 5} sends at once cost one refusal on this server, never one each`, commands <= REFUSAL, true);
  is("and take one of the window's readings for this server, never one each", await counted(), 2);
  is("no outside request", outside, 0);
  done();
}
void main();
