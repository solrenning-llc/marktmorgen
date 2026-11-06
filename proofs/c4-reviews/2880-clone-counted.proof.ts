/**
 * Review of #2880 (d3977d57): app/api/store/funnel-share/route.ts answers
 * unread(action !== "clone"), i.e. "nothing was counted" for every clone.
 * But clone counts the month's import (countUse, route line ~273) BEFORE
 * importBundle, and importBundle -> receiverOf -> readForms reads again: when
 * that read throws UnknownReply (as #2857's readForms will, which this PR
 * says it refuses), the creator is told "funnel_unread" (no "this try still
 * counts") while the import was counted. (The words also say "part of this
 * funnel" while it was the store's own form list that could not be read.)
 * Synthetic store; only the forms HVALS read after the import count throws.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { UnknownReply } from "@/lib/redis-exact";
import { POST } from "@/app/api/store/funnel-share/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "rev2880-clone@example.com";
const URL = "https://marktmorgen.com/api/store/funnel-share";
type Command = (string | number)[];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  await claimHandle(OWNER, "rev2880clone", "Rev 2880", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest(URL, { method: "POST", headers, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const made = await post({ action: "import", starter: "coaching-application", products: {} });
  if (made[0] !== 200) throw new Error(`setup: ${JSON.stringify(made)}`);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const funnel = (await readPageFunnels(statsId))[0];
  const importKeys = () => redis.keys().filter((k) => k.startsWith(`nl:fuse:m:import:${statsId}:`));
  await redis.pipeline([["DEL", ...importKeys()]]);

  const real = redis.pipeline.bind(redis);
  let counted = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (batch.some((c) => String(c[1] ?? "").startsWith(`nl:fuse:m:import:${statsId}:`))) counted = true;
    if (counted && batch.some((c) => c[0] === "HVALS" && c[1] === `nl:forms:${statsId}`)) throw new UnknownReply("the store's forms");
    return real(batch);
  }) as typeof redis.pipeline;
  let answer: unknown[];
  try {
    answer = await post({ action: "clone", funnel: funnel.id });
  } finally {
    redis.pipeline = real;
  }
  part("A clone whose import was counted, then a read inside importBundle is unknown");
  const [count] = await real([["GET", importKeys()[0] ?? "nl:none"]]);
  is("the import was counted", count, "1");
  is("so the creator is told the try still counts", answer, [503, "funnel_unread_counted"]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
