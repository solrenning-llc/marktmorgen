/**
 * MM-SA-35, the MEDIUM on #3897 (Claude 3 cloud O, Claude 7 and an out-of-family review, 12/11/2026): the per-inbox
 * limit on "confirm a recovery address" codes was keyed on the address as typed (trim and lower case only), so one
 * inbox written several ways ("+" tags, Gmail dots, googlemail.com) got an allowance for each spelling, without
 * bound. The limit counts the inbox (canonicalEmail), while the code still goes to the address exactly as typed.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/recovery-address/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const FORMS = ["victim@gmail.com", "victim+a@gmail.com", "v.ictim@gmail.com", "VICTIM+b@googlemail.com", "vi.ctim+c@gmail.com"];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  let account = 0;
  for (const address of FORMS) {
    for (let i = 0; i < 2; i += 1) {
      account += 1;
      const cookie = `${SESSION_COOKIE}=${await openSession(`tagger-${account}@example.com`)}`;
      await POST(new NextRequest("https://marktmorgen.com/api/auth/recovery-address", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "start", address }),
      }));
    }
  }
  is(`one Gmail inbox, written five ways by ten accounts, gets at most 5 codes an hour (got ${mails.length})`, mails.length <= 5, true);
  is("the codes still go to the address as typed", mails.map((m) => m.to), ["victim@gmail.com", "victim@gmail.com", "victim+a@gmail.com", "victim+a@gmail.com", "v.ictim@gmail.com"]);

  // Another provider: a "+" tag alone reaches the same inbox there too.
  mails.length = 0;
  for (let i = 1; i <= 7; i += 1) {
    const cookie = `${SESSION_COOKIE}=${await openSession(`plus-${i}@example.com`)}`;
    await POST(new NextRequest("https://marktmorgen.com/api/auth/recovery-address", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ action: "start", address: `someone+${i}@example.org` }),
    }));
  }
  is(`one inbox elsewhere, seven "+" tags, gets at most 5 (got ${mails.length})`, mails.length <= 5, true);
  done();
}

void main();
