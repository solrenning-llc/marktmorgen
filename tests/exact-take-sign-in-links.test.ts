/**
 * The one-time values of a passkey sign-in, the rescue link of two-step login and the lost-inbox link are spent in
 * their exact shape (CX-123 rule 24; #4060, #4061, Codex G, HIGH). Each took GETDEL's reply by destructuring, so an
 * answer with one reply more (the real value and something after it) was taken as spent: a passkey's challenge was
 * handed to WebAuthn and the account opened, a rescue link turned two-step login off, a lost-inbox link logged in.
 * Now they go through lib/redis-take-once.ts takeOnce, and an answer of any other shape opens nothing.
 * Controls: the exact answers still work, once. Synthetic passkey, links and Redis (tests/redis-stub.ts); no email
 * leaves (Resend is a stand-in, with a key literal of tests/resend-fixture-credentials.ts).
 */
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { finishSetup, holdSignIn, sendRescue, spendRescue, startSetup, twoStepOn } from "@/lib/two-step";
import { signInOptions, signInWith } from "@/lib/passkeys";
import { keepRecoveryAddress, sendLostEmailLink, spendLostEmailLink } from "@/lib/recovery-address";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_two_step_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (new URL(url).hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs `work` with every GETDEL of a key starting with `prefix` answered by its real reply and one reply more. */
async function extraOnGetdel<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands[0]?.[0] === "GETDEL" && String(commands[0][1]).startsWith(prefix) ? [...replies, "extra"] : replies;
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const lastTo = (to: string, pattern: RegExp) => pattern.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};

  part("A passkey sign-in (#4060)");
  const PK = "pk@exact-links.example";
  const key = makePasskey(PK, "cred-exact-links-1");
  await key.keep();
  const bentStart = await signInOptions();
  const bent = await extraOnGetdel("nl:pk:auth:", () => signInWith(bentStart.nonce, key.answer(bentStart.options.challenge) as never));
  is("one reply more: no sign-in", bent, null);
  const start = await signInOptions();
  const plain = await signInWith(start.nonce, key.answer(start.options.challenge) as never);
  is("control: the exact answer signs in", plain?.email, PK);

  part("The rescue link of two-step login (#4061)");
  /** An account with two-step login on and a recovery address, and a rescue link sent to it. */
  const rescueLinkFor = async (email: string, session: string) => {
    const backup = `backup.${email}`;
    const started = await startSetup(email, session, backup);
    if (typeof started === "string") throw new Error(`setup: ${started}`);
    if (typeof (await finishSetup(email, session, nowCode(started.secret), lastTo(backup, /Your code: (\d{6})/))) === "string") throw new Error("not set");
    if ((await sendRescue(await holdSignIn(email), "https://marktmorgen.com")) !== "sent") throw new Error("no rescue link");
    return lastTo(backup, /signin\/rescue\?token=([0-9a-f]{64})/);
  };
  const RESCUE = "rescue@exact-links.example";
  const bentLink = await rescueLinkFor(RESCUE, "c".repeat(64));
  is("one reply more: nothing turned off, nobody logged in", [await extraOnGetdel("nl:2fa:rescue:", () => spendRescue(bentLink)), await twoStepOn(RESCUE)], [null, true]);
  const CALM = "calm@exact-links.example";
  const calmLink = await rescueLinkFor(CALM, "d".repeat(64));
  is("control: the exact answer turns it off, once", [await spendRescue(calmLink), await twoStepOn(CALM), await spendRescue(calmLink)], [CALM, false, null]);

  part("The lost-inbox link (#4061)");
  const LOST = "lost@exact-links.example";
  const LOST_BACKUP = "lost.backup@exact-links.example";
  await keepRecoveryAddress(LOST, LOST_BACKUP);
  const lostLink = async () => {
    await sendLostEmailLink(LOST, "192.0.2.80", "https://marktmorgen.com");
    return lastTo(LOST_BACKUP, /signin\/lost\/confirm\?token=([0-9a-f]{64})/);
  };
  is("one reply more: no login", await extraOnGetdel("nl:auth:rec:link:", async () => spendLostEmailLink(await lostLink())), null);
  const token = await lostLink();
  is("control: the exact answer logs in, once", [await spendLostEmailLink(token), await spendLostEmailLink(token)], [LOST, null]);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
