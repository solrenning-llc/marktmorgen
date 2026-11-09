/**
 * Deleting a person from a store's community when its settings cannot be
 * read (lib/community-erasure.ts, through lib/person-erasure.ts).
 *
 * Whether a member may see each space is kept by space and by address
 * (nl:cm:<id>:sp:ok:<space>:<address key>, lib/community-access.ts
 * maySeeSpace), and the only way to those keys is the list of spaces in the
 * community's settings. Settings that are missing mean there are no spaces;
 * settings that are there but cannot be read (not JSON, a reply of the wrong
 * shape, a database that does not answer) mean the spaces are unknown, and
 * so is whether an answer kept for the person is still there. Then the
 * erasure deletes everything else it can and says the community step is not
 * finished, never "done" with the person's answer maybe kept.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld, seedPerson, type World } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { readConfig } from "@/lib/community";
import { emailKey } from "@/lib/learn";
import { storeForEmail } from "@/lib/store";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname.endsWith("stripe.com")) return json({ object: "list", data: [], has_more: false });
  return realFetch(input as string, init);
}) as typeof fetch;

type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;
/** How the settings' own read is answered, when it is not answered by the store. */
let settingsRead: ((batch: (string | number)[][]) => Promise<unknown[]>) | null = null;
let cfgKey = "";
redis.pipeline = (async (batch: (string | number)[][]) =>
  settingsRead && batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === cfgKey ? settingsRead(batch) : real(batch)) as Pipeline;

const spaceKey = (w: World, space: string, email: string) => `nl:cm:${w.communityId}:sp:ok:${space}:${emailKey(email)}`;
const memberKept = async (w: World, email: string) => (await real([["HEXISTS", `nl:cm:${w.communityId}:m`, emailKey(email)]]))[0];
const exists = async (key: string) => (await real([["EXISTS", key]]))[0];

/** A person in the store, with the answer kept that they may see the community's one space. */
async function person(w: World, email: string, space: string): Promise<string> {
  await seedPerson(w, email, null);
  const key = spaceKey(w, space, email);
  await real([["SET", key, JSON.stringify({ v: "1", ok: true }), "EX", 300]]);
  return key;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_erasure_config_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_community_erasure_config_only_a_stand_in";
  const w = await makeWorld();
  cfgKey = `nl:cm:${w.communityId}:cfg`;
  const config = await readConfig(w.communityId);
  if (!config || config.spaces.length !== 1) throw new Error("the world's community has one space");
  const space = config.spaces[0].id;
  const storedSettings = (await real([["GET", cfgKey]]))[0] as string;
  const store = async () => (await storeForEmail(OWNER))!;

  part("Settings read: the answer kept for the person's space goes with them");
  {
    const key = await person(w, "ana.space@example.com", space);
    const erased = await erasePerson(await store(), "ana.space@example.com", { kind: "person" });
    is("the erasure finished", erased.ok, true);
    is("their answer for the space is gone", await exists(key), 0);
  }

  part("No settings at all: there are no spaces, and the erasure finishes");
  {
    await real([["DEL", cfgKey]]);
    await seedPerson(w, "bo.nospace@example.com", null);
    const erased = await erasePerson(await store(), "bo.nospace@example.com", { kind: "person" });
    is("the erasure finished", erased.ok, true);
    await real([["SET", cfgKey, storedSettings]]);
  }

  const unreadable: [string, () => Promise<void>, (() => Promise<unknown[]>) | null][] = [
    ["settings that are not JSON", async () => void (await real([["SET", cfgKey, "{not json"]])), null],
    ["settings that are JSON but not an object", async () => void (await real([["SET", cfgKey, "7"]])), null],
    ["a read answered in the wrong shape", async () => {}, async () => [{ result: storedSettings }]],
    ["a read answered with nothing", async () => {}, async () => []],
    ["a database that does not answer", async () => {}, async () => {
      throw new Error("the database did not answer");
    }],
  ];
  let n = 0;
  for (const [what, spoil, read] of unreadable) {
    part(`Settings that cannot be read (${what}): the erasure never says done`);
    n += 1;
    const email = `cy${n}.unread@example.com`;
    const key = await person(w, email, space);
    await spoil();
    settingsRead = read;
    let erased: Awaited<ReturnType<typeof erasePerson>>;
    try {
      erased = await erasePerson(await store(), email, { kind: "person" });
    } finally {
      settingsRead = null;
      await real([["SET", cfgKey, storedSettings]]);
    }
    is("the erasure is not reported done", erased.ok, false);
    is("it says the community step is not finished", !erased.ok && erased.reason === "incomplete" && (erased.failed ?? []).includes("lib/community-erasure.ts"), true);
    is("their answer for the space was not found, and is still there", await exists(key), 1);
    is("everything else of theirs in the community still went (their record)", await memberKept(w, email), 0);
    // With the settings readable again, the next try reaches the space.
    await forgetCommunityPerson(w.communityId, emailKey(email), email, w.store.catalog.items.map((i) => i.id));
    is("the next try, with the settings readable, deletes their answer for the space", await exists(key), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
