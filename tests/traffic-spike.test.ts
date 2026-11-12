/**
 * TODOS-51 D, the alarm: a store whose window of requests is used up much
 * faster than the window passes tells the operator, once per mark, and
 * nothing else changes (lib/traffic-spike.ts, called from lib/traffic.ts
 * countRequest). Synthetic stores, the in-memory Redis and a stand-in sender.
 */
import { readFileSync } from "node:fs";
import { SPIKE_ALERTS_PER_DAY, SPIKE_MARKS, alertSpike, markCount, spikeMark } from "@/lib/traffic-spike";
import type { AllowanceWindow } from "@/lib/allowance-window";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { holdPublicRequests, takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const window: AllowanceWindow = { id: "2026-11", start: Date.parse("2026-11-01T00:00:00Z"), end: Date.parse("2026-12-01T00:00:00Z"), billing: false };
const at = (share: number) => window.start + Math.floor((window.end - window.start) * share);
const LIMIT = 10_000;

type Sent = { to: unknown; subject: string; text: string; meter: unknown };
let sent: Sent[] = [];
const send = (async (message: Sent) => {
  sent.push(message);
  return true;
}) as never;

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  env.DEMO_STUDIO_ADMIN = "operator@example.com";

  part("Which mark, and only when early");
  is("half the requests in the first fifth of the window", spikeMark(markCount(LIMIT, 0.5), 1, LIMIT, window, at(0.2)), 0);
  is("half the requests after a third of the window: on pace, nothing", spikeMark(markCount(LIMIT, 0.5), 1, LIMIT, window, at(0.34)), null);
  is("one request short of the mark: nothing", spikeMark(markCount(LIMIT, 0.5) - 1, 1, LIMIT, window, at(0.01)), null);
  is("one past the mark (already crossed): nothing", spikeMark(markCount(LIMIT, 0.5) + 1, 1, LIMIT, window, at(0.01)), null);
  is("a request of 5 units that crosses the mark: caught", spikeMark(markCount(LIMIT, 0.5) + 2, 5, LIMIT, window, at(0.01)), 0);
  is("one that crosses two marks at once: the higher", spikeMark(markCount(LIMIT, 0.9), markCount(LIMIT, 0.9) - markCount(LIMIT, 0.75) + 1, LIMIT, window, at(0.1)), 2);
  is("nine tenths before 60% of the window", spikeMark(markCount(LIMIT, 0.9), 1, LIMIT, window, at(0.59)), 2);
  is("outside the window, or a count that is not one: nothing", [spikeMark(markCount(LIMIT, 0.5), 1, LIMIT, window, window.end), spikeMark(Number.NaN, 1, LIMIT, window, at(0.1)), spikeMark(markCount(LIMIT, 0.5), 0, LIMIT, window, at(0.1))], [null, null, null]);
  is("three marks", SPIKE_MARKS.length, 3);

  part("The operator is told once per store, window and mark; nothing else changes");
  redis.clear();
  sent = [];
  const written: string[] = [];
  const watched = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) written.push(String(command[1] ?? ""));
    return watched(commands);
  }) as typeof redis.pipeline;
  const first = await alertSpike({ handle: "shop" }, "folder01", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send);
  const again = await alertSpike({ handle: "shop" }, "folder01", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.11), send);
  is("one email, to the operator, paid by the company", [first, again, sent.length, sent[0]?.to, JSON.stringify(sent[0]?.meter)], [true, false, 1, "operator@example.com", '{"by":"company"}']);
  is("it says nothing was changed", /Nothing was changed/.test(sent[0]?.text ?? ""), true);
  redis.pipeline = watched;
  is("no key but its own claim and the day's count was touched", written.every((key) => key.startsWith("nl:traffic:spike")), true);
  is("another mark of the same store is its own", await alertSpike({ handle: "shop" }, "folder01", window, markCount(LIMIT, 0.75), 1, LIMIT, at(0.2), send), true);
  is("on pace: no email", await alertSpike({ handle: "calm" }, "folder02", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.4), send), false);

  part("At most SPIKE_ALERTS_PER_DAY in a day, whatever the number of stores");
  redis.clear();
  sent = [];
  for (let i = 0; i < SPIKE_ALERTS_PER_DAY + 5; i += 1) await alertSpike({ handle: `s${i}` }, `folder${i}`, window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send);
  is("the day's ceiling holds", sent.length, SPIKE_ALERTS_PER_DAY);
  is("the next day, again", await alertSpike({ handle: "late" }, "folderlate", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1) + DAY, send), true);

  part("Unknown replies, or no operator, send nothing");
  redis.clear();
  sent = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SET" ? ["QUEUED"] : pipeline(commands))) as typeof redis.pipeline;
  is("a claim answered in another shape", await alertSpike({ handle: "odd" }, "folderodd", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send), false);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "INCR" ? ["1", 1] : pipeline(commands))) as typeof redis.pipeline;
  is("a day's count answered as text", await alertSpike({ handle: "odd2" }, "folderodd2", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send), false);
  redis.pipeline = (async () => {
    throw new Error("down");
  }) as typeof redis.pipeline;
  is("the database down: nothing, and no throw", await alertSpike({ handle: "down" }, "folderdown", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send), false);
  redis.pipeline = pipeline;
  delete env.DEMO_STUDIO_ADMIN;
  is("no operator configured", await alertSpike({ handle: "none" }, "foldernone", window, markCount(LIMIT, 0.5), 1, LIMIT, at(0.1), send), false);
  is("so no email at all in this part", sent.length, 0);

  part("Wired where the window is counted, after its own INCRBY");
  const traffic = readFileSync("lib/traffic.ts", "utf8");
  const counted = traffic.indexOf('redisPipeline([["INCRBY", key, units]])');
  const alarm = traffic.indexOf("alertSpike(store, folder, window, n, units, limit, now)");
  is("countRequest asks after the count, with the count, the units and the limit", counted > 0 && alarm > counted, true);
  // Claude 1's LOW on #3380: a hold refused and given back is not counted, so it rings nothing; the page never waits on
  // the claim, the day's count or the email.
  const givenBack = traffic.indexOf('if (n > limit && giveBack) await redisPipeline([["DECRBY", key, units]])');
  is("the alarm looks only after a refused hold was given back", givenBack > counted && alarm > givenBack, true);
  is("a count given back rings nothing", /if \(n > limit && giveBack\)[^\n]*\n[\s\S]*?if \(!\(n > limit && giveBack\) && spikeMark\(n, units, limit, window, now\) !== null\) afterAnswer\(\(\) => alertSpike\(/.test(traffic), true);
  is("the request never waits on the alarm", traffic.includes("await alertSpike("), false);

  part("Driven through countRequest: a hold given back rings nothing, and no request waits on the alarm (Claude 1's LOW on #3697)");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  env.DEMO_STUDIO_ADMIN = "operator@example.com";
  const OWNER = "spiky@example.com";
  await claimHandle(OWNER, "spiky", "Spiky", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_spiky", subscriptionId: "sub_spiky", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(OWNER))!;
  const live = allowanceWindow(shop, Date.now());
  if (!live) throw new Error("no window");
  const early = live.start + 1_000;
  const own = allowanceWindow(shop, early)!;
  const folder = await storeFolder(storeRef(shop));
  const requests = `nl:traffic:r:${folder}:${own.id}`;
  const claim = (mark: number) => `nl:traffic:spike:${folder}:${own.id}:${mark}`;
  const limit = publicVisitLimit(requestLimitFor(shop, early / 1000));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  // A hold that crosses the nine-tenths mark and goes past the window: refused and given back, so it rang nothing.
  const below = markCount(limit, 0.9) - 1;
  redis.run(["SET", requests, String(below), "EX", 100_000]);
  const held = await holdPublicRequests(shop, limit - below + 1, early);
  await settle();
  is("the hold past the window is refused", held, false);
  is("and given back: the window's count is as it was", redis.run(["GET", requests]), String(below));
  is("a count given back rings nothing: no claim on the mark", redis.run(["GET", claim(2)]), null);

  // A request that crosses the half mark early and stays counted: answered at once, the alarm after it.
  redis.run(["SET", requests, String(markCount(limit, 0.5) - 1), "EX", 100_000]);
  const plain = redis.pipeline.bind(redis);
  let release: () => void = () => {};
  const hanging = new Promise<void>((resolve) => (release = resolve));
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => String(command[1] ?? "").startsWith("nl:traffic:spike:"))) await hanging;
    return plain(commands);
  }) as typeof redis.pipeline;
  const answered = await Promise.race([takePublicRequest(shop, "public", early, 1, { shared: true }), new Promise((resolve) => setTimeout(() => resolve("waited"), 1_000))]);
  is("the request is answered while the alarm's claim still waits", answered, true);
  is("its count stays", redis.run(["GET", requests]), String(markCount(limit, 0.5)));
  release();
  await settle();
  redis.pipeline = plain;
  is("and the alarm still ran after it: the mark is claimed", redis.run(["GET", claim(0)]), "1");

  done();
}

main();
