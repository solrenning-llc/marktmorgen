/**
 * The end of a move of the sign-in address sends company emails (app/api/auth/move tellMoved: the old address every
 * time, the new one when something did not come along), so how many moves one account can finish has a ceiling,
 * counted before the move does anything (Claude 7's review of #3326, MEDIUM: a pace of five asks an hour per address
 * was the only bound, about 3,600 moves a month for one account). Checked, through the real route:
 *
 *   - controls: an account finishes up to the ceiling's moves in the window, each across a new address, and each is
 *     told as before;
 *   - one more is refused before anything moves: the store stays at its address, no email goes, and the page says why;
 *   - the count follows the store, not the address, so a chain of new addresses does not start it again;
 *   - another account's store has its own count;
 *   - a count that cannot be read moves nothing and sends nothing (rule 24), and says so;
 *   - the sign-in page has words for the refusal, with the ceiling's number.
 *
 * Synthetic: the Redis stand-in, with the counter's pipeline answered wrong for one case, and a fetch stub for the
 * email provider.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { openSession, sendMoveLink } from "@/lib/auth";
import { claimHandle, storeForEmail } from "@/lib/store";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** The ceiling the route is held to: lib/move-pace.ts MOVES_PER_30_DAYS, typed here so a change to it is a decision. */
const CEILING = 10;
const FINISHED = "The email your Marktmorgen account logs in with changed";
const post = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

let n = 0;
/** One move of the account now at `from` through the real route, to a new address; `fault` answers chosen pipelines. */
async function move(from: string, fault: ((commands: Command[]) => Promise<unknown[]> | null) | null = null) {
  n += 1;
  const to = `move-pace-${n}@example.com`;
  const asker = await openSession(from);
  mails.length = 0;
  await sendMoveLink(from, to, "https://marktmorgen.com", asker);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  mails.length = 0;
  redis.pipeline = async (commands: Command[]) => (fault?.(commands) ?? real(commands));
  const quiet = console.error;
  console.error = () => {};
  let location: string | null;
  try {
    location = (await moveRoute(post("https://marktmorgen.com/api/auth/move", { token }))).headers.get("location");
  } finally {
    redis.pipeline = real;
    console.error = quiet;
  }
  const moved = Boolean(await storeForEmail(to)) && !(await storeForEmail(from));
  return { location, moved, sent: mails.length, toldFrom: mails.some((m) => m.to === from && m.subject === FINISHED), from, to };
}

async function main() {
  part("controls: up to the ceiling, every move finishes and is told");
  const first = "move-pace-owner@example.com";
  await claimHandle(first, "move-pace-a", "Mover", "");
  let at = first;
  const finished: boolean[] = [];
  const told: boolean[] = [];
  for (let i = 0; i < CEILING; i += 1) {
    const out = await move(at);
    finished.push(out.moved && out.location === "https://marktmorgen.com/studio?address=moved");
    told.push(out.toldFrom);
    if (out.moved) at = out.to;
  }
  is(`all ${CEILING} moves finish, each to a new address`, finished, Array(CEILING).fill(true));
  is("the old address of each is told the move finished", told, Array(CEILING).fill(true));

  part("one more is refused before anything moves");
  const over = await move(at);
  is(
    "past the ceiling: nothing moved, no email, the sign-in page says why",
    [over.location, over.moved, Boolean(await storeForEmail(at)), over.sent],
    ["https://marktmorgen.com/signin?status=move-limited", false, true, 0],
  );

  part("another account's store has its own count");
  const other = "move-pace-other@example.com";
  await claimHandle(other, "move-pace-b", "Other", "");
  const theirs = await move(other);
  is("another store moves", [theirs.location, theirs.moved], ["https://marktmorgen.com/studio?address=moved", true]);

  part("a count that cannot be read moves nothing and sends nothing (rule 24)");
  const third = "move-pace-third@example.com";
  await claimHandle(third, "move-pace-c", "Third", "");
  // The counter's pipeline (SET … NX then INCR on a rate key) answered in a shape that is not a count.
  const unread = await move(third, (commands) =>
    commands.some((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:rl:move-done:")) ? Promise.resolve(commands.map(() => "not a count")) : null,
  );
  is(
    "unknown count: not moved, no email, said as a move that could not finish just now",
    [unread.location, unread.moved, Boolean(await storeForEmail(third)), unread.sent],
    ["https://marktmorgen.com/signin?status=move-unread", false, true, 0],
  );

  part("the sign-in page has words for the refusal");
  const signin = readFileSync("app/signin/page.tsx", "utf8");
  is(
    "move-limited is a status, naming the ceiling and that nothing changed",
    [signin.includes('"move-limited": {'), signin.includes(`can change ${CEILING} times in 30 days`), /"move-limited": \{[^}]*Nothing was changed\./.test(signin)],
    [true, true, true],
  );
  done();
}

void main();
