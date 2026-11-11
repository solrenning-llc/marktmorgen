/**
 * Reliable visit counts (TODOS-51 A): a store's visits are counted against its
 * plan only for a page that a person's browser opened, as the host's check
 * says (lib/bot-check.ts, browserProof; app/api/store/hit). A count the check
 * does not vouch for (it says a program, it failed, it answered in another
 * shape, it did not answer) is counted nowhere: not toward the store's visits,
 * not in its numbers. Off the host (local runs and the other tests) there is
 * no check, and a visit counts as before.
 *
 * Against the in-memory Redis and a stand-in for the host's check
 * (tests/visit-proof-world.ts); synthetic stores and addresses only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as hitRoute } from "@/app/api/store/hit/route";
import { claimHandle, storeFolder, storeForHandle } from "@/lib/store";
import { isResting, visitsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { publicVisitLimit, visitLimitFor } from "@/lib/traffic-rules";
import { botid, type Verdict } from "./visit-proof-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** A distinct old-style address for each n, inside 10.0.0.0/8. */
const addressOf = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

async function hit(handle: string, n: number, verdict: Verdict, kind: "v" | "p" = "v"): Promise<void> {
  botid.verdict = verdict;
  await hitRoute(
    new NextRequest("https://marktmorgen.com/api/store/hit", {
      method: "POST",
      headers: { "user-agent": PHONE, "x-forwarded-for": addressOf(n), "x-vercel-ip-country": "US" },
      body: JSON.stringify(kind === "v" ? { h: handle, k: "v", r: "", u: "", m: "", g: "" } : { h: handle, k: "p" }),
    }),
  );
}

async function main(): Promise<void> {
  redis.clear();
  const env = process.env as Record<string, string | undefined>;
  env.VERCEL = "1";
  await claimHandle("shop@example.com", "shop", "Shop", "");
  const store = (await storeForHandle("shop"))!;
  const folder = await storeFolder("shop@example.com");
  const month = () => allowanceWindow(store, Date.now())!.id;
  const visits = () => visitsIn(folder, month());

  part("On the host: only a page a real browser opened counts toward the store's visits");
  let before = await visits();
  await hit("shop", 1, "human");
  is("a person's browser: one visit", (await visits()) - before, 1);
  before = await visits();
  await hit("shop", 2, "bot");
  await hit("shop", 3, "bot", "p");
  is("a program, on the front page or another page: none", (await visits()) - before, 0);
  before = await visits();
  await hit("shop", 4, "throw");
  await hit("shop", 5, "odd");
  is("the check failed, or answered in another shape: none", (await visits()) - before, 0);
  before = await visits();
  await hit("shop", 6, "hang");
  is("the check never answered: none", (await visits()) - before, 0);
  is("the check was asked each time", botid.asked >= 6, true);

  part("Counts the check does not vouch for, past the store's visits, leave its visits and its pages as they were");
  const limit = publicVisitLimit(visitLimitFor(store));
  before = await visits();
  for (let n = 100; n < 100 + limit + 5; n += 1) await hit("shop", n, n % 2 ? "bot" : "throw");
  is("none counted", (await visits()) - before, 0);
  is("the store's pages are open as before", await isResting(store), false);

  part("Off the host there is no check: a visit counts as before");
  delete env.VERCEL;
  botid.asked = 0;
  before = await visits();
  await hit("shop", 9_000, "bot");
  is("counted, and the stand-in was never asked", [(await visits()) - before, botid.asked], [1, 0]);

  part("The page sends its count through the host's browser check");
  const beacon = readFileSync("components/store-beacon.tsx", "utf8");
  const client = readFileSync("lib/browser-check-client.ts", "utf8");
  is("the check guards the count's own address, for a POST, set up once for the window", /startBrowserCheck\(\);/.test(beacon) && /\{ path: "\/api\/store\/hit", method: "POST" \}/.test(client), true);
  is("a visit, a page or a funnel step goes by fetch, which the check signs, and is never sent again unsigned", /send\(fetch\)\.catch\(\(\) => \{\}\)/.test(beacon), true);
  is("a link's count, which needs no check, goes by sendBeacon and never waits on the challenge", /payload\.k === "l"/.test(beacon) && /navigator\.sendBeacon\("\/api\/store\/hit"/.test(beacon), true);

  done();
}

main();
