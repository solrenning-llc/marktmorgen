/**
 * Removing an ad spend line answers "removed" only once the line is confirmed
 * gone (issue #4434): a removal Redis does not confirm, or a line that is
 * still there afterwards, is an error the owner can retry, never ok:true over
 * a line that still counts in the result after ads.
 */
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/spend/route";
import { addSpend, readSpends } from "@/lib/ad-spend";
import { spendStore } from "./ad-spend-remove-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const statsId = spendStore.statsId as string;
const now = Date.UTC(2026, 10, 13, 12);
const day = "2026-11-12";
const realPipeline = redis.pipeline.bind(redis);

async function seed(): Promise<string> {
  redis.clear();
  redis.pipeline = realPipeline as typeof redis.pipeline;
  const added = await addSpend(statsId, { channel: "instagram", campaign: "spring", cents: 2500, from: day, to: day }, now);
  if (!added.ok) throw new Error("seeding the spend failed");
  return added.spends[0].id;
}

async function remove(id: string) {
  const request = new Request("https://marktmorgen.com/api/store/spend", { method: "POST", body: JSON.stringify({ action: "remove", id }) });
  const response = await POST(request as unknown as NextRequest);
  const json = (await response.json()) as { ok: boolean; error?: string; spends?: unknown[] };
  redis.pipeline = realPipeline as typeof redis.pipeline;
  return { response, json };
}

async function main() {
  part("a removal Redis answers without a result is not reported as done");
  {
    const id = await seed();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "HDEL")) return commands.map(() => undefined);
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    const { response, json } = await remove(id);
    is("the line is still saved", (await readSpends(statsId)).length, 1);
    is("the answer is not ok", json.ok, false);
    is("the status is an error", response.status >= 400, true);
    is("the error says the removal is unconfirmed", json.error, "unconfirmed");
    is("no list is handed back as the new state", json.spends, undefined);
  }

  part("a removal whose check afterwards cannot be read is not reported as done");
  {
    const id = await seed();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "HEXISTS")) return commands.map(() => null);
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    const { response, json } = await remove(id);
    is("the answer is not ok", json.ok, false);
    is("the status is an error", response.status >= 400, true);
  }

  part("a confirmed removal still answers ok with the list after");
  {
    const id = await seed();
    const { response, json } = await remove(id);
    is("the answer is ok", json.ok, true);
    is("the status is 200", response.status, 200);
    is("the list after is empty", json.spends?.length, 0);
    is("the line is gone", (await readSpends(statsId)).length, 0);
  }

  done();
}

void main();
