/**
 * CX-123 rule 24 on the page a team invitation lands on
 * (app/signin/join/page.tsx, peekInvite in lib/team.ts): the invitation read
 * in an unknown shape, or a read behind it that failed (the store, the team),
 * is unknown, never "That invitation no longer works". The page then sends
 * the person to the honest "Joining did not finish / Nothing was changed",
 * as app/api/auth/join already does when the same read throws.
 */
import { createHash } from "node:crypto";
import JoinPage from "@/app/signin/join/page";
import { peekInvite } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const TOKEN = "c".repeat(64);
const MISSING = "d".repeat(64);
const inviteKey = (token: string) => `nl:team:invite:${createHash("sha256").update(`nimbus-team-invite:${token}`).digest("hex").slice(0, 40)}`;
const isInviteRead = (batch: Command[]) => batch.length === 1 && batch[0][0] === "GET" && String(batch[0][1]).startsWith("nl:team:invite:");
/** The GET of the invitation answered with `reply`; every other command as kept. */
function inviteAnswers(reply: unknown): void {
  redis.pipeline = (async (batch: Command[]) => (isInviteRead(batch) ? reply : real(batch))) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real as typeof redis.pipeline;
};

async function outcome(token: string): Promise<string> {
  try {
    return (await peekInvite(token)) === null ? "none" : "read";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  }
}

/** Where the page sends the person (its redirect), or "page" when it renders. */
async function landing(token: string): Promise<string> {
  try {
    await JoinPage({ searchParams: Promise.resolve({ token }) });
    return "page";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    return digest.startsWith("NEXT_REDIRECT") ? digest.split(";")[2] : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await real([["SET", inviteKey(TOKEN), JSON.stringify({ sid: "5".repeat(32), id: "1".repeat(16), email: "ada@example.com", role: "editor" })]]);
  is("an invitation nobody has is none", await outcome(MISSING), "none");
  is("and the page says it no longer works", await landing(MISSING), "/signin?status=invite-expired");

  part("The invitation in an unknown shape is unknown, never 'no longer works'");
  const shapes: [string, unknown][] = [
    ["a cut-short pipeline", []],
    ["a number", [7]],
    ["an object", [{ sid: "s" }]],
    ["a list", [["x"]]],
    ["not a list at all", { 0: null }],
  ];
  for (const [name, reply] of shapes) {
    inviteAnswers(reply);
    is(`${name}: peekInvite is unknown`, await outcome(TOKEN), "unknown");
    is(`${name}: the page says the invitation could not be read (#2969), never that it expired`, await landing(TOKEN), "page");
    restore();
  }

  part("A read behind the invitation that fails is not 'no longer works' either");
  redis.pipeline = (async (batch: Command[]) => {
    if (isInviteRead(batch)) return real(batch);
    throw new Error("Redis request failed with status 503");
  }) as typeof redis.pipeline;
  is("the store or team read failing: peekInvite throws", (await outcome(TOKEN)) === "none", false);
  is("the store or team read failing: the page says it could not be read, never expired", await landing(TOKEN), "page");
  redis.pipeline = (async () => {
    throw new Error("Redis request failed with status 503");
  }) as typeof redis.pipeline;
  is("Redis down: the page says it could not be read, never expired", await landing(TOKEN), "page");
  restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
