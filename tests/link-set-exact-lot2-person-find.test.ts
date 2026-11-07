/**
 * The studio's People search (lib/buyer-profile.ts findToken, behind
 * app/api/store/person/route.ts "find" and app/studio/people/page.tsx) swaps
 * the typed address for a token that opens that person's page for an hour. It
 * hands out a token only once Redis said it stored it (rule 24, the
 * signin-link-set-exact pattern, lot 2):
 *
 *   - a SET that got no answer, or an answer other than exactly "OK", gives
 *     no token (the route then says the search is unavailable, the page offers
 *     no deletion), instead of a link to a page that says the search ran out;
 *   - the token, in case it landed with its answer lost, is deleted, so the
 *     address is not left under a token nobody holds;
 *   - with Redis answering "OK", the token opens the person's page as before.
 */
import { addressForToken, findToken } from "@/lib/buyer-profile";
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

const FIND = "nl:person:find:";
const tokens = () => redis.keys().filter((key) => key.startsWith(FIND)).length;

async function main(): Promise<void> {
  redis.clear();
  const store = { sid: "sidfindset01" };

  part("Control: Redis answers OK, the token opens the person's page");
  const token = (await findToken(store, "buyer@example.com")) ?? "";
  is("a token that opens that address on this store", [token.length, await addressForToken(store, token)], [48, "buyer@example.com"]);

  part("A token whose SET was not confirmed: none handed out, none left");
  for (const [what, reply] of ODD) {
    for (const apply of [false, true]) {
      const before = tokens();
      const got = await setAnswered(FIND, reply, () => findToken(store, "buyer@example.com"), apply);
      const label = `${what}${apply ? " (the SET landed)" : ""}`;
      is(`${label}: no token`, got, null);
      is(`${label}: no token left holding the address`, tokens(), before);
    }
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
