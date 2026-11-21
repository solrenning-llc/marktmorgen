/**
 * Where a team invitation lands (app/signin/join/page.tsx) never sends the
 * person to "That invitation expired" because it could not be read just now
 * (nothing false shown to a person). An invitation that truly is not there
 * still goes to the expired notice; a read that fails says the invitation
 * could not be read just now.
 */
import { renderToStaticMarkup } from "react-dom/server";
import JoinPage from "@/app/signin/join/page";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { createHash } from "node:crypto";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];


const EXPIRED = "/signin?status=invite-expired";
const UNREAD = "could not be read just now";

/** The page as HTML, or where it sent the person. */
async function open(token: string): Promise<string> {
  try {
    return renderToStaticMarkup(await JoinPage({ searchParams: Promise.resolve({ token }) }));
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    return `crashed ${String(error)}`;
  }
}

async function failing<T>(work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((command) => String(command[1] ?? "").startsWith("nl:team:invite:"))) throw new Error("connection reset");
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const CREATOR = "creator@honest-join.example";
  await claimHandle(CREATOR, "honest-join", "Honest Join", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1HonestJoinXXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_honestjoin", subscriptionId: "sub_honestjoin", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  // The invitation as lib/team.ts inviteMember keeps it: a hash of the link, and the invite on the team.
  const token = "c".repeat(64);
  const id = createHash("sha256").update(`nimbus-team-invite-id:${token}`).digest("hex").slice(0, 16);
  const inviteKey = `nl:team:invite:${createHash("sha256").update(`nimbus-team-invite:${token}`).digest("hex").slice(0, 40)}`;
  const email = "helper@honest-join.example";
  await redis.pipeline([
    ["SET", inviteKey, JSON.stringify({ sid: shop.sid, id, email, role: "editor" })],
    ["SET", `nl:team:${shop.sid}`, JSON.stringify({ members: [], invites: [{ id, email, role: "editor", createdAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 86_400 }] })],
  ]);

  part("Healthy control");
  const healthy = await open(token);
  is("the store and the button", [healthy.includes("Join Honest Join"), healthy.includes("Join the team")], [true, true]);

  part("Confirmed absence stays honest");
  is("an invitation that is not there: the expired notice", await open("f".repeat(64)), `redirect ${EXPIRED}`);

  part("A read that fails is never 'expired'");
  const failed = await failing(() => open(token));
  is("not sent to the expired notice", failed === `redirect ${EXPIRED}`, false);
  is("said as not read just now, and nothing taken", [failed.includes(UNREAD), failed.includes("Join the team")], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
