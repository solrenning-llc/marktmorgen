/** Codex K2 on #2880 (codex/k-review-2880-note-funnel d24a56ff, credit kept): the real clone route must say an import attempt was counted when it was. Synthetic transport only. */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { UnknownReply } from "@/lib/redis-exact";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST } from "@/app/api/store/funnel-share/route";
import { store as redis } from "@/tests/redis-stub";
import { done, is, part } from "@/tests/check";

const OWNER = "k2-funnel-review@example.com";
const URL = "https://marktmorgen.com/api/store/funnel-share";
const COMMAND_CEILING = 10_000;
let commandsUsed = 0;
let forbiddenFetches = 0;
const actualPipeline = redis.pipeline.bind(redis);
redis.pipeline = async commands => {
  if (commandsUsed + commands.length > COMMAND_CEILING) throw new Error("Synthetic command ceiling exceeded before dispatch");
  commandsUsed += commands.length;
  return actualPipeline(commands);
};
globalThis.fetch = async () => { forbiddenFetches++; throw new Error("External fetch forbidden"); };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "k2funnelreview", "Synthetic review", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (body: Record<string, unknown>) => {
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > 4096) throw new Error("Request exceeds admitted body ceiling");
    const response = await POST(new NextRequest(URL, { method: "POST", headers, body: json }));
    return { status: response.status, body: await response.json() as { error?: string; ok?: boolean } };
  };
  const setup = await post({ action: "import", starter: "coaching-application", products: {} });
  if (setup.status !== 200) throw new Error(`Setup failed before evidence: ${JSON.stringify(setup)}`);
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const funnel = (await readPageFunnels(statsId))[0];
  if (!funnel) throw new Error("No synthetic source funnel");

  const scenarios = ["known", "source-unread", "receiver-unread"] as const;
  for (const scenario of scenarios) {
    part(scenario);
    const counts = redis.keys().filter(key => key.startsWith("nl:fuse:"));
    if (counts.length) await redis.pipeline([["DEL", ...counts]]);
    const before = await storeForEmail(OWNER);
    const heldFunnels = await readPageFunnels(statsId);
    const base = redis.pipeline.bind(redis);
    let hits = 0;
    redis.pipeline = async commands => {
      const replies = await base(commands);
      const [command] = commands;
      if (commands.length === 1 && (
        scenario === "source-unread" && command[0] === "HGET" && command[1] === `nl:pfunnels:${statsId}` && command[2] === funnel.id ||
        scenario === "receiver-unread" && command[0] === "HVALS" && command[1] === `nl:forms:${statsId}`
      )) {
        hits++;
        if (scenario === "source-unread") throw new UnknownReplyError("the selected source funnel");
        throw new UnknownReply("the destination form inventory");
      }
      return replies;
    };
    let result: Awaited<ReturnType<typeof post>>;
    try { result = await post({ action: "clone", funnel: funnel.id }); }
    finally { redis.pipeline = base; }
    const countKeys = redis.keys().filter(key => key.startsWith(`nl:fuse:m:import:${statsId}:`));
    const importCounts = countKeys.length ? await redis.pipeline(countKeys.map(key => ["GET", key])) : [];
    const after = await storeForEmail(OWNER);
    const afterFunnels = await readPageFunnels(statsId);
    is("selected read was actually intercepted", hits, scenario === "known" ? 0 : 1);
    is("HTTP distinguishes known success from unread input", result.status, scenario === "known" ? 200 : 503);
    is("reply describes whether this import attempt was counted", result.body.error ?? "ok", scenario === "known" ? "ok" : scenario === "source-unread" ? "funnel_unread" : "funnel_unread_counted");
    is("actual import counter agrees with source-versus-receiver stage", importCounts, scenario === "source-unread" ? [] : ["1"]);
    is("unread inputs make no pages", after!.sitePages.length - before!.sitePages.length, scenario === "known" ? 2 : 0);
    is("unread inputs make no funnel", afterFunnels.length - heldFunnels.length, scenario === "known" ? 1 : 0);
    is("no external fetch attempted", forbiddenFetches, 0);
    console.log("OBSERVATION", JSON.stringify({ scenario, result, importCounts, hits, commandsUsed }));
  }
  console.log("BOUNDS", JSON.stringify({ commandsUsed, commandCeiling: COMMAND_CEILING, localPosts: 4, postBytes: 4096, forbiddenFetches }));
  done();
}
void main();
