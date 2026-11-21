/**
 * A store's list batch whose figure was taken in one billing window and given back after that window ended is given
 * back into the window it was taken from, never into the new one (Codex N1's LOW 2 on #3926). lib/email.ts
 * dispatchBatch takes the store's emails before Amazon is asked; when Amazon throttles the batch and takes nobody,
 * the batch waits and the figure is given back. giveAllowance read the window running at the give-back, so a call that
 * crossed the window's end left the old month charged and handed the new month emails it never had.
 *
 * Synthetic only: mocked STS and SES, the Redis stub, a store whose billing month ends while Amazon is asked.
 */
import { sendListBatch } from "@/lib/email";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const REGION = "us-east-1";
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
/** When set, Amazon's answer comes this many milliseconds later, past the window's end. */
let crossBy = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: {
      AccessKeyId: "ASIASYNTHETICONLY0002", SecretAccessKey: "synthetic-secret-for-tests-only-000000", SessionToken: "synthetic-session", Expiration: Math.floor(Date.now() / 1000) + 3_600,
    } } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      shift += crossBy;
      crossBy = 0;
      return json({ message: "Maximum sending rate exceeded." }, 429, { "x-amzn-errortype": "TooManyRequestsException" });
    }
  }
  if (url.hostname === "api.resend.com") throw new Error("list mail must never reach Resend");
  return json({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_window_only_a_stand_in";
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";

  const OWNER = "owner@window.example";
  await claimHandle(OWNER, "windowshop", "Window Shop", "");
  await ensureStatsId(OWNER);
  // A billing month that ends a minute from now, renewing.
  const at = Math.floor(Date.now() / 1000);
  await setSubscription(OWNER, { customerId: "cus_Window00001", subscriptionId: "sub_Window00001", active: true, tier: "pro", period: { start: at - 29 * 86_400, end: at + 60, renews: true } });
  const store = (await storeForEmail(OWNER))!;
  const before = allowanceWindow(store, Date.now());
  const after = allowanceWindow(store, Date.now() + 120_000);
  if (!before || !after || before.id === after.id) throw new Error(`no window rollover to test: ${before?.id} ${after?.id}`);
  // The store's counter for a window, by lib/store-allowance.ts's own key (sid, else statsId, else handle, hashed).
  const id = createHash("sha256").update(`allowance:${store.sid || store.statsId || store.handle}`).digest("hex").slice(0, 32);
  const counter = async (window: string) => Number((await redis.pipeline([["GET", `nl:allow:email:${id}:${window}`]]))[0] ?? 0);

  part("Control: a batch Amazon takes is counted in the window it was taken from");
  const sent = await sendListBatch([], "list:none", { by: "store", store, kind: "email" });
  is("an empty batch sends nothing and counts nothing", [sent, await counter(before.id)], ["sent", 0]);

  part("A list batch taken before the window ends and given back after it");
  const letter = { from: "Window Shop <shop@marktmorgen.com>", to: "reader@example.com", subject: "News", text: "Hi.", html: "<p>Hi.</p>" };
  crossBy = 120_000;
  const outcome = await sendListBatch([letter], "list:window-cross", { by: "store", store, kind: "email" });
  is("Amazon throttled it and took nobody: it waits", outcome, "waiting");
  is("the window it was taken from is given its email back", await counter(before.id), 0);
  is("the new window is not handed an email it never had", await counter(after.id), 0);
  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
