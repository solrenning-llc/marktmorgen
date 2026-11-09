/**
 * The reminder after a checkout left unpaid (lib/checkout-recovery.ts,
 * deliver), under a sender whose answer is not known (rule 30, a sibling of
 * 283 [HG2]'s sendEmailOutcome).
 *
 * The five-minute job (lib/checkout-sweep.ts) looks at every checkout that
 * closed in the last six hours on each pass, so a reminder whose marks are
 * let go is tried again up to some seventy times. A timeout, a server error
 * or a network error after the request may have reached the sender can mean
 * the email went: its marks are then kept, so no later pass writes to the
 * buyer again, takes another email from the store's figure, or writes
 * another stop link. Only a certain refusal lets them go. Stripe, Amazon SES
 * and Resend are played by a stand-in for `fetch`; no real email is sent.
 * Checked over several passes:
 *
 *   - Resend answers 500: asked once, one email taken from the figure;
 *   - Resend's request throws (network error): the same;
 *   - Resend answers 422 (a certain refusal): tried again on the next pass
 *     and sent then (control: unchanged behavior);
 *   - Amazon took it but its answer was a 500: Amazon asked once, one email
 *     taken from the figure and one stop link written, never Resend;
 *   - Resend refuses for certain on every pass (a 422 for one address, or
 *     the ceiling spent): tried at most three times, so at most three emails
 *     taken from the figure, and the stop link of an email that never went
 *     is taken back (Claude 2's MEDIUM 3 on #3377);
 *   - an error while the reminder is written: nothing was sent, so its marks
 *     and its stop link go and the next pass sends it (Claude 2's LOW on
 *     #3377, the sibling of the call reminders' fix).
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { remindAbandoned } from "@/lib/checkout-recovery";
import { givingWords } from "@/lib/buyer-words/giving";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const REGION = "us-east-1";
const OWNER = "potter@example.com";
const PASSES = 4;

/** Every recipient Resend was asked for, taken or not. */
const resendAsked: string[] = [];
/** Every recipient Amazon was asked for, taken or not. */
const amazonAsked: string[] = [];
/** How Resend answers one recipient, when not plainly yes. */
let resendSays: (to: string) => (() => Response) | null = () => null;
/** Amazon takes every email; for these it then answers a 500, so whether it was taken is not known. */
const amazonLoses = new Set<string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    resendAsked.push(to);
    const special = resendSays(to);
    if (special) return special();
    return answer({ id: `email_${resendAsked.length}` });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      return answer({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 100, SentLast24Hours: 0 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      const to = (JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } }).Destination.ToAddresses[0];
      amazonAsked.push(to);
      if (amazonLoses.has(to)) return answer({ message: "synthetic server error after acceptance" }, 500);
      return answer({ MessageId: `m-${amazonAsked.length}` });
    }
    return answer({}, 404);
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const credentials = { AccessKeyId: "ASIAEXAMPLELENT0001", SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: "session-token-1", Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return answer({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function answerOf(status: number): Response {
  return new Response(JSON.stringify({ message: status >= 500 ? "internal" : "invalid recipient" }), { status });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_uncertain_recovery_only";
  process.env.RESEND_API_KEY = "re_test_recovery_journey_only";
  for (const name of ["AWS_SES_ROLE_ARN", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN"]) delete process.env[name];

  await claimHandle(OWNER, "clayworks", "Clay Works", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClay00002", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Recipes", "", "24", null);
  if (!made.ok) throw new Error("no product");
  const glaze = made.product.id;
  await setProductLink(OWNER, glaze, `https://example.com/${glaze}`);
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
  const load = async () => (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, email: string) =>
    ({
      id,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email },
      metadata: { store: "clayworks", product: glaze },
    }) as never;
  /** The five-minute job's passes over the same closed checkout, inside its six-hour window. */
  const passes = async (id: string, email: string) => {
    const outcomes: string[] = [];
    for (let i = 0; i < PASSES; i += 1) outcomes.push(await remindAbandoned(await load(), left(id, email)));
    return outcomes;
  };
  const resendOf = (email: string) => resendAsked.filter((to) => to === email).length;
  const links = () => redis.keys().filter((key) => key.startsWith("nl:recover:link:")).length;

  part("Resend's answer not known: never sent twice");
  resendSays = (to) => {
    if (to === "una@example.com") return () => answerOf(500);
    if (to === "tom@example.com") return () => {
      throw new TypeError("fetch failed: the connection was reset");
    };
    return null;
  };
  let used = await allowanceUsed(await load(), "email");
  is("a 500: the first pass is not counted as sent, and the later passes leave it", await passes("cs_test_una00000000001", "una@example.com"), ["failed", "skip", "skip", "skip"]);
  is("asked once", resendOf("una@example.com"), 1);
  is("one email taken from the store's figure", (await allowanceUsed(await load(), "email")) - used, 1);
  used = await allowanceUsed(await load(), "email");
  is("a thrown request: the same", await passes("cs_test_tom00000000001", "tom@example.com"), ["failed", "skip", "skip", "skip"]);
  is("asked once, too", resendOf("tom@example.com"), 1);
  is("and one email taken", (await allowanceUsed(await load(), "email")) - used, 1);

  part("A certain refusal is tried again (control)");
  let refuse = true;
  resendSays = (to) => (to === "rex@example.com" && refuse ? () => answerOf(422) : null);
  is("refused (422)", await remindAbandoned(await load(), left("cs_test_rex00000000001", "rex@example.com")), "failed");
  refuse = false;
  is("the next pass sends it, once", [await remindAbandoned(await load(), left("cs_test_rex00000000001", "rex@example.com")), await remindAbandoned(await load(), left("cs_test_rex00000000001", "rex@example.com")), resendOf("rex@example.com")], ["sent", "skip", 2]);

  part("A certain refusal on every pass: tried three times at most, its unsent stop links taken back");
  resendSays = (to) => (to === "sal@example.com" ? () => answerOf(422) : null);
  used = await allowanceUsed(await load(), "email");
  let linksBefore = links();
  const sixPasses: string[] = [];
  for (let i = 0; i < 6; i += 1) sixPasses.push(await remindAbandoned(await load(), left("cs_test_sal00000000001", "sal@example.com")));
  is("refused three times, then left", sixPasses, ["failed", "failed", "failed", "skip", "skip", "skip"]);
  is("Resend asked three times, not once a pass", resendOf("sal@example.com"), 3);
  is("three emails taken from the store's figure, not one a pass", (await allowanceUsed(await load(), "email")) - used, 3);
  is("no stop link kept for an email that never went", links() - linksBefore, 0);
  is("another checkout of the same address and product is not held back a week", [await (async () => { resendSays = () => null; return remindAbandoned(await load(), left("cs_test_sal00000000002", "sal@example.com")); })(), resendOf("sal@example.com")], ["sent", 4]);

  part("An error while the reminder is written: nothing sent, so the next pass sends it");
  const words = givingWords("en");
  const price = words.recoverPrice;
  words.recoverPrice = () => {
    throw new Error("synthetic: the reminder could not be written");
  };
  linksBefore = links();
  let broken: string;
  try {
    broken = await remindAbandoned(await load(), left("cs_test_wyn00000000001", "wyn@example.com"));
  } catch (error) {
    broken = `threw: ${(error as Error).message}`;
  } finally {
    words.recoverPrice = price;
  }
  is("not sent, and said as a failure", [broken, resendOf("wyn@example.com"), links() - linksBefore], ["failed", 0, 0]);
  is("the next pass sends it, once", [await remindAbandoned(await load(), left("cs_test_wyn00000000001", "wyn@example.com")), await remindAbandoned(await load(), left("cs_test_wyn00000000001", "wyn@example.com")), resendOf("wyn@example.com"), links() - linksBefore], ["sent", "skip", 1, 1]);

  part("Amazon took it, its answer lost: one email from the figure, not one a pass");
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-recovery";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  resendSays = () => null;
  amazonLoses.add("ivy@example.com");
  used = await allowanceUsed(await load(), "email");
  linksBefore = links();
  is("not counted as sent; the later passes leave it", await passes("cs_test_ivy00000000001", "ivy@example.com"), ["failed", "skip", "skip", "skip"]);
  is("Amazon was asked once and Resend never", [amazonAsked.filter((to) => to === "ivy@example.com").length, resendOf("ivy@example.com")], [1, 0]);
  is("one email taken from the store's figure, not one a pass", (await allowanceUsed(await load(), "email")) - used, 1);
  is("one stop link written, not one a pass", links() - linksBefore, 1);

  part("Amazon's plain yes (control)");
  used = await allowanceUsed(await load(), "email");
  is("sent once", [await passes("cs_test_ola00000000001", "ola@example.com"), amazonAsked.filter((to) => to === "ola@example.com").length], [["sent", "skip", "skip", "skip"], 1]);
  is("one email taken", (await allowanceUsed(await load(), "email")) - used, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
