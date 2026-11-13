/**
 * The membership-move reminders' line (lib/move-members.ts, dueReminders) when a run stops part-way (webhooks/cron
 * audit, Claude 1, 12/11/2026). The reminders due were taken off the line (ZREM) before any was looked at, and only
 * a reminder put back by the caller (remindLater) came back. A run that stopped after the ZREM (the function cut
 * off, or Redis failing for the put-back too, which throws out of sendMoveReminders) lost every reminder it had
 * taken: those members were never reminded to keep their membership before it renewed elsewhere. Now the reminders
 * due are leased (moved a short while ahead, only if still in line), so one a run did not finish comes due again on
 * its own; a reminder the run finished is taken off the line as before.
 * Synthetic only: an in-memory Redis and the SES mail fixture.
 */
import { sendMoveReminders } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const fixture = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 }) });
fixture.configure();

const DUE = "nl:mv:due";
const ONE = "0123456789abcdef0123456789abcdef|0123456789abcdef0123456789abcdef:alpha";
const TWO = "0123456789abcdef0123456789abcdef|0123456789abcdef0123456789abcdef:beta";

const plain = redis.pipeline.bind(redis);
let down = false;
let linePassed = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (down && linePassed) throw new Error("redis is down (synthetic)");
  const answer = await plain(commands);
  if (down && commands.some((c) => (c[0] === "ZREM" || c[0] === "ZADD") && c[1] === DUE)) linePassed = true;
  return answer;
}) as typeof redis.pipeline;

const score = async (member: string) => (await plain([["ZSCORE", DUE, member]]))[0];

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const now = Date.now();
  await plain([["ZADD", DUE, Math.floor(now / 1000) - 60, ONE, Math.floor(now / 1000) - 60, TWO]]);

  part("Redis failing once the line is read: nobody the run took is lost");
  down = true;
  let threw = false;
  try {
    await sendMoveReminders(Date.now() + 30_000, now);
  } catch {
    threw = true;
  }
  down = false;
  is("the run fails, as it does today", threw, true);
  is("the first reminder is still in line", (await score(ONE)) !== null, true);
  is("and so is the one the run never reached", (await score(TWO)) !== null, true);

  part("A finished reminder still leaves the line");
  // The store behind these reminders does not exist: each is finished on the spot (nothing to send), and goes.
  await plain([["ZADD", DUE, Math.floor(now / 1000) - 60, ONE, Math.floor(now / 1000) - 60, TWO]]);
  await sendMoveReminders(Date.now() + 30_000, now);
  is("both are off the line", [await score(ONE), await score(TWO)], [null, null]);
  done();
}

void main();
