/**
 * Rule 24 on two community counts: an unknown reply is never shown as 0.
 *
 * directorySize (the members page's "N members have chosen to be listed") and postCount (the studio's posts card)
 * read one ZCARD each and turned any reply that was not a number, or a failed read, into 0: a community whose
 * count could not be read said it had no listed members and no posts (Claude 5 on #3213, outside its diff).
 * Each now answers null when the count is not known, and each page says nothing it cannot back.
 *
 * memberPage did the same with its whole page: an HSCAN reply in another shape became "no members, the walk is
 * over", so the creator's announcement emails (mailableMembers) went to the members read so far and no one after,
 * and its HLEN total became 0. An odd page is now thrown (UnknownReplyError), never taken as the end, and an odd
 * total is null.
 *
 * Synthetic data and the in-memory store only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { directorySize, mailableMembers, memberPage, postCount } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const CM = "c1dec0de0000000000000000000c0de5";
const real = redis.pipeline;
function answer(command: string, reply: unknown | "throw"): void {
  redis.pipeline = async (commands) => {
    if (reply === "throw" && commands.some((c) => c[0] === command)) throw new Error("Redis request failed with status 503");
    const out = await real(commands);
    return out.map((one, at) => (commands[at][0] === command ? reply : one));
  };
}
const healthy = () => {
  redis.pipeline = real;
};

async function main(): Promise<void> {
  part("A count that is read is the count");
  await real([["ZADD", `nl:cm:${CM}:dir`, 1, "mem1", 2, "mem2"], ["ZADD", `nl:cm:${CM}:feed`, 1, "post1"]]);
  is("two listed members", await directorySize(CM), 2);
  is("one post", await postCount(CM), 1);
  await real([["DEL", `nl:cm:${CM}:dir`, `nl:cm:${CM}:feed`]]);
  is("an empty community is a real 0 listed", await directorySize(CM), 0);
  is("and a real 0 posts", await postCount(CM), 0);

  part("A count that cannot be read is unknown, never 0");
  for (const odd of ["2", null, -1, 1.5, { n: 2 }, "throw"] as const) {
    answer("ZCARD", odd);
    is(`listed members with a ZCARD reply ${JSON.stringify(odd)}`, await directorySize(CM), null);
    is(`posts with a ZCARD reply ${JSON.stringify(odd)}`, await postCount(CM), null);
    healthy();
  }

  part("The pages say nothing they cannot back");
  const members = readFileSync(join(process.cwd(), "app/[handle]/community/members/page.tsx"), "utf8");
  is("the members page shows the listed total only when it is known", /total === null \? w\.listedPrivacy : w\.listedTotal\(total\)/.test(members), true);
  const studio = readFileSync(join(process.cwd(), "components/community-studio.tsx"), "utf8");
  is("the studio's posts card says the posts were not counted, never 0", /totals\.posts === null \? "Not counted" : totals\.posts/.test(studio), true);

  part("A members page that cannot be read is never the end of the list");
  const member = (k: string, mail: boolean) => JSON.stringify({ k, e: `${k}@example.com`, n: "", dir: false, mail, at: 1, seen: 1 });
  const membersHash = `nl:cm:${CM}:m`;
  const fields: (string | number)[] = [];
  for (let i = 0; i < 30; i += 1) fields.push(`m${i}`, member(`m${i}`, true));
  await real([["HSET", membersHash, ...fields]]);
  const read = await memberPage(CM, "0", 1000);
  is("a page read whole: every member, and the total", [read.members.length, read.total], [30, 30]);
  is("everyone who asked for announcements", (await mailableMembers(CM)).length, 30);
  for (const odd of [null, ["0"], ["x", []], [0, []], ["0", "a"], ["0", ["m1"]]] as const) {
    answer("HSCAN", odd);
    is(`a page reply ${JSON.stringify(odd)}: thrown, never "no members"`, await memberPage(CM, "0", 1000).then(() => "read", () => "thrown"), "thrown");
    is(`and the announcement list is never cut short by it`, await mailableMembers(CM).then((list) => list.length, () => "thrown"), "thrown");
    healthy();
  }
  for (const odd of ["30", null, -1, 2.5] as const) {
    answer("HLEN", odd);
    is(`a total reply ${JSON.stringify(odd)}: unknown, never 0`, (await memberPage(CM, "0", 1000)).total, null);
    healthy();
  }
  await real([["DEL", membersHash]]);
  is("the studio's members card says the members were not counted, never 0", /totals\.members === null \? "Not counted" : totals\.members/.test(studio), true);

}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
