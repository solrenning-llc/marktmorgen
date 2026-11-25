/**
 * Claude 6 NQoup on #5072 (LEVE, cost): holding a send's place in its community's sends (lib/community-mail.ts
 * holdSendPlace) reads every member of the sends and asks EXISTS of each, then lets the stale ones go with a DEL each;
 * with the erasure's count read before and after the members, that is up to 68 commands at the cap of live sends and
 * as many stale places, and more with more stale places, none of it priced: an owner's post is one studio request,
 * priced at STUDIO_REQUEST_COMMANDS.
 *
 * Now a hold walks at most ERASE_SENDS_READ_MOST - 1 other places a post (the rest are walked by the next posts and
 * erasures), so a post's queueAnnouncement sends at most ANNOUNCE_PLACE_COMMANDS_MOST commands besides its recipient
 * list's writes (which grow with the members, as before), and an emailed announcement takes ANNOUNCE_PLACE_STUDIO_UNITS
 * studio requests more than the one every post takes, enough for that bound.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { ANNOUNCE_PLACE_COMMANDS_MOST, ANNOUNCE_PLACE_STUDIO_UNITS, queueAnnouncement } from "@/lib/community-mail";
import { ANNOUNCE_STUDIO_REQUEST_COMMANDS } from "@/lib/community-text";
import { MAX_SENDS_UNDER_WAY } from "@/lib/community-text";
import { STUDIO_REQUEST_COMMANDS } from "@/lib/student-bulk-rules";
import type { Post } from "@/lib/community";
import { commandsSeen, config, db, reset, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const community = store.community!.id;
const sends = `nl:cm:${community}:sends`;
const post = { id: "f".repeat(12), title: "Synthetic announcement", text: "Synthetic body", sp: "" } as unknown as Post;
const ids = (n: number, fill: string) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(24, fill));

/** Seeds `live` sends with a record and `stale` places with neither a record nor a held mark, each with a list. */
function seed(live: number, stale: number): void {
  reset();
  const on = ids(live, "a");
  const gone = ids(stale, "d");
  for (const send of on) db.run(["SET", `nl:cm:mail:${send}`, "{}"]);
  for (const send of [...on, ...gone]) db.run(["RPUSH", `nl:cm:mail:${send}:to`, "k"]);
  if (on.length + gone.length) db.run(["SADD", sends, ...on, ...gone]);
}

/**
 * The commands a run sends, but for the new send's own recipient list (its DEL, RPUSHes and EXPIRE), which grow with
 * the members as they did before this PR; the new send is the one whose held mark is written first.
 */
async function sentBy(run: () => Promise<unknown>): Promise<number> {
  commandsSeen.length = 0;
  await run();
  const held = String(commandsSeen.find((c) => c[0] === "SET" && String(c[1]).endsWith(":held"))?.[1] ?? "");
  const list = held.replace(/:held$/, ":to");
  return commandsSeen.filter((c) => !(list && String(c[1]) === list && ["DEL", "RPUSH", "EXPIRE"].includes(String(c[0])))).length;
}

async function main(): Promise<void> {
  part("the studio requests an emailed announcement takes cover what its place costs at the most");
  is("the bound is a number", Number.isFinite(ANNOUNCE_PLACE_COMMANDS_MOST) && ANNOUNCE_PLACE_COMMANDS_MOST > 0, true);
  is("its units cover it", ANNOUNCE_PLACE_STUDIO_UNITS * STUDIO_REQUEST_COMMANDS >= ANNOUNCE_PLACE_COMMANDS_MOST, true);
  is("the page's copy of a studio request's commands is the priced one", ANNOUNCE_STUDIO_REQUEST_COMMANDS, STUDIO_REQUEST_COMMANDS);

  part(`busy: ${MAX_SENDS_UNDER_WAY} live sends and three times as many stale places`);
  seed(MAX_SENDS_UNDER_WAY, 3 * MAX_SENDS_UNDER_WAY);
  const busy = await sentBy(() => queueAnnouncement(store, config, post));
  is(`RED: sent ${busy}, within the bound`, busy <= ANNOUNCE_PLACE_COMMANDS_MOST, true);

  part("queued: only stale places past the cap, as many as one hold looks up");
  seed(0, 2 * MAX_SENDS_UNDER_WAY - 1);
  let queued: Awaited<ReturnType<typeof queueAnnouncement>> | undefined;
  const room = await sentBy(async () => { queued = await queueAnnouncement(store, config, post); });
  is(`sent ${room}, within the bound`, room <= ANNOUNCE_PLACE_COMMANDS_MOST, true);
  is("every stale place let go, and the post's send queued", [queued?.ok, db.run(["SCARD", sends])], [true, 1]);

  part("more stale places than one hold looks up: the next post looks up the rest");
  seed(0, 3 * MAX_SENDS_UNDER_WAY);
  let first: Awaited<ReturnType<typeof queueAnnouncement>> | undefined;
  const many = await sentBy(async () => { first = await queueAnnouncement(store, config, post); });
  is(`sent ${many}, within the bound`, many <= ANNOUNCE_PLACE_COMMANDS_MOST, true);
  is("this post refused as busy, the places it looked up let go", [first?.ok ? "queued" : first?.reason, db.run(["SCARD", sends])], ["busy", 3 * MAX_SENDS_UNDER_WAY - (2 * MAX_SENDS_UNDER_WAY - 1)]);
  let second: Awaited<ReturnType<typeof queueAnnouncement>> | undefined;
  const next = await sentBy(async () => { second = await queueAnnouncement(store, config, post); });
  is(`the next post sent ${next}, within the bound, and is queued`, [next <= ANNOUNCE_PLACE_COMMANDS_MOST, second?.ok, db.run(["SCARD", sends])], [true, true, 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
