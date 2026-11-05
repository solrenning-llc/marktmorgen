import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { done, is, part } from "./check";
import {
  installInboundRecoveryWorld,
  resetInboundRecoveryWorld,
  restoreInboundRecoveryWorld,
  world,
} from "./inbound-dedup-recovery-red-world";

const SECRET_BYTES = Buffer.from("inbound-recovery-proof-secret-2026");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

function announcement(id: string): NextRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: "email.received",
    created_at: "2026-11-05T08:00:00.000Z",
    data: { email_id: EMAIL_ID },
  });
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: {
      host: "marktmorgen.com",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

async function main(): Promise<void> {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_INBOUND_API_KEY = "re_synthetic_inbound_reader";
  process.env.RESEND_API_KEY = "re_synthetic_sender";
  process.env.SUPPORT_FORWARD_TO = "inbox@example.test";
  installInboundRecoveryWorld();
  try {
    part("Unknown claim evidence cannot authorize an external provider read or unowned cleanup");
    const unknowns: [string, unknown, { throwBeforeReply?: boolean; applyBeforeThrow?: boolean }?][] = [
      ["empty envelope", []],
      ["missing result", [undefined]],
      ["false result", [false]],
      ["extra result", ["OK", null]],
      ["lost reply before evidence", [], { throwBeforeReply: true }],
      ["lost reply after Redis applied the claim", [], { throwBeforeReply: true, applyBeforeThrow: true }],
    ];
    for (const [index, [label, reply, options]] of unknowns.entries()) {
      resetInboundRecoveryWorld(reply, options);
      const response = await POST(announcement(`unknown_${index}`));
      is(`${label}: caller receives retryable unknown`, response.status, 503);
      is(`${label}: no external provider read is authorized`, world.providerReads, 0);
      is(`${label}: no ownerless marker deletion follows`, world.seenCommands.map((command) => command[0]), ["SET"]);
    }

    part("Exact duplicate evidence remains a side-effect-free acknowledgment");
    resetInboundRecoveryWorld([null]);
    const duplicate = await POST(announcement("exact_duplicate"));
    is("confirmed duplicate is acknowledged", [duplicate.status, await duplicate.json()], [200, { ok: true }]);
    is("confirmed duplicate performs no provider read", world.providerReads, 0);
    is("confirmed duplicate does not delete the marker", world.seenCommands.map((command) => command[0]), ["SET"]);

    part("A failed effect may release only an owner-bound claim");
    resetInboundRecoveryWorld(["OK"]);
    const failed = await POST(announcement("exact_fresh"));
    is("confirmed fresh claim reports the provider failure", failed.status, 500);
    is("confirmed fresh claim reaches the provider once", world.providerReads, 1);
    is("failure never issues an unconditional DEL", world.seenCommands.some((command) => command[0] === "DEL"), false);
  } finally {
    restoreInboundRecoveryWorld();
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_INBOUND_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.SUPPORT_FORWARD_TO;
  }
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
