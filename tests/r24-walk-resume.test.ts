/**
 * Rule 24 in the daily store walks' resume points (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * sendWinBacks, sendMemberNudges, recoverFailedPayments, sweepCheckouts and sendVerified keep where the last run
 * stopped as "cursor|done" and read it back loosely: a reply that was not a string started over from the first store,
 * a cursor that was not digits became "0" and a count that was not a number became 0. A run that started over wrote
 * its own position over the kept one, so a resume point that did not read once sent the walk back to the beginning,
 * and a walk that keeps reaching its deadline never got to the stores at the end of the list. Now the point is read
 * exactly (lib/store-walk-resume.ts): absent is the start, "digits|digits" is itself, anything else throws
 * UnknownReplyError before any store is read and nothing is written over the kept point.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no store exists, so nothing is sent or read from Stripe.
 */
import { resumePoint } from "@/lib/store-walk-resume";
import { sendWinBacks } from "@/lib/winback-send";
import { sendMemberNudges } from "@/lib/member-nudge";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { sendVerified } from "@/lib/verified-numbers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_walk_resume_stand_in";
process.env.RESEND_API_KEY = "re_r24_walk_resume_stand_in";

const jobs: [string, string, () => Promise<unknown>][] = [
  ["sendWinBacks", "nl:wb:cursor", () => sendWinBacks(Date.now() + 5_000)],
  ["sendMemberNudges", "nl:nudge:cursor", () => sendMemberNudges(Date.now() + 5_000)],
  ["recoverFailedPayments", "nl:dun:cursor", () => recoverFailedPayments(Date.now() + 5_000)],
  ["sweepCheckouts", "nl:sweep:cursor", () => sweepCheckouts(Date.now() + 5_000)],
  ["sendVerified", "nl:verified:cursor", () => sendVerified(Date.now() + 5_000)],
];
const garbled = ["x|3", "3|x", "3", "3|", "1|-2", "01|2", "3|2|1", "3|1.5"];

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ran";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("resumePoint reads a kept point exactly");
  is("absent is the start", resumePoint([null]), { cursor: "0", skip: 0 });
  is("digits|digits is itself", resumePoint(["1234|7"]), { cursor: "1234", skip: 7 });
  for (const value of [...garbled, 3, true, { error: "ERR synthetic" }]) is(`${JSON.stringify(value)} is unknown`, resumePoint([value]), null);
  is("no reply is unknown", resumePoint([]), null);
  is("not a list is unknown", resumePoint("QUEUED"), null);

  for (const [name, key, run] of jobs) {
    part(`${name}: a kept point that does not read stops the run and is never written over`);
    for (const value of garbled) {
      redis.clear();
      redis.run(["SET", key, value]);
      is(`${JSON.stringify(value)}: unknown`, await outcome(run), "unknown");
      is("the kept point is left as it was", redis.run(["GET", key]), value);
    }
    part(`${name}: control`);
    redis.clear();
    is("no kept point: the run goes from the start", await outcome(run), "ran");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
