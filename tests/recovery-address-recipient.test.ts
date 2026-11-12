/**
 * MM-SA-35 (docs/security-audit-2026-10-28.md): a stranger's address typed as
 * a "recovery address" (app/api/auth/recovery-address, lib/recovery-address.ts
 * startRecoveryAddress) was limited per SENDING account (5 an hour), never per
 * RECIPIENT. Accounts are free to make, so a handful of throwaway accounts can
 * send a victim's inbox the company's "confirm a recovery address" email
 * without bound, each carrying an account address the sender chose.
 *
 * One recipient gets at most 5 such emails an hour, however many accounts ask,
 * and an account still sets its own recovery address.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/recovery-address/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const VICTIM = "victim@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  for (let account = 1; account <= 4; account += 1) {
    const cookie = `${SESSION_COOKIE}=${await openSession(`spam-${account}@example.com`)}`;
    for (let i = 0; i < 5; i += 1) {
      await POST(new NextRequest("https://marktmorgen.com/api/auth/recovery-address", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "start", address: VICTIM }),
      }));
    }
  }
  const toVictim = mails.filter((m) => m.to === VICTIM).length;
  is(`one recipient gets at most 5 recovery-address codes an hour from any number of accounts (got ${toVictim})`, toVictim <= 5, true);
  is("the first five went out, so a real owner setting it is not refused", toVictim, 5);

  // Another account, another address: its own count, untouched by the flood above.
  const own = `${SESSION_COOKIE}=${await openSession("owner-x@example.com")}`;
  const answer = await POST(new NextRequest("https://marktmorgen.com/api/auth/recovery-address", { method: "POST", headers: { "content-type": "application/json", cookie: own }, body: JSON.stringify({ action: "start", address: "backup-x@example.com" }) }));
  is("an owner choosing an address nobody flooded still gets the code", [answer.status, mails.filter((m) => m.to === "backup-x@example.com").length], [200, 1]);
  done();
}

void main();
