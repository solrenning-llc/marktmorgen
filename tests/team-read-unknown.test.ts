/**
 * A team record read in another shape is never taken for an empty team
 * (Claude 4's sweep, C4-2910, sweepA7 P3): a reply that is not the one GET's,
 * a value that is not text, text that is not a team, or a team whose lists
 * are not lists stops the change and asks for the second step, instead of
 * writing the team back without its members or letting a member in past the
 * owner's two-step rule. A store with no team record at all still reads as an
 * empty team.
 */
import { NO_TEAM_SID } from "./team-read-unknown-world";
import { inviteMember, putMember, readTeam, removeMember, setRequireTwoStep, teamTwoStepBlocks } from "@/lib/team";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "owner-team-read@example.com";
const AMY = "amy-admin@example.com";
const BEN = "ben-support@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "team-read", "Team Read", "");
  const store = (await ensureStoreId((await storeForEmail(OWNER))!.email)) ?? (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  await putMember(store, AMY, "admin");
  await putMember(store, BEN, "support");
  await setRequireTwoStep(store, true, OWNER);
  const key = `nl:team:${store.sid}`;
  const kept = await redis.pipeline([["GET", key]]).then(([raw]) => String(raw));
  const pipe = redis.pipeline.bind(redis);
  /** Answers the team's GET with `shape` once per GET, leaving every other command as it is. */
  const answering = (shape: (real: unknown) => unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipe(commands);
      return commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key ? [shape(replies[0])] : replies;
    }) as typeof redis.pipeline;
  };
  const shapes: [string, () => void][] = [
    ["a reply with nothing in it", () => answering(() => undefined)],
    ["a number where the team's text was", () => answering(() => 7)],
    ["text that is not JSON", () => answering(() => "{not json")],
    ["JSON that is not an object", () => answering(() => "[]")],
    ["members that are not a list", () => answering(() => JSON.stringify({ members: "x", invites: [] }))],
    ["invites that are not a list", () => answering(() => JSON.stringify({ members: [], invites: {} }))],
    ["a two-step rule that is not true or false", () => answering(() => JSON.stringify({ members: [], invites: [], requireTwoStep: "yes" }))],
  ];

  for (const [label, shape] of shapes) {
    part(label);
    shape();
    is(`${label}: the team is not read as empty`, await readTeam(store.sid).then(() => "read", () => "unknown"), "unknown");
    // Main's reading (0dd864a79): an unknown team is taken as requiring the second step, so it is asked for, never skipped.
    is(`${label}: a teammate is not let past the two-step rule: the step is asked for`, await teamTwoStepBlocks(store, AMY, "admin").then((blocks) => (blocks ? "asked" : "let in"), () => "refused"), "asked");
    const invited = await inviteMember(store, `new-${shapes.findIndex(([l]) => l === label)}@example.com`, "support", "https://marktmorgen.com").then(
      (answer) => JSON.stringify(answer),
      () => "refused",
    );
    is(`${label}: an invitation is refused`, invited, "refused");
    is(`${label}: a removal is refused`, await removeMember(store, BEN).then((done) => (done ? "removed" : "not"), () => "refused"), "refused");
    redis.pipeline = pipe;
    is(`${label}: the team is kept whole, with its rule`, await redis.pipeline([["GET", key]]).then(([raw]) => String(raw)), kept);
  }

  part("No team record at all");
  is("a store with no team reads as an empty team", await readTeam(NO_TEAM_SID), { members: [], invites: [] });
  is("and its teammates are not held by a rule it does not have", await teamTwoStepBlocks({ ...store, sid: NO_TEAM_SID }, AMY, "admin"), false);
  done();
}

void main();
