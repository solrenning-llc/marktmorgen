/**
 * Rule 24 on two community counts: an unknown reply is never shown as 0.
 *
 * directorySize (the members page's "N members have chosen to be listed") and postCount (the studio's posts card)
 * read one ZCARD each and turned any reply that was not a number, or a failed read, into 0: a community whose
 * count could not be read said it had no listed members and no posts (Claude 5 on #3213, outside its diff).
 * Each now answers null when the count is not known, and each page says nothing it cannot back.
 *
 * Synthetic data and the in-memory store only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { directorySize, postCount } from "@/lib/community";
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

}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
