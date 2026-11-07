/**
 * A store's record that could not be read is not a store that does not exist
 * (rule 24, after #2878 made storeForEmail/storeForId throw on an unknown
 * reply). A caller that turns that throw into `null` decides on "no store":
 * here, the partnership invitation (app/api/store/affiliates/route.ts,
 * action "invite") asks whether the invited address already has a store
 * here, to leave the offer in that creator's studio instead of an inbox. A
 * failed read used to send the inbox link to somebody who has a store; now
 * nothing is sent, nothing is written, and the creator is told to try again.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

// A stand-in for the email service: nothing leaves the machine.
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    mails.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerKey = (email: string) => `nl:store:owner:${sha(`nimbus-store:${email.toLowerCase()}`).slice(0, 40)}`;

/** How the invited address's own record is read: as it is, failing, or answered in a shape that says nothing. */
let theirRead: "real" | "throws" | "no-reply" = "real";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_store_null_callers_stand_in";
  const owner = "inviter@example.com";
  const invited = "partner@example.com";
  await claimHandle(owner, "invitershop", "Inviter Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Invitexxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_inv", subscriptionId: "sub_inv", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {} });
  await claimHandle(invited, "partnershop", "Partner Shop", "");

  const theirKey = ownerKey(invited);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const asksTheirs = commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === theirKey;
    if (asksTheirs && theirRead === "throws") throw new Error("redis: connection reset");
    if (asksTheirs && theirRead === "no-reply") return [];
    return real(commands);
  }) as typeof redis.pipeline;

  const session = await openSession(owner);
  const invite = async () => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "invite", email: invited, percent: 20, products: ["prodaaaaaa"] }),
    }));
    const body = (await response.json()) as { ok?: boolean; error?: string; waiting?: boolean };
    return { status: response.status, ok: body.ok ?? false, error: body.error ?? null, waiting: body.waiting ?? null };
  };
  const links = async () => {
    const [reply] = await real([["SCAN", 0, "MATCH", "nl:aff:link:*", "COUNT", 10_000]]);
    return Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1].length : -1;
  };

  for (const mode of ["throws", "no-reply"] as const) {
    part(`The invited address's store could not be read (${mode})`);
    theirRead = mode;
    const before = mails.length;
    const linksBefore = await links();
    const got = await invite();
    is("the creator is told it did not go through, to try again", [got.ok, got.status, got.error], [false, 500, "server_error"]);
    is("no email is sent", mails.length - before, 0);
    is("no inbox link is written", (await links()) - linksBefore, 0);
    theirRead = "real";
    is("no offer is left in a studio either", (await waitingFor(invited)).length, 0);
  }

  part("Control: read as it is, the offer waits in their studio");
  theirRead = "real";
  const linksBefore = await links();
  const got = await invite();
  is("it waits in the studio", [got.ok, got.waiting], [true, true]);
  is("no inbox link for somebody who has a store here", (await links()) - linksBefore, 0);
  is("the offer is there", (await waitingFor(invited)).length, 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
