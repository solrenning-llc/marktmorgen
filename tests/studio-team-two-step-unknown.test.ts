/**
 * CX-123 rule 24, app/studio/team/page.tsx: the review before the owner turns on two-step login for the team says
 * who "has no second step yet". A teammate whose passkey list answers out of shape (lib/passkeys.ts throws
 * UnknownReplyError) is unknown, never "none": the page must not name them as lacking a second step, and must not
 * tell the owner they "logged in without your passkey or app code" when their own second step could not be read.
 * The switch then waits, with the page's own "cannot be changed right now" line, as it already does for the preview,
 * and the rule's current state, which is known from the team record, is still said above that line.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); one reply is made malformed on purpose.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import StudioTeamPage from "@/app/studio/team/page";
import { TeamTwoStepSwitch } from "@/components/team-two-step-switch";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "team-two-step-unknown@example.test";
const MATE = "mate-two-step-unknown@example.test";
const passkeyList = (email: string) => `nl:pk:${createHash("sha256").update(`nimbus-passkeys:${email}`).digest("hex").slice(0, 40)}`;

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function find(node: unknown, type: unknown): Node["props"] | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as Node;
    return n.type === type ? n.props : find(n.props?.children, type);
  }
  return undefined;
}

function words(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join(" ");
  if (node && typeof node === "object") return words((node as Node).props?.children);
  return "";
}

async function render(malformed: string[]) {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "GET" && malformed.includes(String(c[1])))) {
      // A reply of the wrong type for a passkey list: unknown, not "no passkeys".
      return commands.map(() => 7 as unknown as string);
    }
    return original(commands);
  };
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/team", { headers: { cookie } }));
    return await StudioTeamPage({ searchParams: Promise.resolve({}) } as never);
  } finally {
    redis.pipeline = original;
    answering(null);
  }
}

async function main() {
  redis.clear();
  await claimHandle(OWNER, "teamtwostepunknown", "Synthetic team shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TeamTwoStepUnknown", subscriptionId: "sub_TeamTwoStepUnknown", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  is("the teammate is added", await putMember(store, MATE, "editor"), true);

  part("control: every read known");
  const known = await render([]);
  const knownSwitch = find(known, TeamTwoStepSwitch);
  is("the switch is shown", Boolean(knownSwitch), true);
  is("a teammate known to have no second step is named", (knownSwitch?.waiting as string[] | undefined)?.includes(MATE), true);

  part("a teammate's passkey list answers out of shape");
  const mate = await render([passkeyList(MATE)]);
  const mateSwitch = find(mate, TeamTwoStepSwitch);
  is("the teammate is never named as having no second step", Boolean(mateSwitch && (mateSwitch.waiting as string[]).includes(MATE)), false);
  is("the page says the switch cannot be changed right now", words(mate).includes("This cannot be changed right now"), true);
  is("the page still says the rule is off", words(mate).includes("Off: team members may log in with the emailed link alone."), true);

  part("the owner's own passkey list answers out of shape");
  const own = await render([passkeyList(OWNER)]);
  const ownSwitch = find(own, TeamTwoStepSwitch);
  is("the owner is never told how they logged in from an unknown read", Boolean(ownSwitch && ownSwitch.ownerStep !== "live"), false);
  is("the page says the switch cannot be changed right now", words(own).includes("This cannot be changed right now"), true);
  done();
}

void main();
