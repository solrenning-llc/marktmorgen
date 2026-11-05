/** EM1/VR: real routes and real mail guard. Only Redis/provider answers are
 * synthetic. No reviewed production binding or fallback quota is invented. */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as signIn } from "@/app/api/auth/request/route";
import { POST as lost } from "@/app/api/auth/lost/route";
import LostEmailPage from "@/app/signin/lost/page";
import { sendEmail } from "@/lib/email";
import { claimHandle } from "@/lib/store";
import { keepRecoveryAddress, recoveryAddress } from "@/lib/recovery-address";
import { HOUSE_OWNER } from "@/lib/house-store";
import { store } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { createResendFallbackFixture } from "./resend-fallback-fixture";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const credential = "re_SYNTHETIC_AUTH_UNAVAILABLE_ONLY";
let ip = 1;
function signRequest(email: string, extra: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/auth/request`, {
    method: "POST", headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${ip++}` },
    body: JSON.stringify({ email, ...extra }),
  });
}
function lostRequest(email: string) {
  return new NextRequest(`${ORIGIN}/api/auth/lost`, {
    method: "POST", headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${ip++}` },
    body: new URLSearchParams({ email }),
  });
}
const tokenKeys = () => store.keys().filter(k => k.startsWith("nl:auth:link:") || k.startsWith("nl:auth:rec:link:"));
async function main() {
  store.clear();
  process.env.RESEND_API_KEY = credential;
  process.env.NIMBUS_DATA_KEY = "SYNTHETIC_AUTH_UNAVAILABLE_DATA_ONLY";
  delete process.env.VERCEL;
  for (const name of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN"]) delete process.env[name];
  let forbidden = 0;
  globalThis.fetch = async () => { forbidden++; throw Error("No external I/O"); };
  await claimHandle("known@example.test", "knownstore", "Known Store", "");
  await keepRecoveryAddress("known@example.test", "backup@example.test");
  const oldToken = `nl:auth:link:${"c".repeat(40)}`;
  await store.pipeline([["SET", oldToken, "unrelated@example.test", "EX", 900]]);

  part("Known global refusal precedes tokens and recovery-account lookup");
  const signReplies: unknown[] = [], lostReplies: unknown[] = [];
  for (const email of ["known@example.test", "unknown@example.test"]) {
    const response = await signIn(signRequest(email));
    signReplies.push([response.status, await response.json()]);
    const recovery = await lost(lostRequest(email));
    lostReplies.push([recovery.status, recovery.headers.get("location")]);
  }
  is("existing and unknown addresses get the same honest sign-in failure", signReplies,
    [[503, { ok: false, error: "server_error" }], [503, { ok: false, error: "server_error" }]]);
  is("recovery presence never changes the global-unavailable answer", lostReplies,
    [[303, `${ORIGIN}/signin/lost?status=unavailable`], [303, `${ORIGIN}/signin/lost?status=unavailable`]]);
  is("no new token is minted and an unrelated live token is preserved", tokenKeys(), [oldToken]);
  is("an unrelated token retains its value and original lifetime", await store.pipeline([["GET", oldToken], ["TTL", oldToken]]), ["unrelated@example.test", 900]);
  is("the existing confirmed recovery address is unchanged", await recoveryAddress("known@example.test"), "backup@example.test");
  is("no provider read or POST occurs while the default binding is absent", forbidden, 0);
  const demoClosed = await signIn(signRequest(HOUSE_OWNER));
  is("a globally unavailable route gives the public demo the same refusal", [demoClosed.status, await demoClosed.json()], [503, { ok: false, error: "server_error" }]);

  part("Existing origin, input, honeypot and rate guards keep their responses");
  const invalid = await signIn(signRequest("not-an-email"));
  is("invalid email still gets its existing response", [invalid.status, await invalid.json()], [400, { ok: false, error: "invalid_email" }]);
  const honey = await signIn(signRequest("known@example.test", { website: "a program" }));
  is("honeypot remains neutral and successful", [honey.status, await honey.json()], [200, { ok: true }]);
  const foreign = new NextRequest(`${ORIGIN}/api/auth/request`, { method: "POST", headers: { Host: "marktmorgen.com", Origin: "https://foreign.example.test", "Content-Type": "application/json" }, body: JSON.stringify({ email: "known@example.test" }) });
  is("cross-site requests are refused before sending", (await signIn(foreign)).status, 403);
  for (let i = 0; i < 8; i++) await signIn(signRequest("limited@example.test"));
  const limited = await signIn(signRequest("limited@example.test"));
  is("the address rate limit is still enforced", [limited.status, await limited.json()], [429, { ok: false, error: "rate_limited" }]);

  part("The existing recovery form says what is actually known");
  const unavailable = renderToStaticMarkup(await LostEmailPage({ searchParams: Promise.resolve({ status: "unavailable" }) }));
  is("an unavailable recovery request has an alert", /role="alert"/.test(unavailable), true);
  is("the original form and passkey alternative remain usable", [unavailable.includes('action="/api/auth/lost"'), unavailable.includes("Log in with a passkey"), unavailable.includes("Email my recovery address")], [true, true, true]);
  const processed = renderToStaticMarkup(await LostEmailPage({ searchParams: Promise.resolve({ status: "sent" }) }));
  is("processed recovery requests do not claim delivery or a queued retry", [processed.includes("Your request was received."), processed.includes("Check your recovery inbox. If a link was sent, it works once, for 15 minutes."), /on its way|queued|will email|will try again/.test(processed)], [true, true, false]);
  is("the existing short-lived link is still described", processed.includes("it works once, for 15 minutes."), true);

  part("Configured SES does not become a preflight authorization or extra I/O");
  const fixture = installSesMailFixture();
  try {
    fixture.configure();
    await fixture.setReady(false);
    const refused: unknown[] = [];
    for (const email of ["known-post@example.test", "unknown-post@example.test"]) {
      const response = await signIn(signRequest(email));
      refused.push([response.status, await response.json()]);
    }
    is("an unsuccessful actual send fails equally without a creator lookup", refused,
      [[503, { ok: false, error: "server_error" }], [503, { ok: false, error: "server_error" }]]);
    is("a refused sender never posts a message", [fixture.calls.ses, fixture.calls.resend], [0, 0]);
    const demo = await signIn(signRequest(HOUSE_OWNER));
    is("the deliberately ignored public demo owner keeps its neutral reply", [demo.status, await demo.json()], [200, { ok: true }]);
    const unknownRecovery = await lost(lostRequest("unknown-post@example.test"));
    is("a recipient-dependent recovery outcome still cannot enumerate an account", [unknownRecovery.status, unknownRecovery.headers.get("location")], [303, `${ORIGIN}/signin/lost?status=sent`]);
    await fixture.setReady(true);
    const positive = await signIn(signRequest("accepted@example.test"));
    is("actual SES acceptance preserves the successful route", [positive.status, await positive.json()], [200, { ok: true }]);
    is("the original login email goes to the original inbox", [fixture.sent.length, fixture.sent.at(-1)?.to, fixture.sent.at(-1)?.subject], [1, ["accepted@example.test"], "Your Marktmorgen login link"]);
    is("the link keeps its existing 15-minute lifetime", fixture.sent.at(-1)?.text.includes("stops working in 15 minutes"), true);
    is("the helper added no SES account read before the original sender", fixture.calls.account, 2);
    is("Resend was never opened by a configured-SES or missing-proof case", fixture.calls.resend, 0);
  } finally { fixture.restore(); }

  part("The real fallback still requires its independent synthetic funded proof");
  for (const name of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN"]) delete process.env[name];
  const paid = await createResendFallbackFixture({ credential, cap: 2, sent: 0, received: 1, fetch: async () => Response.json({ id: "synthetic_accepted" }) });
  const message = { meter: { by: "company" as const }, from: "Marktmorgen <owner@example.test>", to: "creator@example.test", subject: "An existing right", text: "The original content" };
  is("the real guard accepts one explicitly funded synthetic fallback", await sendEmail(message, paid.runtime), true);
  is("inbound usage consumes the same last included slot", await sendEmail(message, paid.runtime), false);
  is("only the funded message generated a synthetic POST", paid.requests.filter(r => r.method === "POST").length, 1);
  is("no uncontrolled network request occurred in this test", forbidden, 0);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
