/** Disposable test build only. The real transport still validates its exact
 * review, credentials, usage and dispatch receipt. The ACK adapter here is
 * synthetic; the separate required Redis suites prove the exact budget Lua.
 * No production module imports this file. No environment or HTTP flag can
 * select it in a production build.
 */
import { currentResendFallbackProofIsMissing as realProofIsMissing, guardedResendPost as realPost, type ResendPost, type ResendTransportRuntime } from "../../lib/resend-fallback-transport";
import { prepareResendFallbackFixture } from "../resend-fallback-fixture";
export type { ResendTransportRuntime } from "../../lib/resend-fallback-transport";

const keys = ["re_local_only_a_stand_in", "re_test_security_journey_only_a_stand_in",
  "re_test_person_erasure_only_a_stand_in", "re_test_closed_store_only_a_stand_in"] as const;
const fixtures = new Map<string, ReturnType<typeof prepareResendFallbackFixture>>();
function fixtureFor(credential: string, usageCredential: string) {
  const identity = `${credential}\n${usageCredential}`;
  let fixture = fixtures.get(identity);
  if (!fixture) {
    fixture = prepareResendFallbackFixture({ credential, usageCredential,
      accountId: "SYNTHETIC_DISPOSABLE_BROWSER_ACCOUNT", fetch: (request, init) => fetch(request, init) });
    fixtures.set(identity, fixture);
  }
  return fixture;
}
export function currentResendFallbackProofIsMissing(runtime: ResendTransportRuntime = {}) {
  if (Object.keys(runtime).length) return realProofIsMissing(runtime);
  const credential = keys.find(known => known === process.env.RESEND_API_KEY?.trim());
  const usageCredential = keys.find(known => known === (process.env.RESEND_READ_API_KEY?.trim() || credential));
  if (!credential || !usageCredential) return true;
  return realProofIsMissing(fixtureFor(credential, usageCredential).runtime);
}
export async function guardedResendPost(input: ResendPost, runtime: ResendTransportRuntime = {}) {
  if (Object.keys(runtime).length) return realPost(input, runtime);
  // Only the four literal credentials in these disposable journeys are known.
  // Accidentally pointing this build at a real account never authorizes POST.
  const credential = keys.find(known => known === input.credential);
  const usageCredential = keys.find(known => known === input.usageCredential);
  if (!credential || !usageCredential ||
      !/^http:\/\/127\.0\.0\.1:\d+$|^https:\/\/api\.resend\.com$/.test(input.base)) return { kind: "blocked" as const };
  const fixture = fixtureFor(credential, usageCredential);
  await fixture.ready;
  return realPost(input, fixture.runtime);
}
