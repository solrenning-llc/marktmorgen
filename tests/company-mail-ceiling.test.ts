/**
 * The emails a stranger can ask us to send have a ceiling for the whole
 * company, counted before anything is looked up or sent (MR rule: every
 * spend has an automatic ceiling before it happens). The per-connection
 * and per-address limits bound one machine and one inbox; machines and
 * addresses that change bound nothing on their own. So each queue (the
 * login link, the recovery-address link, the deletion link) counts every
 * ask in the hour, whoever asks and whatever the address:
 *
 *   - within its ceiling, nothing changes;
 *   - past it, nothing is sent and the answer says so plainly, the same for
 *     an address with an account and one without (the count is taken
 *     before anything about the address is read);
 *   - a count that cannot be read sends nothing and is our side's trouble,
 *     never room (CX-123 rule 24).
 */
import { NextRequest } from "next/server";
import { POST as signInRoute } from "@/app/api/auth/request/route";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { askErasureLink } from "@/lib/erasure-request";
import {
  COMPANY_MAIL_BUSY,
  ERASE_LINKS_PER_HOUR,
  LOST_EMAIL_LINKS_PER_HOUR,
  SIGN_IN_LINKS_PER_HOUR,
} from "@/lib/company-mail-ceiling";
import { store as redis } from "./redis-stub";
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

const ORIGIN = "https://marktmorgen.com";
let n = 0;
const nextIp = () => {
  n += 1;
  return `198.51.${Math.floor(n / 250) % 250}.${n % 250}`;
};

const signIn = (email: string) =>
  signInRoute(
    new NextRequest(`${ORIGIN}/api/auth/request`, {
      method: "POST",
      headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ email }),
    }),
  );

const lost = (email: string) => {
  const form = new FormData();
  form.set("email", email);
  return lostRoute(
    new NextRequest(`${ORIGIN}/api/auth/lost`, {
      method: "POST",
      headers: { Host: "marktmorgen.com", Origin: ORIGIN, "x-forwarded-for": nextIp() },
      body: form,
    }),
  );
};

async function main(): Promise<void> {
part("the ceilings are named, positive whole numbers, and the busy answer is plain");
for (const [name, value] of Object.entries({ SIGN_IN_LINKS_PER_HOUR, LOST_EMAIL_LINKS_PER_HOUR, ERASE_LINKS_PER_HOUR })) {
  is(`${name} is a positive whole number`, Number.isSafeInteger(value) && value > 0, true);
}
is("the busy answer", COMPANY_MAIL_BUSY, "We couldn't send the email right now. Try again in an hour.");

part("login links: every ask in the hour counts, past the ceiling nothing is sent");
{
  const before = mail.sent.length;
  let refused = 0;
  for (let i = 0; i < SIGN_IN_LINKS_PER_HOUR; i += 1) {
    const res = await signIn(`stranger${i}@example.com`);
    if (res.status !== 200) refused += 1;
  }
  is("every ask within the ceiling is answered", refused, 0);
  is("each one within the ceiling is emailed", mail.sent.length - before, SIGN_IN_LINKS_PER_HOUR);
  const past = await signIn("one-more@example.com");
  const body = (await past.json()) as { ok?: boolean; error?: string };
  is("past the ceiling the answer is 503", past.status, 503);
  is("past the ceiling the answer says the email could not be sent", body.error, "mail_busy");
  is("past the ceiling nothing is sent", mail.sent.length - before, SIGN_IN_LINKS_PER_HOUR);
}

part("login links: a count that cannot be read sends nothing");
{
  redis.clear();
  rule = { when: (c) => c.some((x) => x[0] === "INCR" && String(x[1]).includes("company-mail")), reply: [null, "not a number"] };
  const before = mail.sent.length;
  const res = await signIn("unknown-count@example.com");
  rule = null;
  is("an unknown count answers 503", res.status, 503);
  is("an unknown count sends nothing", mail.sent.length - before, 0);
}

part("recovery-address links: counted before the account is looked up, past the ceiling the page says so");
{
  redis.clear();
  for (let i = 0; i < LOST_EMAIL_LINKS_PER_HOUR; i += 1) {
    const res = await lost(`nobody${i}@example.com`);
    is(`ask ${i} within the ceiling is told it was received`, res.headers.get("location")?.endsWith("status=sent"), true);
  }
  const past = await lost("nobody-more@example.com");
  is("past the ceiling the page is told the email could not be sent", past.headers.get("location")?.endsWith("status=busy"), true);
}

part("deletion links: past the ceiling the answer is busy, for every address alike");
{
  redis.clear();
  for (let i = 0; i < ERASE_LINKS_PER_HOUR; i += 1) {
    const asked = await askErasureLink({ email: `person${i}@example.com`, ip: nextIp(), origin: ORIGIN });
    is(`ask ${i} within the ceiling`, asked.status, "sent");
  }
  const past = await askErasureLink({ email: "person-more@example.com", ip: nextIp(), origin: ORIGIN });
  is("past the ceiling the answer is busy", past.status, "busy");
}

}

main().then(done);
