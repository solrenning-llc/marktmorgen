/**
 * Sign-in emails bounded by the connection and by the whole site (Claude 7, 15/11/2026; found by 5FNwB, read only).
 *
 * The route built the machine's address by hand and lib/auth.ts counted that exact text, so an IPv6 client could ask
 * from each of the 2^64 addresses of its own /64 and find a new allowance every time; and nothing bounded the site as a
 * whole, so a range of connections could send sign-in links to a hundred thousand other people's addresses, enough
 * complaints and bounces to pause the sending account and stop every email of the site. Now the connection is counted
 * as every limit counts it (lib/request-guard.ts limitAddress: an IPv6 one by its /64), and the site's sign-in emails
 * stop at SIGN_IN_LINKS_PER_HOUR an hour, with the same "too many tries" for every address; a count that cannot be
 * read sends nothing.
 *
 * Synthetic only: Redis is tests/redis-stub.ts; nothing is sent.
 */
import { NextRequest } from "next/server";
import { POST as signIn } from "@/app/api/auth/request/route";
import { SIGN_IN_LINKS_PER_HOUR, rateLimitAnswer, siteLinksAnswer } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const request = (address: string, email: string) =>
  new NextRequest(`${ORIGIN}/api/auth/request`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ email }),
  });

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_SYNTHETIC_AUTH_LINK_LIMIT_ONLY";
  globalThis.fetch = async () => {
    throw Error("No external I/O");
  };

  part("One IPv6 connection is one machine, whichever of its addresses asks");
  const answers: string[] = [];
  for (let i = 1; i <= 6; i += 1) answers.push(await rateLimitAnswer(`2001:db8:1:2::${i.toString(16)}`));
  is("five, then past the limit, from five different addresses of one /64", answers, ["within", "within", "within", "within", "within", "over"]);
  is("another /64 has its own five", await rateLimitAnswer("2001:db8:1:3::1"), "within");
  is("an IPv4 address still counts by itself", await rateLimitAnswer("203.0.113.7"), "within");

  part("The route counts the connection the same way");
  redis.clear();
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i += 1) statuses.push((await signIn(request(`2001:db8:9:9::${i.toString(16)}`, `person${i}@example.test`))).status);
  is("the sixth request from one /64 is refused as too many tries", statuses.at(-1), 429);

  part("The whole site's sign-in emails in an hour");
  redis.clear();
  let last = "";
  for (let i = 0; i < SIGN_IN_LINKS_PER_HOUR; i += 1) last = await siteLinksAnswer();
  is("up to the ceiling: within", last, "within");
  is("one more: over", await siteLinksAnswer(), "over");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async () => ["not a count"]) as typeof redis.pipeline;
  try {
    is("a count that cannot be read is unknown, never room", await siteLinksAnswer(), "unknown");
  } finally {
    redis.pipeline = real;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
