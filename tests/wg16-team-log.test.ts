/**
 * 656 [WG16] unit 7, rule 23 / rule 24 (CX-123): the team's activity log
 * (lib/team.ts readLog) read a reply in an unknown shape as "no lines", so
 * the studio's Team page said "Nothing yet." while there was activity, and the
 * removal of a teammate (app/api/store/team/route.ts) read an unknown log as
 * "never taken off before". Now:
 *
 *   - readLog answers null for a reply of another type, a missing reply or a
 *     line that is not text; only Redis's own empty list is "none", and a line
 *     that is itself not readable is still skipped, as before;
 *   - the Team page says the activity could not be read, in a role=status
 *     note, and uses the studio's empty state only when the log is empty;
 *   - removing an address with the log unread: a teammate on the team is taken
 *     off as ever; an address not on the team is "unsure" (503), and nothing
 *     is swept, written or emailed, since nobody can tell a repeated removal
 *     from a mistyped address.
 *
 * Synthetic store and sessions, in-memory Redis; no email leaves.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { logTeam, putMember, readLog, readTeam } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  sent.push(String(input));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const realPipeline = redis.pipeline.bind(redis);
type Answer = (commands: (string | number)[][], real: unknown[]) => unknown;
let shape: Answer | null = null;
const written: string[] = [];
(redis as unknown as { pipeline: typeof realPipeline }).pipeline = async (commands) => {
  for (const c of commands) if (["LPUSH", "SET", "HSET", "DEL", "SADD", "ZADD"].includes(String(c[0]))) written.push(`${c[0]} ${c[1]}`);
  const real = await realPipeline(commands);
  return (shape ? shape(commands, real) : real) as Awaited<ReturnType<typeof realPipeline>>;
};
const lrange = (reply: unknown): Answer => (commands, real) => commands.map((c, i) => (String(c[0]) === "LRANGE" ? reply : real[i]));
const safely = async <T>(read: () => Promise<T>): Promise<T | "threw"> => {
  try {
    return await read();
  } catch {
    return "threw";
  }
};

const ORIGIN = "https://marktmorgen.com";
const OWNER = "team-owner@example.com";
const MATE = "mate@example.com";

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Harbor Goods", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const store = await paidStore(OWNER, "harborteam");
  const empty = await paidStore("quiet-owner@example.com", "quietteam");
  await logTeam(store.sid!, { who: OWNER, role: "owner", what: "Changed the store's name" });

  part("Read whole: the log as kept, and Redis's own empty list is none");
  is("the line is read", (await readLog(store.sid!))?.map((l) => l.what), ["Changed the store's name"]);
  is("a store with no activity: an empty list", await readLog(empty.sid!), []);

  part("An unknown reply is unknown (null), never no lines");
  for (const [name, answer] of [
    ["the list answered as a number", lrange(3)],
    ["the list answered as text", lrange("x")],
    ["a line that is not text", lrange([7])],
    ["no reply at all", (() => []) as Answer],
  ] as [string, Answer][]) {
    shape = answer;
    is(`${name}: null`, await safely(() => readLog(store.sid!)), null);
    shape = null;
  }
  shape = lrange(["{not json", JSON.stringify({ at: "2026-11-08T00:00:00.000Z", who: OWNER, role: "owner", what: "Kept" })]);
  is("a line that is itself not readable is skipped, as before; the rest is read", (await readLog(store.sid!))?.map((l) => l.what), ["Kept"]);
  shape = null;

  part("Removing someone while the log cannot be read");
  const session = await openSession(OWNER);
  const remove = async (email: string) => {
    const response = await teamRoute(
      new NextRequest(`${ORIGIN}/api/store/team?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
        body: JSON.stringify({ action: "remove", email }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
  };
  shape = lrange(3);
  written.length = 0;
  const beforeMail = sent.length;
  const typo = await remove("never-here@example.com");
  is("an address not on the team, log unread: unsure (503), not 'not on the team'", [typo.status, typo.body.error], [503, "unsure"]);
  // The route's own count of studio requests (nl:allow:studio:...) is taken for every call; nothing else may be written.
  is("and nothing is written or emailed for it", [written.filter((w) => !w.includes(" nl:allow:")), sent.length - beforeMail], [[], 0]);
  shape = null;
  await putMember(store, MATE, "support");
  shape = lrange(3);
  const mate = await remove(MATE);
  shape = null;
  is("a teammate on the team, log unread: taken off as ever", [mate.status, mate.body.ok, (await readTeam(store.sid!)).members.some((m) => m.email === MATE)], [200, true, false]);

  // Claude 4 on #3164 (LEVE): a line of the log that does not read is skipped, so "never taken off" cannot be read
  // from what is left: it may be the very "Took x off the team" line a failed key sweep wrote (KeysNotSwept), whose
  // second press must sweep that person's API keys again. Unsure, then, with nothing swept, written or emailed.
  part("Removing someone while a line of the log does not read");
  const took = JSON.stringify({ at: "2026-11-08T00:00:00.000Z", who: OWNER, role: "owner", what: "Took gone-mate@example.com off the team" });
  shape = lrange(["{not json", took]);
  written.length = 0;
  const mailBefore = sent.length;
  const half = await remove("someone-else@example.com");
  is("an address not on the team, a line unread: unsure (503), not 'not on the team'", [half.status, half.body.error], [503, "unsure"]);
  is("and nothing is written or emailed for it", [written.filter((w) => !w.includes(" nl:allow:")), sent.length - mailBefore], [[], 0]);
  const again = await remove("gone-mate@example.com");
  shape = null;
  is("the person the readable lines show taken off: still a repeat, answered as already off", [again.status, again.body.ok], [200, true]);
  shape = lrange([JSON.stringify({ at: "2026-11-08T00:00:00.000Z", who: OWNER, role: "owner", what: "Changed the store's name" })]);
  const whole = await remove("never-here-2@example.com");
  shape = null;
  is("a log read whole that never shows the address: not on the team, as before", [whole.status, whole.body.error], [404, "not_found"]);

  part("The Team page says the activity could not be read, instead of 'Nothing yet.'");
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is(
    "unread: a status note",
    page.includes('{log === null ? (\n              <p role="status" className="notice notice-warn mt-4">\n                The activity could not be read just now. Reload this page in a moment; this does not mean nothing happened.\n              </p>\n            ) : log.length === 0 ? ('),
    true,
  );
  is("empty: the studio's empty state, an h3 under the section's h2", /log\.length === 0 \? \(\n\s+<StudioEmptyState\n\s+level=\{3\}\n\s+compact\n\s+className="mt-4"\n\s+title="No activity yet"/.test(page), true);
  is("no bare 'Nothing yet.' left", page.includes(">Nothing yet.<"), false);
  const manager = readFileSync("components/team-manager.tsx", "utf8");
  is("the studio explains 'unsure' in plain words", /unsure: "We could not check the team's activity just now, so nothing was changed\. Try again in a moment\."/.test(manager), true);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
