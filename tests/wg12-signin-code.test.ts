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
import { EMAIL_CODE_TRIES, EMAIL_CODE_TRIES_PER_ADDRESS_HOUR, emailForSession, takeSignInLink } from "@/lib/auth";
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
const json = (path: string, body: unknown, cookie = "") =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": `192.0.2.${net++ % 250}`, ...(cookie ? { cookie } : {}) },
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
const send = async (request: string, code: string) => {
  const res = await codeRoute(json("/api/auth/email-code", { request, code }));
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
  for (const [label, reply] of [["null", ["OK", null, 1, null]], ["text", ["OK", "1", 1, null]], ["negative", ["OK", 1, -1, null]], ["a short reply", ["OK", 1]], ["not a list", { result: 1 }]] as [string, unknown][]) {
    rule = { when: (c) => c.length === 4 && c[1]?.[0] === "INCR" && c[2]?.[0] === "HINCRBY", reply };
    const refused = await send(gus.request, gus.code);
    rule = null;
    is(`the tries answered as ${label}: server_error, no session`, [refused.status, refused.error, refused.session], [503, "server_error", ""]);
  }
  is("with exact replies the same code still opens", (await send(gus.request, gus.code)).ok, true);

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

  part("The field");
  const html = renderToStaticMarkup(createElement(EmailCodeForm, { request: "a".repeat(64) }));
  is("labeled \"Enter the 6-digit code\"", /<label[^>]*for="([^"]+)"[^>]*>Enter the 6-digit code<\/label>/.test(html), true);
  const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1] ?? "";
  is("the label names the field", html.includes(`id="${id}"`), true);
  is("the phone's one-time code, a number pad, pasting allowed", [/autoComplete="one-time-code"|autocomplete="one-time-code"/.test(html), /inputMode="numeric"|inputmode="numeric"/.test(html), /onpaste|readonly/i.test(html)], [true, true, false]);
  is("what went wrong is said in a live region", /role="alert"/.test(html), true);
  is("the hint says where the code is", html.includes("It is in the same email as the link."), true);

  mail.restore();
  done();
}

void main();
