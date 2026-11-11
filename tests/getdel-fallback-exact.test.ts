/**
 * Rule 24 (CX-123), rule 30 siblings: the one-time links and states of sign-in are spent with GETDEL, and where
 * GETDEL throws (a Redis without it), with GET then DEL, where only the caller whose DEL removed the key wins. That
 * win was read with `Number(removed) === 1`, which takes "1", true or [1] for a removal: a DEL that removed nothing
 * (another request already spent the link) but answers in another shape let the same link be spent again. Found by
 * Claude 3 (nuvem C) in the security audit of sign-in, sessions and the team, 11 November 2026: lib/auth.ts
 * spendMoveLink and takeGoogleState, lib/recovery-address.ts spendLostEmailLink (and the same line in lib/passkeys.ts
 * spend and lib/team.ts spendInvite, whose later checks already refuse a value read this way).
 *
 * Expected: only a DEL answering exactly 1 wins; any other answer spends nothing. Control: with GETDEL missing and a
 * real DEL, a link is spent once and then never again. Synthetic only: the Redis stand-in, with GETDEL made to throw.
 */
import { keepGoogleState, openSession, spendMoveLink, takeGoogleState } from "@/lib/auth";
import { spendLostEmailLink } from "@/lib/recovery-address";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = real;
};
/** GETDEL throws, as on a Redis without it; the GET that follows reads `value` and the DEL answers `removed` without deleting. */
function fallbackAnswers(value: string, removed: unknown): void {
  let spent = "";
  redis.pipeline = (async (commands: Command[]) => {
    const [first] = commands;
    if (first?.[0] === "GETDEL") {
      spent = String(first[1]);
      throw new Error("ERR unknown command 'GETDEL'");
    }
    if (commands.length === 1 && first?.[0] === "GET" && String(first[1]) === spent) return [value];
    if (commands.length === 1 && first?.[0] === "DEL" && String(first[1]) === spent) return [removed];
    return real(commands);
  }) as typeof redis.pipeline;
}
/** GETDEL throws; GET and DEL are the stand-in's own. */
function noGetdel(): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands[0]?.[0] === "GETDEL") throw new Error("ERR unknown command 'GETDEL'");
    return real(commands);
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};

  part("Control: GETDEL missing, a real DEL: spent once");
  noGetdel();
  try {
    await keepGoogleState("s".repeat(43), "verifier-and-nonce");
    is("a Google state, first answer", await takeGoogleState("s".repeat(43)), "verifier-and-nonce");
    is("a Google state, the same answer again", await takeGoogleState("s".repeat(43)), null);
  } finally {
    restore();
  }

  const asker = await openSession("from@example.com");
  const moveValue = JSON.stringify({ from: "from@example.com", to: "to@example.com", session: asker });
  for (const [label, removed] of [["\"1\"", "1"], ["true", true], ["[1]", [1]], ["\"01\"", "01"]] as [string, unknown][]) {
    part(`A DEL that answers ${label} and removed nothing`);
    fallbackAnswers("verifier-and-nonce", removed);
    try {
      is(`${label}: a Google state is not spent`, await takeGoogleState("t".repeat(43)), null);
    } finally {
      restore();
    }
    fallbackAnswers(moveValue, removed);
    try {
      is(`${label}: a move link is not spent`, await spendMoveLink("a".repeat(64)), null);
    } finally {
      restore();
    }
    fallbackAnswers("owner@example.com", removed);
    try {
      is(`${label}: a lost-inbox link is not spent`, await spendLostEmailLink("b".repeat(64)), null);
    } finally {
      restore();
    }
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
