/**
 * Claude 7 HHH's MEDIO on #5380 (7110624357), coordinator's rule 964c (2): a fix that replaces a plain DEL by a fenced
 * script measures the whole real route, at its worst, against its scope's envelope. Here: the studio's Discord
 * "Disconnect" (POST /api/store/discord, action "disconnect", behind jsonAccess's "settings"), whose last step is now
 * DROP_SERVER_IF_EMPTY (EVAL, HLEN, DEL) in place of the plain DEL (and, with nobody kept, of HLEN and DEL).
 *
 * Every command is billed as Upstash bills it: a plain command is one, and a script is its EVAL plus every call written
 * in it (a bound on its worst branch), except FORGET_PEOPLE, whose loop is counted per person it names, from the script's
 * own text: its EVAL and the calls outside its loop once, and the calls inside its loop once a person (Claude 6 jAAv7's
 * MEDIO on #5380: the per-person figure is read from the script, never from DISCONNECT_COMMANDS_PER_PERSON, so a call
 * added to the loop makes this test fail until the figure and its registry line follow). The first press is not measured (it starts the store's windows). The request with
 * nobody kept must stay inside one studio unit's envelope (20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS); each
 * person kept adds exactly DISCONNECT_COMMANDS_PER_PERSON, the calls FORGET_PEOPLE makes for them, priced on its own
 * in the registry (NOT_A_COST.DISCONNECT_COMMANDS_PER_PERSON).
 *
 * Synthetic store, Redis stand-in and a stand-in fetch for Discord's leave (no network).
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DISCONNECT_COMMANDS_PER_PERSON, FORGET_PEOPLE, keepMember } from "@/lib/discord-store";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { LOCKED_UNTIL_STAR_COMMANDS, NOT_A_COST, TAKE_COMMANDS } from "./plan-cost-registry";
import { seedDiscordServer } from "./discord-server-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "discord.com" && (init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ message: "no stand-in" }), { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const ENVELOPE = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
const calls = (text: string) => (text.match(/redis\.call\(/g) ?? []).length;
/** FORGET_PEOPLE's loop body (between its one `for ... do` and the `end` that closes it), read from the script itself. */
const loop = /\nfor [^\n]* do\n([\s\S]*?)\nend\n/.exec(FORGET_PEOPLE)?.[1] ?? "";
const PER_PERSON = calls(loop);
const OUTSIDE_LOOP = calls(FORGET_PEOPLE) - PER_PERSON;
const OWNER = "owner@discord-disconnect-envelope.example";

async function main(): Promise<void> {
  process.env.DISCORD_CLIENT_ID = "400000000000000011";
  process.env.DISCORD_CLIENT_SECRET = "synthetic-secret";
  process.env.DISCORD_BOT_TOKEN = "synthetic-token";
  redis.clear();
  await claimHandle(OWNER, "discord-envelope", "Discord Envelope", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const session = await openSession(OWNER);
  const real = redis.pipeline.bind(redis);

  /** One Disconnect with `people` kept, measured whole: its answer, and the commands billed (each script's inside too). */
  const disconnect = async (people: number) => {
    await seedDiscordServer(room, { id: "223456789012345611", name: "Server", at: 1, kick: false });
    for (let i = 0; i < people; i += 1) {
      const id = `1234567890123456${String(10 + i)}`;
      await keepMember(room, store.sid, id, { e: `p${i}@discord-disconnect-envelope.example`, n: "buyer", p: ["p1"], r: ["323456789012345611"], at: 1, checked: 1 });
    }
    let billed = 0;
    redis.pipeline = (async (batch: Commands) => {
      for (const command of batch) {
        const script = command[0] === "EVAL" ? String(command[1]) : "";
        if (script.startsWith("-- marktmorgen:discord-forget-people:")) billed += 1 + OUTSIDE_LOOP + PER_PERSON * (Number(command[2]) - 2);
        else billed += script ? 1 + (script.match(/redis\.call\(/g) ?? []).length : 1;
      }
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const answer = await manageDiscord(
        new NextRequest(`https://marktmorgen.com/api/store/discord?store=${store.sid}`, {
          method: "POST",
          headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
          body: JSON.stringify({ action: "disconnect" }),
        }),
      );
      return { status: answer.status, body: (await answer.json()) as Record<string, unknown>, commands: billed };
    } finally {
      redis.pipeline = real;
    }
  };

  part("FORGET_PEOPLE's calls, read from the script");
  is("its loop is found, with the calls it makes for each person", loop.includes("HDEL") && PER_PERSON > 0, true);
  is("the calls a person costs in the script are DISCONNECT_COMMANDS_PER_PERSON, the figure the registry prices", PER_PERSON, DISCONNECT_COMMANDS_PER_PERSON);

  part("Nobody kept: the whole Disconnect stays inside one studio unit");
  await disconnect(0);
  const none = await disconnect(0);
  is("disconnected, nobody forgotten", [none.status, none.body], [200, { ok: true, people: 0 }]);
  is(`its ${none.commands} billed commands stay within one studio unit's ${ENVELOPE}`, none.commands > 0 && none.commands <= ENVELOPE, true);

  part("Each person kept adds exactly DISCONNECT_COMMANDS_PER_PERSON, priced on its own");
  const one = await disconnect(1);
  const three = await disconnect(3);
  is("one and three people disconnected", [one.status, one.body, three.status, three.body], [200, { ok: true, people: 1 }, 200, { ok: true, people: 3 }]);
  is("with people kept, the part that is not theirs stays within the envelope", one.commands - DISCONNECT_COMMANDS_PER_PERSON <= ENVELOPE && three.commands - 3 * DISCONNECT_COMMANDS_PER_PERSON <= ENVELOPE, true);
  is("each person kept adds the script's per-person calls, and the first one its EVAL and HLEN too", [one.commands - none.commands, (three.commands - one.commands) / 2], [PER_PERSON + 1 + OUTSIDE_LOOP, PER_PERSON]);
  is("its line in the registry names the route and the script", /app\/api\/store\/discord\/route\.ts/.test(NOT_A_COST.DISCONNECT_COMMANDS_PER_PERSON ?? "") && /FORGET_PEOPLE/.test(NOT_A_COST.DISCONNECT_COMMANDS_PER_PERSON ?? ""), true);
  console.log(`MEASURED none=${none.commands} one=${one.commands} three=${three.commands} envelope=${ENVELOPE}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
