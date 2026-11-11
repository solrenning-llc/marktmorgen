/**
 * A six-digit code in the same email as the login link (652 [WG12], unit 1:
 * the studio's login), for when the email was opened on another device.
 *
 * Checked through the real routes (app/api/auth/request, the new
 * app/api/auth/email-code) against the in-memory Redis and a stand-in for
 * the email provider:
 *
 *   - the request answers the request's id for every address alike, and one
 *     email holds both the link and the code;
 *   - the right code opens a session once; the link and the code spend
 *     together, whichever comes first;
 *   - five wrong codes stop the code (the link still works); another
 *     request's code, a code past its time and an older request's code are
 *     refused; ten tries an hour for one address, all its requests together;
 *   - with two-step login on, the code leads to the second step, as the link;
 *   - the tries are counted before the comparison and read in their exact
 *     shape: unknown refuses and opens nothing;
 *   - the code is kept only as a hash;
 *   - the field is labeled, takes the phone's one-time code, and says what
 *     went wrong in a live region.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as requestRoute } from "@/app/api/auth/request/route";
import { POST as codeRoute } from "@/app/api/auth/email-code/route";
import { EMAIL_CODE_TRIES, EMAIL_CODE_TRIES_PER_ADDRESS_DAY, EMAIL_CODE_TRIES_PER_ADDRESS_HOUR, EMAIL_CODE_TRIES_PER_IP_HOUR, emailForSession, takeSignInLink } from "@/lib/auth";
import { EmailCodeForm } from "@/components/email-code-form";
import { HOUSE_OWNER } from "@/lib/house-store";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { finishSetup, startSetup, twoStepOn } from "@/lib/two-step";
import { store as redis, advance } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

// Amazon SES, stood in for (tests/ses-mail-fixture.ts): every email it takes is kept here, and nothing leaves.
const mail = installSesMailFixture();
mail.configure();
const mails = {
  get length() {
    return mail.sent.length;
  },
  slice: (from: number) => mail.sent.slice(from).map((m) => ({ to: m.to[0] ?? "", text: m.text })),
  filter: (keep: (m: { to: string; text: string }) => boolean) => mail.sent.map((m) => ({ to: m.to[0] ?? "", text: m.text })).filter(keep),
  all: () => mail.sent.map((m) => ({ to: m.to[0] ?? "", text: m.text })),
};

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) return rule.reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

let net = 1;
const ORIGIN = "https://marktmorgen.com";
const json = (path: string, body: unknown, cookie = "", ip = `192.0.2.${net++ % 250}`) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** Asks for a link: the request's id from the answer, and the link's token and the code from the email. */
async function ask(email: string): Promise<{ request: string; token: string; code: string }> {
  const before = mails.length;
  const res = await requestRoute(json("/api/auth/request", { email }));
  const data = (await res.json()) as { ok?: boolean; request?: string };
  const mail = mails.slice(before).find((m) => m.to === email);
  return {
    request: data.request ?? "",
    token: /token=([0-9a-f]{64})/.exec(mail?.text ?? "")?.[1] ?? "",
    code: /\n(\d{6})\n/.exec(mail?.text ?? "")?.[1] ?? "",
  };
}
const send = async (request: string, code: string, ip?: string) => {
  const res = await codeRoute(json("/api/auth/email-code", { request, code }, "", ip));
  const data = (await res.json()) as { ok?: boolean; next?: string; error?: string; left?: number };
  const session = (res.headers.get("set-cookie") ?? "").match(/nl_session=([0-9a-f]{64})/)?.[1] ?? "";
  return { status: res.status, ...data, session };
};
const other = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

async function main(): Promise<void> {
  redis.clear();

  part("One email holds the link and the code; the id goes to the asking browser for every address");
  const ana = await ask("ana@wg12.example");
  is("the answer carries the request's id", /^[0-9a-f]{64}$/.test(ana.request), true);
  is("the email holds a link and a six-digit code", [ana.token.length, ana.code.length], [64, 6]);
  is("one email, no more", mails.filter((m) => m.to === "ana@wg12.example").length, 1);
  // The code opens only with the id this page holds (Claude 3 on #2736): the email says so.
  is("the email says the code is typed on the page that asked, without reloading it", (mails.filter((m) => m.to === "ana@wg12.example")[0]?.text ?? "").includes("without reloading"), true);
  const before = mails.length;
  const house = await requestRoute(json("/api/auth/request", { email: HOUSE_OWNER }));
  const houseData = (await house.json()) as { ok?: boolean; request?: string };
  is("the demo owner's address answers the same, with an id, and no email", [house.status, houseData.ok, /^[0-9a-f]{64}$/.test(houseData.request ?? ""), mails.length - before], [200, true, true, 0]);

  part("The code is kept only as a hash");
  const kept = redis.keys().filter((k) => k.startsWith("nl:auth:code:"));
  const fields = (await Promise.all(kept.map(async (k) => (await pipeline([["HGETALL", k]]))[0] as unknown[]))).flat().map(String);
  is("no record holds the six digits or the request's id", fields.some((f) => f === ana.code || f.includes(ana.request)), false);

  part("The right code opens a session once, and spends the link with it");
  const opened = await send(ana.request, ana.code);
  is("opened, to the studio, with a session", [opened.status, opened.ok, opened.next, opened.session.length], [200, true, "/studio", 64]);
  is("the session is Ana's", await emailForSession(opened.session), "ana@wg12.example");
  is("the same code again: expired", (await send(ana.request, ana.code)).error, "code_expired");
  is("and the link is spent with it", await takeSignInLink(ana.token), null);

  part("A link used first spends the code");
  const ben = await ask("ben@wg12.example");
  is("the link opens", await takeSignInLink(ben.token), "ben@wg12.example");
  is("the code after it: expired", (await send(ben.request, ben.code)).error, "code_expired");

  part(`${EMAIL_CODE_TRIES} wrong codes stop the code; the link still works`);
  const cy = await ask("cy@wg12.example");
  const lefts: number[] = [];
  for (let i = 0; i < EMAIL_CODE_TRIES; i += 1) lefts.push((await send(cy.request, other(cy.code))).left ?? -1);
  is("each wrong code says the tries left", lefts, [4, 3, 2, 1, 0]);
  const late = await send(cy.request, cy.code);
  is("the right code after them: blocked, no session", [late.error, late.session], ["code_blocked", ""]);
  is("the link still opens", await takeSignInLink(cy.token), "cy@wg12.example");

  part("Another request's code, a code past its time, an older request's code");
  const dee = await ask("dee@wg12.example");
  const eve = await ask("eve@wg12.example");
  is("Dee's code with Eve's request: wrong", (await send(eve.request, dee.code === eve.code ? other(dee.code) : dee.code)).error, "code_wrong");
  is("a made-up request: expired", (await send("f".repeat(64), dee.code)).error, "code_expired");
  is("the code's shape is said: six digits", (await send(dee.request, "12345")).error, "code_shape");
  const deeAgain = await ask("dee@wg12.example");
  is("Dee's older code, after a new request: expired", (await send(dee.request, dee.code)).error, "code_expired");
  advance(15 * 60 * 1000 + 1000);
  is("the newer code past 15 minutes: expired", (await send(deeAgain.request, deeAgain.code)).error, "code_expired");

  part(`At most ${EMAIL_CODE_TRIES_PER_ADDRESS_HOUR} code tries an hour for one address, all its requests together`);
  let fay = await ask("fay@wg12.example");
  let tries = 0;
  while (tries < EMAIL_CODE_TRIES_PER_ADDRESS_HOUR) {
    if (tries > 0 && tries % EMAIL_CODE_TRIES === 0) fay = await ask("fay@wg12.example");
    await send(fay.request, other(fay.code));
    tries += 1;
  }
  fay = await ask("fay@wg12.example");
  const capped = await send(fay.request, fay.code);
  is("the right code of a fresh request past them: refused, no session", [capped.error, capped.session], ["code_address_blocked", ""]);
  advance(60 * 60 * 1000 + 1000);
  const after = await ask("fay@wg12.example");
  is("an hour later, a fresh code opens", (await send(after.request, after.code)).ok, true);

  part("An unknown count of tries refuses and opens nothing");
  const gus = await ask("gus@wg12.example");
  // The pipeline that counts a try: the hour's and the day's counts for the address, the request's, the record's time, the newest code.
  for (const [label, reply] of [
    ["the hour's count null", ["OK", null, "OK", 1, 1, 900, null]],
    ["the hour's count text", ["OK", "1", "OK", 1, 1, 900, null]],
    ["the day's count null", ["OK", 1, "OK", null, 1, 900, null]],
    ["the day's count negative", ["OK", 1, "OK", -1, 1, 900, null]],
    ["the request's count negative", ["OK", 1, "OK", 1, -1, 900, null]],
    ["the record's time text", ["OK", 1, "OK", 1, 1, "900", null]],
    ["a short reply", ["OK", 1]],
    ["not a list", { result: 1 }],
  ] as [string, unknown][]) {
    rule = { when: (c) => c.length === 7 && c[1]?.[0] === "INCR" && c[4]?.[0] === "HINCRBY", reply };
    const refused = await send(gus.request, gus.code);
    rule = null;
    is(`the tries answered as ${label}: server_error, no session`, [refused.status, refused.error, refused.session], [503, "server_error", ""]);
  }
  is("with exact replies the same code still opens", (await send(gus.request, gus.code)).ok, true);

  part(`At most ${EMAIL_CODE_TRIES_PER_ADDRESS_DAY} code tries a day for one address (Claude 3 on #2736): past them, only the link`);
  let tried = 0;
  while (tried < EMAIL_CODE_TRIES_PER_ADDRESS_DAY) {
    let gil = await ask("gil@wg12.example");
    for (let i = 0; i < EMAIL_CODE_TRIES_PER_ADDRESS_HOUR && tried < EMAIL_CODE_TRIES_PER_ADDRESS_DAY; i += 1) {
      if (i > 0 && i % EMAIL_CODE_TRIES === 0) gil = await ask("gil@wg12.example");
      await send(gil.request, other(gil.code));
      tried += 1;
    }
    advance(60 * 60 * 1000 + 1000);
  }
  const gilLate = await ask("gil@wg12.example");
  const dayCapped = await send(gilLate.request, gilLate.code);
  is("a fresh hour, the right code: still refused, no session", [dayCapped.error, dayCapped.session], ["code_address_blocked", ""]);
  is("and the link of that same email still opens", await takeSignInLink(gilLate.token), "gil@wg12.example");
  advance(24 * 60 * 60 * 1000);
  const gilNext = await ask("gil@wg12.example");
  is("a day later, a fresh code opens", (await send(gilNext.request, gilNext.code)).ok, true);

  part(`At most ${EMAIL_CODE_TRIES_PER_IP_HOUR} code tries an hour from one machine, before anything is read (Claude 3 on #2736)`);
  const machine = "198.51.100.7";
  const fromMachine: (string | undefined)[] = [];
  for (let i = 0; i < EMAIL_CODE_TRIES_PER_IP_HOUR; i += 1) fromMachine.push((await send(i.toString(16).padStart(64, "0"), "123456", machine)).error);
  is("each made-up request inside the limit: expired", fromMachine.every((error) => error === "code_expired"), true);
  const ivy = await ask("ivy@wg12.example");
  const overMachine = await send(ivy.request, ivy.code, machine);
  is("past it, even the right code: refused, no session", [overMachine.status, overMachine.error, overMachine.session], [429, "code_rate_limited", ""]);
  is("from another machine, the same code opens", (await send(ivy.request, ivy.code)).ok, true);

  part("A record gone between the read and the count is not left behind without a time (Claude 3 on #2736)");
  const joy = await ask("joy@wg12.example");
  let recreated = "";
  rule = {
    when: (c) => {
      const counting = c.length === 7 && c[4]?.[0] === "HINCRBY";
      if (counting && !recreated) recreated = String(c[4]?.[1]);
      return false;
    },
    reply: null,
  };
  const realPipeline = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The record runs out just before the count; real Redis then recreates it from HINCRBY alone, with no time. The
    // stand-in keeps a deleted key's old time (lib/redis-memory.ts DEL), so that state is set up here as Redis leaves it.
    if (commands.length === 7 && commands[4]?.[0] === "HINCRBY") {
      const gone = String(commands[4][1]);
      await pipeline([["DEL", gone], ["HSET", gone, "n", 0], ["PERSIST", gone]]);
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const raced = await send(joy.request, other(joy.code));
  redis.pipeline = realPipeline;
  rule = null;
  is("the try answers expired", raced.error, "code_expired");
  is("and the record is not kept forever", recreated !== "" && (await pipeline([["TTL", recreated]]))[0] !== -1, true);

  part("With two-step login on, the code leads to the second step, as the link does");
  const SESSION = "a".repeat(64);
  const started = await startSetup("hal@wg12.example", SESSION, "backup@wg12.example");
  if (typeof started === "string") throw new Error(started);
  const backup = /Your code: (\d{6})/.exec([...mails.all()].reverse().find((m) => m.to === "backup@wg12.example")?.text ?? "")?.[1] ?? "";
  const now = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
  const finished = await finishSetup("hal@wg12.example", SESSION, now, backup);
  is("two-step on", [typeof finished === "object", await twoStepOn("hal@wg12.example")], [true, true]);
  const hal = await ask("hal@wg12.example");
  const held = await send(hal.request, hal.code);
  is("the code opens no session: it leads to the code page", [held.ok, held.next, held.session], [true, "/signin/code", ""]);

  part("No deployment secret, no code: the link alone (Codex CX1 on #2736)");
  const secrets = { data: process.env.NIMBUS_DATA_KEY, stripe: process.env.STRIPE_SECRET_KEY };
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const bare = await ask("kim@wg12.example");
  if (secrets.data !== undefined) process.env.NIMBUS_DATA_KEY = secrets.data;
  if (secrets.stripe !== undefined) process.env.STRIPE_SECRET_KEY = secrets.stripe;
  is("the email holds the link and no code", [bare.token.length, bare.code], [64, ""]);
  is("and the link still opens", await takeSignInLink(bare.token), "kim@wg12.example");
  const bareTry = await send(bare.request, "123456");
  is("a code typed for that request opens nothing", [bareTry.error, bareTry.session], ["code_expired", ""]);

  part("The field");
  const html = renderToStaticMarkup(createElement(EmailCodeForm, { request: "a".repeat(64) }));
  is("labeled \"Enter the 6-digit code\"", /<label[^>]*for="([^"]+)"[^>]*>Enter the 6-digit code<\/label>/.test(html), true);
  const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1] ?? "";
  is("the label names the field", html.includes(`id="${id}"`), true);
  is("the phone's one-time code, a number pad, pasting allowed", [/autoComplete="one-time-code"|autocomplete="one-time-code"/.test(html), /inputMode="numeric"|inputmode="numeric"/.test(html), /onpaste|readonly/i.test(html)], [true, true, false]);
  is("what went wrong is said in a live region", /role="alert"/.test(html), true);
  is("the hint says where the code is", html.includes("It is in the same email as the link."), true);
  is("and that it works on this page without reloading it", html.includes("without reloading"), true);


  part("A failed sign-in request does not put the address or token in server logs");
  const originalError = console.error;
  const logCalls: unknown[][] = [];
  const originalPipeline = redis.pipeline;
  console.error = (...args: unknown[]) => { logCalls.push(args); };
  redis.pipeline = (async () => { throw new Error("private@wg12.example token=synthetic-secret-token"); }) as typeof redis.pipeline;
  let failedRequest: Response;
  try {
    failedRequest = await requestRoute(json("/api/auth/request", { email: "private@wg12.example" }));
  } finally {
    redis.pipeline = originalPipeline;
    console.error = originalError;
  }
  const failedBody = (await failedRequest.json()) as { error?: string };
  is("the public error stays generic", [failedRequest.status, failedBody.error], [500, "server_error"]);
  is("the server log contains neither address nor error details", JSON.stringify(logCalls).includes("private@wg12.example") || JSON.stringify(logCalls).includes("synthetic-secret-token"), false);

  mail.restore();
  done();
}

void main();
