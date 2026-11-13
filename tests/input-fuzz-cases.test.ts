/**
 * The smallest inputs tests/input-fuzz.test.ts found breaking a reader, each pinned as a plain case
 * (Claude 7, 13 November 2026), so the defect cannot come back even if the generator changes.
 */
import { createHmac } from "node:crypto";
import { done, is, part } from "./check";
import { inboundSigned } from "@/lib/inbound-mail";

part("Resend: a signature is believed only in its exact base64");
{
  const secret = Buffer.alloc(24, 7);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${secret.toString("base64")}`;
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"email.received"}';
  const good = createHmac("sha256", secret).update(`msg_fuzz.${ts}.${body}`).digest("base64");
  is("the exact signature is believed", inboundSigned(body, "msg_fuzz", ts, `v1,${good}`, now), true);
  // Node's base64 decoder skips characters outside the alphabet, so these decoded to the right bytes.
  for (const garbled of [`${good.slice(0, 10)}é${good.slice(10)}`, `${good}$`, `${good}=`, `*${good}`, good.replace(/=$/, "")]) {
    is(`a garbled signature ${JSON.stringify(garbled.slice(-6))} is refused`, inboundSigned(body, "msg_fuzz", ts, `v1,${garbled}`, now), false);
  }
}

done();
