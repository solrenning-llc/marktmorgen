/**
 * Review of #2556 at c6267d1ef (delta from df8030300).
 *   c  lib/store-forget-retry.ts FORGET_TRY_COMMANDS is said to be "the most Redis commands one try can send",
 *      but forgetStoreWebhooks deletes three day keys for every endpoint told in the last three days: up to
 *      MAX_ENDPOINTS a day (lib/webhooks.ts) on each of three days, besides the MAX_ENDPOINTS configured now.
 *   a  lib/two-step.ts KEPT_ANY_KEY: each failed endLocked APPENDs the account's tag again, so the one string
 *      every lockedUntil reads (the studio page, every load, every account) grows with each failure, not with
 *      each account.
 * Synthetic only.
 */
import { createHash } from "node:crypto";
import { openSession } from "@/lib/auth";
import { FORGET_TRY_COMMANDS, queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { LOG_SIZE } from "@/lib/webhooks";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { MAX_KEYS, makeKey } from "@/lib/api-keys";
import { cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("c: one try of a deleted store's forgetting, at its worst, against FORGET_TRY_COMMANDS");
  const STATS = "st_rv_forget";
  const SID = "b".repeat(32);
  const today = Math.floor(Date.now() / 86_400_000);
  const configured = Array.from({ length: MAX_ENDPOINTS }, (_, n) => ({ id: `we_${hex(n, 16)}`, url: `https://e${n}.example.com/`, secret: "whsec_x", events: [] }));
  const writes: Command[] = [["SET", `nl:hooks:cfg:${STATS}`, JSON.stringify({ handle: "gone", endpoints: configured, since: 0 })]];
  // Each of the last three days: MAX_ENDPOINTS other endpoints told (the store removed and added endpoints).
  for (const back of [0, 1, 2]) {
    for (let n = 0; n < MAX_ENDPOINTS; n += 1) writes.push(["SADD", `nl:hooks:wait:${STATS}:eps:${today - back}`, `we_${hex(100 + back * 10 + n, 16)}`]);
  }
  for (let n = 0; n < LOG_SIZE; n += 1) writes.push(["LPUSH", `nl:hooks:log:${STATS}`, `dlv_${hex(n, 24)}`]);
  await real(writes);
  for (let n = 0; n < MAX_KEYS; n += 1) await makeKey(SID, `Key ${n}`);
  await queueStoreForget(STATS, SID);
  let counted = 0;
  redis.pipeline = async (commands: Command[]) => {
    counted += commands.length;
    return real(commands);
  };
  const result = await retryStoreForgets(Date.now() + 30_000);
  redis.pipeline = real;
  is("(done)", result.done, 1);
  // The line's own HGETALL is the run's, not the try's.
  is("commands of the try stay within FORGET_TRY_COMMANDS", counted - 1 <= FORGET_TRY_COMMANDS ? "within" : `${counted - 1} > ${FORGET_TRY_COMMANDS}`, "within");

  part("a: the list of accounts kept locked grows with each failure, not with each account");
  const LOST = "rv3-lost@example.com";
  const setup = await startSetup(LOST, "e".repeat(64), "rv3-lost-backup@example.org");
  if (typeof setup === "string") throw new Error(setup);
  const finished = await finishSetup(LOST, "e".repeat(64), codeAt(base32Decode(setup.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS)), codeTo("rv3-lost-backup@example.org"));
  if (typeof finished === "string") throw new Error(finished);
  const any = `nl:2fa:lockedset:${sha("nimbus-2fa-lockedset:any account").slice(0, 40)}:kept`;
  for (let round = 0; round < 3; round += 1) {
    const entered = await enterLocked(await holdSignIn(LOST));
    if (!entered) throw new Error("not let in");
    redis.pipeline = async (commands: Command[]) =>
      (await real(commands)).map((reply, i) => (commands[i][0] === "SMEMBERS" && String(commands[i][1]).startsWith("nl:2fa:lockedset:") ? null : reply));
    await cancelReset(LOST, "studio");
    redis.pipeline = real;
  }
  const [list] = await real([["GET", any]]);
  const tags = String(list ?? "").split(" ").filter(Boolean);
  is("one account kept locked three times is listed once", [tags.length, new Set(tags).size], [1, 1]);
  // What every session of every other account reads on each studio page.
  const other = await openSession("rv3-other@example.com");
  is("(an unrelated session is not locked)", await lockedUntil(other), 0);

  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
