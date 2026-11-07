/**
 * The yearly offer's emailed link (lib/yearly-switch.ts mintYearlyLink, used by
 * lib/yearly-ask.ts askStore) is handed out only once Redis said it stored it
 * (rule 24, the signin-link-set-exact pattern, lot 2):
 *
 *   - a SET that got no answer, or an answer other than exactly "OK", gives no
 *     link: mintYearlyLink throws an UnknownReplyError, so askStore's own catch
 *     sends no paid email and lets the offer's claim go for the next run;
 *   - the link, in case it landed with its answer lost, is deleted first, so no
 *     link to a member's switch is left that nobody got;
 *   - with Redis answering "OK", the link opens this one move, as before.
 */
import { grantFor, mintYearlyLink } from "@/lib/yearly-switch";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

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

const LINK = "nl:yearly:link:";
const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;

async function main(): Promise<void> {
  redis.clear();
  const store = { handle: "harbor", stripeAccountId: "acct_1TestYearlySet1" } as unknown as Store;

  part("Control: Redis answers OK, the link opens this one move");
  const token = await mintYearlyLink(store, "cus_Dana000001", "sub_Dana00000001");
  is("this membership, by the emailed link", (await grantFor(store, token, "sub_Dana00000001"))?.emailed, true);

  part("A link whose SET was not confirmed: none handed out, none left");
  for (const [what, reply] of ODD) {
    for (const apply of [false, true]) {
      const before = links();
      const got = await setAnswered(LINK, reply, () => mintYearlyLink(store, "cus_Dana000001", "sub_Dana00000001").then(
        (value) => ({ token: value }),
        (error: unknown) => ({ error }),
      ), apply);
      const label = `${what}${apply ? " (the SET landed)" : ""}`;
      is(`${label}: no link, refused as an unknown reply`, "error" in got && got.error instanceof UnknownReplyError, true);
      is(`${label}: no link left behind`, links(), before);
    }
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
