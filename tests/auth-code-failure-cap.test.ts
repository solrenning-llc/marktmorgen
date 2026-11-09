/**
 * The six-digit code of the login email has a ceiling of wrong codes in a row
 * for one address (Claude 5's authentication audit, M1; NIST SP 800-63B
 * §5.2.2 asks for at most 100 consecutive failures).
 *
 * The request's id goes back to whichever browser asked, so anybody can ask a
 * code for any address and guess it. The hourly and daily limits renew, so
 * without a ceiling the same address takes guesses every day, for ever.
 * Checked through the real routes (app/api/auth/request, app/api/auth/email-code,
 * app/api/auth/callback) against the in-memory Redis and a stand-in for the
 * email provider:
 *
 *   - past EMAIL_CODE_FAILS_IN_A_ROW wrong codes, no code opens for the
 *     address, not even the right one of a fresh request, however many days
 *     pass: only the link does (no CAPTCHA, no test of any kind: AX274 3.3.9);
 *   - the owner is emailed once, in plain words, when the codes stop;
 *   - a login with the link starts the count again, and a code opens again;
 *   - a count that cannot be read refuses and opens nothing.
 */
import { NextRequest } from "next/server";
import { POST as requestRoute } from "@/app/api/auth/request/route";
import { POST as codeRoute } from "@/app/api/auth/email-code/route";
import { POST as callbackRoute } from "@/app/api/auth/callback/route";
import * as auth from "@/lib/auth";
import { store as redis, advance } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const mail = installSesMailFixture();
mail.configure();

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) return rule.reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

let net = 1;
const ORIGIN = "https://marktmorgen.com";
const json = (path: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${net++ % 250}` },
    body: JSON.stringify(body),
  });

async function ask(email: string): Promise<{ request: string; token: string; code: string }> {
  const before = mail.sent.length;
  const data = (await (await requestRoute(json("/api/auth/request", { email }))).json()) as { request?: string };
  const text = mail.sent.slice(before).find((m) => m.to[0] === email)?.text ?? "";
  return { request: data.request ?? "", token: /token=([0-9a-f]{64})/.exec(text)?.[1] ?? "", code: /\n(\d{6})\n/.exec(text)?.[1] ?? "" };
}
async function send(request: string, code: string): Promise<{ status: number; error?: string; ok?: boolean; session: string }> {
  const res = await codeRoute(json("/api/auth/email-code", { request, code }));
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { status: res.status, ...data, session: (res.headers.get("set-cookie") ?? "").match(/nl_session=([0-9a-f]{64})/)?.[1] ?? "" };
}
const other = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
const HOUR = 60 * 60 * 1000;
// Read through the module so this file builds against a lib/auth.ts without the ceiling (its red commit): 100 there.
const EMAIL_CODE_FAILS_IN_A_ROW = ((auth as Record<string, unknown>).EMAIL_CODE_FAILS_IN_A_ROW as number | undefined) ?? 100;
const { emailForSession } = auth;

/** Wrong codes, spread as the hourly and daily limits allow: four requests a day, five tries each, two hours. */
async function guess(email: string, days: number): Promise<{ judged: number; refused: number }> {
  let judged = 0;
  let refused = 0;
  for (let day = 0; day < days; day += 1) {
    for (let hour = 0; hour < 2; hour += 1) {
      for (let r = 0; r < 2; r += 1) {
        const asked = await ask(email);
        for (let t = 0; t < 5; t += 1) {
          const answer = await send(asked.request, other(asked.code));
          if (answer.error === "code_wrong") judged += 1;
          if (answer.error === "code_address_blocked") refused += 1;
        }
      }
      advance(HOUR + 1000);
    }
    advance(22 * HOUR);
  }
  return { judged, refused };
}

const notices = (email: string) => mail.sent.filter((m) => m.to[0] === email && /codes? (are|is) off|turned off/i.test(m.subject ?? "") && /wrong/i.test(m.text));

async function main(): Promise<void> {
  redis.clear();

  part(`Past ${EMAIL_CODE_FAILS_IN_A_ROW} wrong codes in a row, no code opens for the address; only the link`);
  const victim = "victim@code-cap.example";
  const first = await guess(victim, 6);
  is(`exactly ${EMAIL_CODE_FAILS_IN_A_ROW} wrong codes were judged, the rest refused`, [first.judged, first.refused], [EMAIL_CODE_FAILS_IN_A_ROW, 120 - EMAIL_CODE_FAILS_IN_A_ROW]);
  const fresh = await ask(victim);
  const right = await send(fresh.request, fresh.code);
  is("the right code of a fresh request: refused, no session", [right.status, right.error, right.session], [429, "code_address_blocked", ""]);
  advance(40 * 24 * HOUR);
  const later = await ask(victim);
  is("forty days later, still refused: the count does not lapse with a day or a week", (await send(later.request, later.code)).error, "code_address_blocked");

  part("The owner is told once, in plain words, with the way back in");
  const told = notices(victim);
  is("one notice to the address, no more", told.length, 1);
  is("it says the codes were wrong, that the link still works, and that nobody got in", [/wrong/i.test(told[0]?.text ?? ""), /link/i.test(told[0]?.text ?? ""), /nobody got in|no one got in/i.test(told[0]?.text ?? "")], [true, true, true]);

  part("A login with the link starts the count again");
  const viaLink = await ask(victim);
  const form = new URLSearchParams({ token: viaLink.token });
  const res = await callbackRoute(new NextRequest(`${ORIGIN}/api/auth/callback`, { method: "POST", headers: { Host: "marktmorgen.com", Origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: form }));
  const linked = (res.headers.get("set-cookie") ?? "").match(/nl_session=([0-9a-f]{64})/)?.[1] ?? "";
  is("the link opens a session", await emailForSession(linked), victim);
  advance(24 * HOUR);
  const again = await ask(victim);
  const opened = await send(again.request, again.code);
  is("after it, the right code opens again", [opened.ok, opened.session.length], [true, 64]);
  is("and no second notice was sent", notices(victim).length, 1);

  part("Fewer wrong codes than the ceiling, then a right one: the count starts again");
  const owner = "owner@code-cap.example";
  const some = await guess(owner, 4);
  is("eighty wrong codes judged", some.judged, 80);
  const good = await ask(owner);
  is("the right code opens", (await send(good.request, good.code)).ok, true);
  advance(24 * HOUR);
  const more = await guess(owner, 4);
  is("eighty more are judged: the ceiling counts wrong codes in a row, not in all", [more.judged, more.refused], [80, 0]);
  is("no notice", notices(owner).length, 0);

  part("A count of wrong codes that cannot be read refuses and opens nothing");
  const gus = "gus@code-cap.example";
  const asked = await ask(gus);
  for (const [label, reply] of [
    ["null", [null, 1]],
    ["text", ["1", 1]],
    ["negative", [-1, 1]],
    ["a short reply", [1]],
  ] as [string, unknown][]) {
    rule = { when: (c) => c.some((command) => command[0] === "INCR" && String(command[1]).startsWith("nl:rl:code-fails:")), reply };
    const refused = await send(asked.request, asked.code);
    rule = null;
    is(`the count answered as ${label}: server_error, no session`, [refused.status, refused.error, refused.session], [503, "server_error", ""]);
  }
  is("with exact replies the same code still opens", (await send(asked.request, asked.code)).ok, true);
  done();
}

void main();
