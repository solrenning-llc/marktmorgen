/**
 * The courses job says when the sweep of assignment uploads failed (#4279, Codex U through Claude 1): a rejected
 * sweepTaskUploads was turned into "0 swept", so the run answered `unusedUploads: 0` with nothing to tell it from a
 * sweep that found nothing. It now answers `unusedUploads: null` and `uploadsFailed: true`, as the community-picture
 * sweep beside it already does. The real cron route, called as Vercel calls it locally; Redis is tests/redis-stub.ts,
 * made to fail the sweep's read of its list. Synthetic only.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { GET as coursesCron } from "@/app/api/cron/courses/route";
import { done, is, part } from "./check";

const realPipeline = redis.pipeline.bind(redis);
Object.assign(process.env, { RESEND_API_KEY: "re_test_cron_courses_uploads_failed" });
delete process.env.CRON_SECRET;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Answer = { ok: boolean; unusedUploads?: number | null; uploadsFailed?: boolean; unusedPictures?: number | null };
const run = async () => (await (await coursesCron(new NextRequest("https://local.example/api/cron/courses"))).json()) as Answer;

async function main() {
  part("Control: the sweep reads its list and finds nothing");
  redis.clear();
  const quiet = await run();
  is("0 swept, no failure said", [quiet.ok, quiet.unusedUploads, quiet.uploadsFailed ?? false], [true, 0, false]);

  part("#4279: the sweep's list cannot be read");
  redis.clear();
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === "nl:tasks:doors")) throw new Error("synthetic: Redis request timed out");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const failed = await run();
  redis.pipeline = realPipeline;
  is("never \"0 swept\": unusedUploads is null", failed.unusedUploads, null);
  is("and the failure is said", failed.uploadsFailed, true);
  done();
}
main();
