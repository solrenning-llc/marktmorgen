/**
 * Rule 30 (Claude 4 D MEDIUM on #3733): the voice route's catch logged the whole
 * error of a model call made with customers' texts. When summing up fails, the
 * log carries a fixed label only, never the error's message or stack.
 * Called as the studio calls it, with a real session, on the in-memory store;
 * makeVoice is the real module's except that it throws (tests/voice-route-log-world.ts).
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/voice/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { LEAK } from "./voice-route-log-world";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const OWNER = "voicelog@example.com";
globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "voicelog", "Voice Log", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const logged: unknown[][] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  let status = 0;
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/voice", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: "{}" }));
    status = response.status;
  } finally {
    console.error = previous;
  }
  is("the failure still answers 500", status, 500);
  is("it is logged once", logged.length, 1);
  const text = logged.flat().map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : String(value))).join("\n");
  is("the log never carries what customers wrote", text.includes(LEAK) || text.includes("lee@example.org"), false);
  is("it says what failed", text.includes("summing up what customers say failed"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
