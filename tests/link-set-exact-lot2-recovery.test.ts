/**
 * /signin/lost (lib/recovery-address.ts sendLostEmailLink) emails a link that
 * logs in to an account through its recovery address only once Redis said it
 * stored that link (rule 24, the signin-link-set-exact pattern, lot 2):
 *
 *   - a SET of the link that got no answer, or an answer other than exactly
 *     "OK", sends no email at all (no link that may open nothing, and no notice
 *     to the sign-in inbox about a link that never went), and the link, in case
 *     it landed with its answer lost, is deleted, so no way in is left live;
 *   - the route's answer is the same as for an address with no account;
 *   - with Redis answering "OK", the link goes and logs in once.
 */
import { NextRequest } from "next/server";
import { keepRecoveryAddress, sendLostEmailLink, spendLostEmailLink } from "@/lib/recovery-address";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

/** Runs `work` with the one-command SET of a key starting with `prefix` answered by `reply`; with `apply` the SET is still made. */
async function setAnswered<T>(prefix: string, reply: unknown[], work: () => Promise<T>, apply: boolean): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(prefix)) {
      if (apply) await original.call(redis, commands);
      return reply;
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const ODD: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["an undefined reply", [undefined]],
  ["a reply of another word", ["QUEUED"]],
  ["two replies for one command", ["OK", "OK"]],
];

const LINK = "nl:auth:rec:link:";
const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;
const post = (fields: Record<string, string>, ip: string) =>
  new NextRequest("https://marktmorgen.com/api/auth/lost", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams(fields),
  });

async function main(): Promise<void> {
  redis.clear();
  let n = 0;
  const account = async () => {
    n += 1;
    const signIn = `maker${n}@example.com`;
    const spare = `spare${n}@example.org`;
    await keepRecoveryAddress(signIn, spare);
    return { signIn, spare };
  };

  part("Control: Redis answers OK, the link goes and logs in once");
  const control = await account();
  await sendLostEmailLink(control.signIn, "198.51.100.1", "https://marktmorgen.com");
  const token = /signin\/lost\/confirm\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === control.spare)?.text ?? "")?.[1] ?? "";
  is("the link went to the recovery address, and the sign-in address was told", [token.length, mails.some((m) => m.to === control.signIn)], [64, true]);
  is("it logs in to that account once", [await spendLostEmailLink(token), await spendLostEmailLink(token)], [control.signIn, null]);

  part("A link whose SET was not confirmed: no email, no link left");
  for (const [what, reply] of ODD) {
    for (const apply of [false, true]) {
      const { signIn, spare } = await account();
      const before = mails.length;
      const linksBefore = links();
      await setAnswered(LINK, reply, () => sendLostEmailLink(signIn, `198.51.100.${n + 1}`, "https://marktmorgen.com"), apply);
      const label = `${what}${apply ? " (the SET landed)" : ""}`;
      is(`${label}: nothing is emailed, to the recovery address or the sign-in one`, mails.slice(before).filter((m) => m.to === spare || m.to === signIn).length, 0);
      is(`${label}: no way in is left behind`, links(), linksBefore);
    }
  }

  part("The page answers the same: an account with a recovery address and an unconfirmed link, and no account at all");
  const asked = await account();
  const odd = await setAnswered(LINK, [null], () => lostRoute(post({ email: asked.signIn }, "198.51.100.200")), true);
  const nobody = await lostRoute(post({ email: "nobody@example.com" }, "198.51.100.201"));
  is("the same place, the same status", [odd.status, odd.headers.get("location")], [nobody.status, nobody.headers.get("location")]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
