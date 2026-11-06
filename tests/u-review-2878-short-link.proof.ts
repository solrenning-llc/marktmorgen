import { createHash } from "node:crypto";
import { GET } from "@/app/l/[code]/route";
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "u-review-2878@example.com";
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

const open = async (code: string) => {
  const answer = await GET(new Request(`https://marktmorgen.com/l/${code}`) as never, { params: Promise.resolve({ code }) });
  return {
    status: answer.status,
    location: answer.headers.get("location") ?? "",
    cache: answer.headers.get("cache-control") ?? "",
  };
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "u-review-2878", "Review Store", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const made = await addLink(
    { sid: store.sid, statsId: store.statsId! },
    { name: "Live post", place: "instagram", target: { kind: "store" } },
    () => false,
    1_000,
  );
  if (!made.ok) throw new Error("the control link was not made");

  part("healthy live link");
  const healthy = await open(made.link.code);
  is("opens the live store", [healthy.status, healthy.location.includes("/@u-review-2878")], [302, true]);

  part("unknown store record is temporary, never an ended link cached by the CDN");
  const pipeline = redis.pipeline.bind(redis);
  const key = ownerKey(OWNER);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    return answer.map((value, index) => commands[index]?.[0] === "GET" && commands[index]?.[1] === key ? "{cut" : value);
  }) as typeof redis.pipeline;
  const unknown = await open(made.link.code);
  redis.pipeline = pipeline;
  is("answers a temporary failure", unknown.status, 503);
  is("does not redirect to the ended-link page", unknown.location, "");
  is("does not cache the false answer", unknown.cache, "private, no-store");

  part("the link and store remain healthy");
  const after = await open(made.link.code);
  is("opens again after the read recovers", [after.status, after.location.includes("/@u-review-2878")], [302, true]);
  done();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
