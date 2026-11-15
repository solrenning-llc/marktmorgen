/**
 * MM-SA-55, its invite part (docs/security-audit-2026-10-28.md; 506 [SG1]): "Accept the invite"
 * (app/invite/[code]/accept) kept the invite on the browser in a cookie on a GET. Any other site could set it with a
 * link or an image, so a stranger's code would count for a store this browser makes next (its inviter earns from that
 * store's payments). Now the cookie is set only on a POST from this site, which the page's button sends; a GET sets
 * nothing and leads back to the invite's page. Dormant while the program is paused (INVITE_PROGRAM_OPEN false): this
 * test opens it only through its own alias (tests/invite-open-world.ts), never in the code.
 *
 * What fails here: a GET that sets the cookie; a POST from another site that sets it; this site's POST that does not;
 * the page's button not sending a POST.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import * as acceptRoute from "@/app/invite/[code]/accept/route";
import { INVITE_COOKIE, INVITE_PROGRAM_OPEN } from "@/lib/creator-invite-rules";
import { inviteCode } from "@/lib/creator-invites";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Handler = (request: NextRequest, context: { params: Promise<{ code: string }> }) => Promise<Response>;
const route = acceptRoute as unknown as { GET?: Handler; POST?: Handler };
const ask = (method: "GET" | "POST", code: string, origin?: string) =>
  new NextRequest(`https://marktmorgen.com/invite/${code}/accept`, {
    method,
    headers: { host: "marktmorgen.com", ...(origin ? { origin } : {}) },
  });
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").includes(`${INVITE_COOKIE}=`);

async function main(): Promise<void> {
  redis.clear();
  is("the program is open only in this test", INVITE_PROGRAM_OPEN, true);
  await claimHandle("ana@example.com", "ana", "Ana", "");
  const code = await inviteCode((await storeForEmail("ana@example.com"))!.sid);
  const context = () => ({ params: Promise.resolve({ code }) });

  part("Opening the link sets nothing");
  const got = route.GET ? await route.GET(ask("GET", code), context()) : null;
  is("a GET keeps no invite", got ? cookieOf(got) : false, false);
  is("and leads back to the invite's page", got ? got.headers.get("location") : `/invite/${code}`, `/invite/${code}`);

  part("Only this site's button keeps it");
  const posted = route.POST ? await route.POST(ask("POST", code, "https://marktmorgen.com"), context()) : null;
  is("a POST from this site keeps the invite and goes on to sign-up", posted ? [cookieOf(posted), posted.headers.get("location")] : null, [true, "/signin?status=invite-accepted"]);
  const foreign = route.POST ? await route.POST(ask("POST", code, "https://evil.example"), context()) : null;
  is("a POST from another site keeps nothing", foreign ? [foreign.status, cookieOf(foreign)] : null, [403, false]);
  const page = readFileSync("app/invite/[code]/page.tsx", "utf8");
  is("the page's button sends a POST", /<form method="post" action=\{`\/invite\/\$\{code\}\/accept`\}/.test(page), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
