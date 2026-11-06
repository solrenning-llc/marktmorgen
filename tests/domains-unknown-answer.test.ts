/**
 * A creator's own domain, read from Vercel in a shape that is not Vercel's
 * (CX-123 rule 24, Claude 5, 05/11/2026). The studio's "check" (app/api/store/
 * domain) takes a live domain off (liveAt cleared, so lib/store-app.ts stops
 * serving the store on it) whenever domainStatus says it is not live. An
 * answer that did not come, or came without Vercel's verdicts, is not known:
 * domainStatus says so (null, "try again"), never "not live". A real verdict
 * that the records are wrong still says so. Synthetic only.
 */
import { domainCheckup, domainKey, domainStatus } from "@/lib/domains";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_test123";
const NAME = "shop.example.com";
type Answer = { status: number; body: string };
let project: Answer = { status: 200, body: "{}" };
let config: Answer = { status: 200, body: "{}" };
const ok = (v: unknown): Answer => ({ status: 200, body: JSON.stringify(v) });

const asked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  asked.push(url.pathname);
  const answer = url.pathname.startsWith("/v6/domains/") ? config : url.pathname === `/v9/projects/prj_test123/domains/${NAME}` ? project : ok({ id: "prj_test123" });
  return new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const store = { sid: "s_domain_unknown" };
const live = (s: Awaited<ReturnType<typeof domainStatus>>) => (s === null ? "unknown" : s.live ? "live" : "not live");

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  // Proved here, as a live domain is.
  await redis.pipeline([["SET", domainKey(NAME), "shapes"]]);
  const verified = ok({ name: NAME, apexName: "example.com", verified: true });

  part("Vercel's real verdicts");
  project = verified;
  config = ok({ misconfigured: false });
  is("verified and configured: live", live(await domainStatus(NAME, store)), "live");
  config = ok({ misconfigured: true, recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com." }] });
  is("records wrong, by Vercel's own word: not live", live(await domainStatus(NAME, store)), "not live");

  part("Answers that are not known are never 'not live'");
  project = { status: 200, body: "<html>bad gateway</html>" };
  config = ok({ misconfigured: false });
  is("the domain's answer unreadable", live(await domainStatus(NAME, store)), "unknown");
  project = ok({ name: NAME });
  is("the domain's answer without 'verified'", live(await domainStatus(NAME, store)), "unknown");
  project = verified;
  config = { status: 500, body: "{}" };
  is("the records' answer a server error", live(await domainStatus(NAME, store)), "unknown");
  config = ok({});
  is("the records' answer without 'misconfigured'", live(await domainStatus(NAME, store)), "unknown");
  config = { status: 200, body: "" };
  is("the records' answer empty", live(await domainStatus(NAME, store)), "unknown");

  part("A domain Vercel does not have: the status asks once; only the checkup tells 'gone' (review of Codex P on #2682)");
  project = { status: 404, body: JSON.stringify({ error: { code: "not_found" } }) };
  asked.length = 0;
  is("the status: not known, from one request", [live(await domainStatus(NAME, store)), asked.length], ["unknown", 1]);
  asked.length = 0;
  is("the checkup: gone, after asking whether the project is there", [await domainCheckup(NAME, store), asked.length], ["gone", 2]);
  done();
}

void main();
