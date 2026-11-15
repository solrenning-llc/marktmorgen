/**
 * Rule 24 (rule 30 of the community index fix) on a community erasure's read
 * of the community's settings (lib/community-erasure.ts).
 *
 * The erasure reads the settings only to learn which spaces the community
 * has, because each space keeps its own record of whether a person may come
 * in (nl:cm:<id>:sp:ok:<space>:<person>). The read used to be swallowed: a
 * failed or odd reply became "no settings", so "no spaces", so none of those
 * records was deleted, and the erasure still said the person was gone.
 *
 * A setup stored damaged (a value that is not settings at all) is not a lost
 * reply, and pressing again never mends it (review of #3091 by Claude 2,
 * MEDIUM: the erasure stayed "incomplete" for good). While the setup cannot
 * be read, the community is off for everyone (communityViewer), so no space's
 * answer is read or written; those written before expire on their own within
 * five minutes (lib/community-access.ts, OPEN_SECONDS). So the erasure deletes
 * everything else and finishes.
 *
 * Synthetic data and the in-memory store only.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { communityViewer } from "@/lib/community-access";
import type { Store } from "@/lib/store";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const CM = "c0ffee00c0ffee00c0ffee00c0ffee00";
const SPACE = "5bace0000001";
const EMAIL = "erase-me@example.test";
const cfgKey = `nl:cm:${CM}:cfg`;
const spaceOk = `nl:cm:${CM}:sp:ok:${SPACE}:${emailKey(EMAIL)}`;
const config = JSON.stringify({ name: "Field notes", spaces: [{ id: SPACE, name: "Inner circle", only: ["prod1"] }] });

const real = redis.pipeline;
function answer(match: (command: (string | number)[]) => boolean, reply: unknown | "throw"): void {
  redis.pipeline = async (commands) => {
    if (reply === "throw" && commands.some(match)) throw new Error("Redis request failed with status 503");
    const out = await real(commands);
    return out.map((one, at) => (match(commands[at]) ? reply : one));
  };
}
const healthy = () => {
  redis.pipeline = real;
};
const isCfg = (c: (string | number)[]) => c[0] === "GET" && c[1] === cfgKey;
const okKey = `nl:cm:${CM}:ok:${emailKey(EMAIL)}`;
const productOk = `nl:cm:${CM}:sg:prod1:${emailKey(EMAIL)}`;
const exists = async (key: string) => Number((await real([["EXISTS", key]]))[0]) === 1;

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function setup(withConfig = true): Promise<void> {
  healthy();
  redis.clear();
  await real([...(withConfig ? [["SET", cfgKey, config]] : []), ["SET", spaceOk, "1"]]);
}

async function main(): Promise<void> {
  part("Control: an erasure deletes the person's record in each space");
  await setup();
  await forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"]);
  is("the space's record of them is gone", await exists(spaceOk), false);

  part("Control: a community with no settings at all (an absent key) erases without refusing");
  await setup(false);
  is("resolves", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), false);

  for (const [what, reply] of [
    ["a failed read", "throw"],
    ["a number", 7],
    ["a list", [config]],
    ["an object", { spaces: [] }],
  ] as [string, unknown][]) {
    part(`The settings answered as ${what}`);
    await setup();
    answer(isCfg, reply);
    is("the erasure says it is not done", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), true);
    healthy();
    is("the space's record is still there to be deleted", await exists(spaceOk), true);
    await forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"]);
    is("and the erasure run again deletes it", await exists(spaceOk), false);
  }

  for (const [what, stored] of [
    ["text that is not settings", "{bad"],
    ["an empty value", ""],
  ] as [string, string][]) {
    part(`The setup is stored damaged: ${what}`);
    healthy();
    redis.clear();
    await real([["SET", cfgKey, stored], ["SET", okKey, "1"], ["SET", productOk, "1"], ["HSET", `nl:cm:${CM}:wel`, emailKey(EMAIL), "1"]]);
    const viewer = await communityViewer({ community: { id: CM, on: true } } as unknown as Store, { get: () => undefined });
    is("the community is off for everyone, so no space's answer is read or written", viewer.state, "off");
    is("the erasure finishes instead of staying incomplete for good", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), false);
    is("the community's own answer about them is gone", await exists(okKey), false);
    is("the answer for the product they bought is gone", await exists(productOk), false);
    is("the welcome kept for them is gone", Number((await real([["HEXISTS", `nl:cm:${CM}:wel`, emailKey(EMAIL)]]))[0]), 0);
    is("the damaged setup is left as it is, for the creator", (await real([["GET", cfgKey]]))[0], stored);
    is("pressing again finishes too", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), false);
  }

  // Redis answering the setup as text that is not settings is what a setup
  // stored damaged answers, and every reader gets the same answer: before the
  // review of #3091 this case refused for good, like the stored ones above.
  part("The settings answered as text that is not settings: damage, the same for every reader");
  await setup();
  await real([["SET", okKey, "1"]]);
  answer(isCfg, "{not json");
  const reader = await communityViewer({ community: { id: CM, on: true } } as unknown as Store, { get: () => undefined });
  is("the community is off for everyone who reads it so", reader.state, "off");
  is("the erasure finishes", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), false);
  healthy();
  is("and deletes what does not hang on the spaces", await exists(okKey), false);

  part("A lost reply is still not damage: it refuses, and nothing is deleted");
  await setup();
  await real([["SET", okKey, "1"]]);
  answer(isCfg, "throw");
  is("refused", await rejects(() => forgetCommunityPerson(CM, "mem1", EMAIL, ["prod1"])), true);
  healthy();
  is("the community's answer about them is still there to be deleted", await exists(okKey), true);
  done();
}

void main();
