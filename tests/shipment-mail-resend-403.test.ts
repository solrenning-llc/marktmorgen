/**
 * Mail-queue hunt (RED before the fix): a paid order's shipment email is terminally refused,
 * and never sent, when the Resend fallback answers 401/403 (a key that may not
 * send from the creators' domain, a domain whose verification lapsed). Those
 * are account/credential answers, not the email's own fault: lib/email.ts
 * resendOutcome itself treats 401/403 as "this key may not send from this
 * domain" and resends from the site's address, and the SES side of the same
 * dispatcher maps 401/403/404 to "account" and answers "not_accepted" (kept
 * queued). queuedShipmentMailSender maps the Resend 401/403 to "refused",
 * which lib/shipment-mail-outbox.ts records as the terminal state "refused".
 *
 * Synthetic only: the real guarded transport with the synthetic reviewed
 * account fixture, a mocked provider, the in-memory Redis stub.
 */
import { done, is, part } from "./check";
import { createResendFallbackFixture } from "./resend-fallback-fixture";
import { queuedShipmentMailSender } from "@/lib/email";
import { enqueueShipmentMail, runShipmentMail, shipmentMailStatus } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";

const credential = "re_SYNTHETIC_TRANSPORT_ONLY";
const message = { from: "Store <owner@example.test>", to: "buyer@example.test", subject: "Your order shipped", text: "On its way.", replyTo: "owner@example.test" };

async function main() {
  store.clear();
  process.env.RESEND_API_KEY = credential;
  for (const key of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN", "RESEND_READ_API_KEY"]) delete process.env[key];
  process.env.NIMBUS_DATA_KEY = "SYNTHETIC_SHIPMENT_DATA_KEY_1234567890";

  part("Resend answers 403 (domain not verified for this key) to a shipment email");
  const forbidden = await createResendFallbackFixture({ credential, fetch: async () =>
    Response.json({ statusCode: 403, name: "validation_error", message: "The example.test domain is not verified." }, { status: 403 }) });
  is("the dispatcher does not call an account/credential refusal the email's own", await queuedShipmentMailSender(forbidden.runtime)(message, async () => true, { id: "synthetic_ship_403" }), "not_accepted");

  part("Through the durable outbox");
  const now = Date.now(), queue = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: queue.pipeline, now: () => now };
  const work = { statsId: "synthetic_ship_403_store", session: "cs_test_mailhuntship403000001", authorizedAt: now,
    shipped: { at: Math.floor(now / 1000), tracking: "https://example.test/track" }, message };
  await enqueueShipmentMail(work, runtime);
  const again = await createResendFallbackFixture({ credential, fetch: async () =>
    Response.json({ statusCode: 403, name: "validation_error", message: "The example.test domain is not verified." }, { status: 403 }) });
  await runShipmentMail(now + 20_000, queuedShipmentMailSender(again.runtime), runtime);
  is("the paid shipment email stays queued for a later try, not terminally refused", (await shipmentMailStatus(work.statsId, work.session, runtime))?.state, "queued");
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
