/**
 * MM-SA-43 (docs/security-audit-2026-10-28.md; 506 [SG1]): app/api/store/read
 * counted how a page was read (a sales page's furthest block, the store page's
 * reach) for any number of beacons from one connection, while its sibling
 * app/api/store/hit stops counting past a window per connection and store.
 * A script could skew a creator's numbers at will and spend Redis commands.
 *
 * A real visitor sends one of these as they leave a page, and only one visitor
 * in eight is asked (lib/page-read.ts, READ_SAMPLE), so READ_PER_CONNECTION in
 * ten minutes is far above anything a person sends.
 *
 * What fails here: one connection counted past READ_PER_CONNECTION in the
 * window, or another connection to the same store not counted.
 * Synthetic store; MemoryRedis; the real route.
 */
import { READ_PER_CONNECTION, readToken, STORE_SCOPE } from "@/lib/page-read";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { POST as readRoute } from "@/app/api/store/read/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "read-window@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const send = (body: Record<string, unknown>, ip: string) =>
  readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE, "x-forwarded-for": ip }, body: JSON.stringify(body) }) as never);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "readwindow", "Read Window", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const token = readToken(store.statsId!, STORE_SCOPE);
  const field = "sr:2.p:prod000001>";
  const counted = async () => Number((await redis.pipeline([["HGET", `nl:stats:${store.statsId}:${new Date().toISOString().slice(0, 10)}`, field]]))[0] ?? 0);

  part("One connection sending far more than a person can");
  is("the window is a small number, well above a visitor's", READ_PER_CONNECTION > 0 && READ_PER_CONNECTION <= 120, true);
  for (let n = 0; n < READ_PER_CONNECTION + 40; n += 1) await send({ k: "s", t: token, n: 2, b: "p:prod000001", c: "" }, "198.51.100.7");
  is(`counted at most ${READ_PER_CONNECTION} times in the window`, await counted(), READ_PER_CONNECTION);

  part("Control: another connection to the same store is still counted");
  await send({ k: "s", t: token, n: 2, b: "p:prod000001", c: "" }, "203.0.113.9");
  is("one more", await counted(), READ_PER_CONNECTION + 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
