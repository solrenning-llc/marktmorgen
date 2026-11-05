/** Report evidence only: an unavailable SES quota is not unlimited sending. */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { verifyAmazonAccount } from "@/lib/verify-mail";
import { sesState, type SesState } from "@/lib/ses";

async function main(): Promise<void> {
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-quota-report";
  process.env.AWS_SES_REGION = "us-east-1";
  process.env.AWS_SES_CONFIGURATION_SET = "synthetic-quota-report";
  process.env.AWS_SES_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:synthetic-quota-report";
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("This cached-state reporting proof must not call a provider");
  }) as typeof fetch;
  try {
    const report = async (fields: Pick<SesState, "ready" | "why" | "max24" | "rate">) => {
      redis.clear();
      const state: SesState = { ...fields, at: Math.floor(Date.now() / 1000), hold: 0 };
      redis.run(["SET", "nl:ses:state", JSON.stringify(state)]);
      const observed = await sesState();
      is("the actual SES reader retains this current account observation",
        observed && [observed.ready, observed.why, observed.rate, observed.max24, observed.at, observed.hold],
        [state.ready, state.why, state.rate, state.max24, state.at, state.hold]);
      const checks = await verifyAmazonAccount();
      is("one account check, with no additional delivery probe", checks.length, 1);
      return checks[0];
    };

    part("Known finite and explicitly unlimited quota controls");
    const finite = await report({ ready: true, why: "", max24: 50_000, rate: 14 });
    is("a known finite daily quota retains the original wording", finite.detail, "sending through Amazon: 50,000 emails in 24 hours, 14 a second");
    const unlimited = await report({ ready: true, why: "", max24: -1, rate: 14 });
    is("only the documented negative-one sentinel says no limit", unlimited.detail.includes("no limit"), true);

    part("Unconfirmed quota remains unknown in the owner's diagnostic");
    const unknown = await report({ ready: false, why: "quota", max24: 0, rate: 0 });
    is("the unknown daily quota is not called unlimited", unknown.detail.includes("no limit"), false);
    is("the diagnostic explicitly identifies the quota as unknown", /unknown/i.test(unknown.detail), true);
    is("the diagnostic retains the account's refusal reason", unknown.detail.startsWith("not sending through Amazon yet (quota);"), true);
    is("no report or control contacted a real provider", providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    redis.clear();
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
