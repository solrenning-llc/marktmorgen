/**
 * #2608 LOW (Claude 4 F1 / Claude 1): a place in a group purchase is asked with a
 * form that may send an email. Past the connection's limit the page says "slow";
 * a counter that cannot be read is "unavailable", never "slow down" (rule 24).
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/group/route";
import { claimHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const real = redis.pipeline.bind(redis);
let how: "full" | "unknown" | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hit = how && commands.find((c) => String(c[1] ?? "").startsWith("nl:rl:group-place:"));
  if (hit && how === "unknown") throw new Error("Redis timed out (synthetic)");
  if (hit) await real([["SET", String(hit[1]), "1000000000", "EX", 600]]);
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("groupplace@example.com", "groupplace", "Group Place", "");
  const id = "grp_" + "a".repeat(24);
  const ask = async () => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/group", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "203.0.113.9" }, body: new URLSearchParams({ handle: "groupplace", group: id, email: "lee@example.org" }) }));
    return new URL(response.headers.get("location") ?? "https://x/").searchParams.get("status");
  };
  how = "full";
  is("past the connection's limit the page says slow", await ask(), "slow");
  how = "unknown";
  is("an unreadable count is unavailable, never slow", await ask(), "unavailable");
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
