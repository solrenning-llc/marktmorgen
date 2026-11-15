/**
 * Sign-in emails bounded by the connection and by the whole site (Claude 7, 15/11/2026; found by 5FNwB, read only).
 *
 * The route built the machine's address by hand and lib/auth.ts counted that exact text, so an IPv6 client could ask
 * from each of the 2^64 addresses of its own /64 and find a new allowance every time; and nothing bounded the site as a
 * whole, so a range of connections could send sign-in links to a hundred thousand other people's addresses, enough
 * complaints and bounces to pause the sending account and stop every email of the site. Now the connection is counted
 * as every limit counts it (lib/request-guard.ts limitAddress: an IPv6 one by its /64), and the site's sign-in emails
 * stop at SIGN_IN_LINKS_PER_HOUR an hour for new addresses; a count that cannot be read sends nothing.
 *
 * Reworked after 3rjdf's reading (CHANGES): a ceiling that refused every address let 120 /64s stop every creator's
 * login each hour. Past it now, an address that already has an account is still sent its email, a new one waits, and
 * both get the same honest "busy" answer; an IPv6 /48 has its own count between the /64 and the site (so one network
 * cannot spend the hour); the log says once a window that the ceiling was reached; the code tries' counter takes a
 * connection by its /64 too; and the commands a request runs are counted here.
 *
 * Synthetic only: Redis is tests/redis-stub.ts; nothing is sent.
 */
import { NextRequest } from "next/server";
import { POST as signIn } from "@/app/api/auth/request/route";
import { POST as typeCode } from "@/app/api/auth/email-code/route";
import { createHash } from "node:crypto";
import {
  EMAIL_CODE_TRIES_PER_IP_HOUR,
  SIGN_IN_BUSY_MESSAGE,
  SIGN_IN_LINKS_PER_BLOCK,
  SIGN_IN_LINKS_PER_HOUR,
  blockLimitAnswer,
  codeRateAnswer,
  limitBlock,
  rateLimitAnswer,
  siteLinksAnswer,
} from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
// "next/server" here is this world (tests/test-config.mjs): what a route leaves for after its answer is held, not run.
import { afterTasks } from "./next-server-after-world";
import { done, is, part } from "./check";

// The deployment secret the code in a sign-in email is kept under (lib/auth.ts codeHash), as tests/wg12-signin-code.test.ts.
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const ORIGIN = "https://marktmorgen.com";
const SITE = "nl:rl:signin-site";
type Command = (string | number)[];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Makes `email` the owner of a store, as lib/account-exists.ts ownsStore reads it. */
const ownStore = (email: string) => redis.run(["SET", `nl:store:owner:${sha(`nimbus-store:${email}`).slice(0, 40)}`, "store-synthetic-1"]);
const links = () => redis.keys().filter((key) => key.startsWith("nl:auth:link:")).length;
const request = (address: string, email: string) =>
  new NextRequest(`${ORIGIN}/api/auth/request`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ email }),
  });

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_SYNTHETIC_AUTH_LINK_LIMIT_ONLY";
  // Amazon SES and every other endpoint are the synthetic fixture (tests/ses-mail-fixture.ts): no external I/O.
  const mail = installSesMailFixture();
  mail.configure();

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
  const sent: (string | number)[][][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(commands);
    return real(commands);
  }) as typeof redis.pipeline;
  await siteLinksAnswer();
  is("one pipeline of two commands a request: INCR and EXPIRE NX on the site's one key", sent.map((commands) => commands.map((c) => [c[0], c[1], ...c.slice(2)])), [[["INCR", "nl:rl:signin-site"], ["EXPIRE", "nl:rl:signin-site", 3600, "NX"]]]);
  redis.pipeline = (async () => ["not a count"]) as typeof redis.pipeline;
  try {
    is("a count that cannot be read is unknown, never room", await siteLinksAnswer(), "unknown");
  } finally {
    redis.pipeline = real;
  }

  part("Past the site's ceiling a flood cannot stop the creators' own logins, and says nothing about who has one");
  redis.clear();
  const creator = "creator@example.test";
  ownStore(creator);
  redis.run(["SET", SITE, SIGN_IN_LINKS_PER_HOUR]);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  // Every command a request runs before its answer, its keys without their one-way hash: what its time is made of.
  const shapeOf = async (address: string, email: string): Promise<{ answer: Response; shape: string[] }> => {
    const seen: string[] = [];
    redis.pipeline = (async (commands: Command[]) => {
      seen.push(...commands.map((c) => `${c[0]} ${String(c[1]).replace(/[0-9a-f]{32,}$/, "#")}`));
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      return { answer: await signIn(request(address, email)), shape: seen };
    } finally {
      redis.pipeline = real;
    }
  };
  afterTasks.length = 0;
  mail.clearCaptured();
  let forCreator: { answer: Response; shape: string[] };
  let forNew: { answer: Response; shape: string[] };
  let again: Response;
  try {
    forCreator = await shapeOf("203.0.113.10", creator);
    forNew = await shapeOf("203.0.113.11", "newcomer@example.test");
    is("both answers go before anything is sent or an account is read, each with its link and code written", [links(), mail.sent.length, afterTasks.length], [2, 0, 2]);
    is("and run the very same commands first: the time of the answer cannot tell an account", forCreator.shape, forNew.shape);
    is("none of them reads an account", forCreator.shape.some((line) => /nl:store:owner|nl:account:stores/.test(line)), false);
    again = await signIn(request("203.0.113.12", "another@example.test"));
  } finally {
    console.warn = warn;
  }
  const [a, b] = [await forCreator.answer.json(), await forNew.answer.json()];
  // The code page with each request id and a wrong code (3rjdf's ALTO on fc47acaa27): answered alike, so it cannot
  // tell an account (its code record written) from a new address (none, before: "expired").
  const typed = async (id: unknown, from: string) => {
    const response = await typeCode(new NextRequest(`${ORIGIN}/api/auth/email-code`, {
      method: "POST",
      headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify({ request: id, code: "000000" }),
    }));
    return [response.status, await response.json()];
  };
  is("the code page answers the request of an account and of a new address alike", await typed(a.request, "203.0.113.50"), await typed(b.request, "203.0.113.51"));
  is("both are a wrong code, never \"expired\" for one of them", [(await typed(a.request, "203.0.113.52"))[1].error, (await typed(b.request, "203.0.113.55"))[1].error], ["code_wrong", "code_wrong"]);
  for (const task of afterTasks.splice(0)) await (task as () => Promise<void>)();
  is("and still alike once the account's email went (fc47acaa27 wrote the account's record only then)", await typed(a.request, "203.0.113.53"), await typed(b.request, "203.0.113.54"));
  is("then an address with an account is sent its email", mail.sent.filter((m) => m.to.includes(creator)).length, 1);
  is("under the very request id its browser was given, so the code in it opens there", redis.keys().includes(`nl:auth:code:${sha(`nimbus-auth-code:${a.request}`).slice(0, 40)}`), true);
  is("and a new address is sent nothing", mail.sent.filter((m) => !m.to.includes(creator)).length, 0);
  is("both are told the same: busy, with the honest message", [forCreator.answer.status, a.ok, a.error, a.message, forNew.answer.status, b.ok, b.error, b.message], [503, false, "busy", SIGN_IN_BUSY_MESSAGE, 503, false, "busy", SIGN_IN_BUSY_MESSAGE]);
  is("both are given a request id of the same shape", [typeof a.request, typeof b.request, String(a.request).length === String(b.request).length], ["string", "string", true]);
  is("never \"too many tries\", which is false for one who asked once", [a.error, b.error].includes("rate_limited"), false);
  is("the same headers for both", [forCreator.answer.headers.get("Retry-After"), forNew.answer.headers.get("Retry-After"), forCreator.answer.headers.get("Cache-Control")], ["3600", "3600", "no-store"]);
  is("the log says once a window that the ceiling was reached, with no address in it", [warned.filter((line) => line.includes("emails an hour were reached")).length, warned.some((line) => /@|203\.0\.113/.test(line))], [1, false]);
  is("and a third request past it is still busy", again.status, 503);
  afterTasks.length = 0;
  is("the message says nothing about the address it answers", /creator|newcomer|example/.test(SIGN_IN_BUSY_MESSAGE), false);

  part("An account that cannot be read past the ceiling is sent nothing, under the same answer");
  redis.clear();
  ownStore(creator);
  redis.run(["SET", SITE, SIGN_IN_LINKS_PER_HOUR + 5]);
  mail.clearCaptured();
  const error = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    const unreadable = await signIn(request("203.0.113.20", creator));
    redis.pipeline = (async (commands: Command[]) => (commands.some((c) => String(c[1]).startsWith("nl:store:owner:")) ? ["not a reply"] : real(commands))) as typeof redis.pipeline;
    for (const task of afterTasks.splice(0)) await (task as () => Promise<void>)();
    redis.pipeline = real;
    is("busy, nothing sent, and said in the log", [unreadable.status, (await unreadable.json()).error, mail.sent.length, logged.some((line) => line.includes("nothing was sent"))], [503, "busy", 0, true]);

    part("An account's email that does not go past the ceiling is logged, never silent");
    logged.length = 0;
    await signIn(request("203.0.113.21", creator));
    mail.disableSes();
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      for (const task of afterTasks.splice(0)) await (task as () => Promise<void>)();
    } finally {
      process.env.RESEND_API_KEY = key;
      mail.configure();
    }
    is("nothing sent, and the log says an account's email was not sent", [mail.sent.length, logged.some((line) => line.includes("an account's email was not sent"))], [0, true]);
  } finally {
    redis.pipeline = real;
    console.error = error;
  }

  part("The route: a count it cannot read sends nothing; mail known down is answered before the site is counted");
  redis.clear();
  redis.pipeline = (async (commands: Command[]) => (commands.some((c) => c[1] === SITE) ? ["not a count"] : real(commands))) as typeof redis.pipeline;
  try {
    const unknown = await signIn(request("203.0.113.30", "person@example.test"));
    is("the site's count unreadable: 503 server_error, nothing sent", [unknown.status, (await unknown.json()).error, links()], [503, "server_error", 0]);
  } finally {
    redis.pipeline = real;
  }
  redis.clear();
  // Amazon off and Resend's fallback without its proof: lib/email.ts serviceMailKnownUnavailable is true.
  mail.disableSes();
  try {
    const down = await signIn(request("203.0.113.31", "person@example.test"));
    is("mail known down: 503 server_error, and the site's ceiling is not spent", [down.status, (await down.json()).error, redis.keys().includes(SITE)], [503, "server_error", false]);
  } finally {
    mail.configure();
  }
  redis.clear();
  const sentBefore = mail.sent.length;
  const fine = await signIn(request("203.0.113.32", "person@example.test"));
  is("below the ceiling, mail up: sent, and the site counted once", [fine.status, (await fine.json()).ok, mail.sent.length - sentBefore, redis.run(["GET", SITE])], [200, true, 1, "1"]);

  part("An IPv6 /48 has its own count, between the /64 and the site");
  is("an IPv6 address's /48", [limitBlock("2001:db8:1:2::9"), limitBlock("[2001:DB8:1:FFFF::1]:443"), limitBlock("::ffff:203.0.113.9"), limitBlock("203.0.113.9"), limitBlock("unknown")], ["2001:db8:1::/48", "2001:db8:1::/48", null, null, null]);
  redis.clear();
  const blockAnswers: string[] = [];
  for (let i = 1; i <= SIGN_IN_LINKS_PER_BLOCK + 1; i += 1) blockAnswers.push(await blockLimitAnswer(`2001:db8:5:${i.toString(16)}::1`));
  is("thirty /64s of one /48 are within, the next is over", [blockAnswers.slice(0, -1).every((answer) => answer === "within"), blockAnswers.at(-1)], [true, "over"]);
  is("another /48 has its own", await blockLimitAnswer("2001:db8:6:1::1"), "within");
  redis.clear();
  for (let i = 1; i <= SIGN_IN_LINKS_PER_BLOCK; i += 1) await blockLimitAnswer(`2001:db8:7:${i.toString(16)}::1`);
  const blocked = await signIn(request("2001:db8:7:ffff::1", "person@example.test"));
  is("the route refuses a new /64 of a spent /48 as too many tries from one place", [blocked.status, (await blocked.json()).error], [429, "rate_limited"]);

  part("The commands a request runs for these ceilings: two on the site's key, two on the /48's for IPv6 only");
  const counted = async (address: string, siteBefore = 0): Promise<Command[]> => {
    redis.clear();
    if (siteBefore) redis.run(["SET", SITE, siteBefore]);
    const seen: Command[] = [];
    redis.pipeline = (async (commands: Command[]) => {
      seen.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await signIn(request(address, "person@example.test"));
    } finally {
      redis.pipeline = real;
    }
    return seen;
  };
  const v6 = await counted("2001:db8:8:1::1");
  is("IPv6: INCR and EXPIRE NX on the site's key, once each", v6.filter((c) => c[1] === SITE).map((c) => c[0]), ["INCR", "EXPIRE"]);
  is("IPv6: INCR and EXPIRE NX on its /48's key, once each", v6.filter((c) => String(c[1]).startsWith("nl:rl:signin-block:")).map((c) => c[0]), ["INCR", "EXPIRE"]);
  const v4 = await counted("203.0.113.40");
  is("IPv4: the site's two, and none for a /48", [v4.filter((c) => c[1] === SITE).length, v4.filter((c) => String(c[1]).startsWith("nl:rl:signin-block:")).length], [2, 0]);
  const warn2 = console.warn;
  console.warn = () => {};
  try {
    const pastIt = await counted("203.0.113.41", SIGN_IN_LINKS_PER_HOUR + 1);
    is("past the ceiling the site's two still run on every request: it bounds emails, not commands", pastIt.filter((c) => c[1] === SITE).map((c) => c[0]), ["INCR", "EXPIRE"]);
  } finally {
    console.warn = warn2;
  }

  part("The code tries' counter takes a connection by its /64 too");
  redis.clear();
  const tries: string[] = [];
  for (let i = 1; i <= EMAIL_CODE_TRIES_PER_IP_HOUR + 1; i += 1) tries.push(await codeRateAnswer(`2001:db8:a:b::${i.toString(16)}`));
  is("thirty tries from addresses of one /64, then over", [tries.slice(0, -1).every((answer) => answer === "within"), tries.at(-1)], [true, "over"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
