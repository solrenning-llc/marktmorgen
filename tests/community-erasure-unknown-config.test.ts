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
 * Synthetic data and the in-memory store only.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
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
    ["text that is not settings", "{not json"],
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
  done();
}

void main();
