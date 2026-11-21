/**
 * Who a mention, a reply or an answer reaches (app/api/store/community/route.ts).
 *
 *  1. A member the creator removed (manage route, `removed: true`) keeps their
 *     handle and their push devices (removal only patches the record, so a
 *     member let back in finds them again). A later @mention of them must file
 *     no notice and read no device to push them: they can no longer come in.
 *  2. A post in a space kept for the buyers of a product notifies a member
 *     named in it who cannot see that space, and the notice carries the
 *     post's first words, which the notifications page shows. The post page,
 *     the feed and search all refuse that member the space.
 *
 * Real routes over the in-memory Redis; synthetic records only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { POST as managePost } from "@/app/api/store/community/manage/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, memberKey, newItemId, readConfig, saveConfig, type Member } from "@/lib/community";
import { maySeeSpace } from "@/lib/community-access";
import { noticesFor } from "@/lib/community-notify";
import { deviceCount, rememberDevice } from "@/lib/community-push";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  seen.push(...commands);
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await pipeline([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await pipeline([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const device = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/hunt-${randomBytes(4).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@huntnotify.example";
  const made = await claimHandle(OWNER, "huntnotifyclub", "Hunt Notify Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HuntNotify1", subscriptionId: "sub_HuntNotify1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  const gated = { id: newItemId(), name: "Course students", about: "", creatorOnly: false, only: ["prodcourse1"], level: 0 };
  const base = freshConfig(club.name);
  await saveConfig(cid, { ...base, access: ["prodcourse1"], spaces: [...base.spaces, gated] });
  const config = (await readConfig(cid))!;
  const gatedSpace = config.spaces.find((s) => s.name === "Course students");
  if (!gatedSpace?.only.length) throw new Error(`the gated space was not kept: ${JSON.stringify(config.spaces)}`);
  const general = config.spaces[0].id;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  async function member(name: string, handle: string): Promise<string> {
    const email = `${handle}@huntnotify.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: name, h: handle, dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await redis.pipeline([["HSET", `nl:cm:${cid}:m`, key, JSON.stringify(record)], ["HSET", `nl:cm:${cid}:h`, handle, key]]);
    return key;
  }
  async function creatorPost(space: string, text: string): Promise<string> {
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "post");
    form.set("space", space);
    form.set("text", text);
    const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? "";
  }

  part("A removed member is still told, and their phone still reached");
  {
    const key = await member("Rita Removed", "rita-removed");
    is("her phone was remembered", await rememberDevice(cid, key, device(), club), "added");
    is("one device listening", await deviceCount(cid, key), 1);
    const removal = await managePost(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": club.sid, cookie }, body: JSON.stringify({ action: "member", key, removed: true }) }));
    is("the studio removed her", removal.status, 200);
    seen.length = 0;
    const where = await creatorPost(general, "Welcome everyone, @rita-removed included");
    is("the post was written", where.includes("n=posted"), true);
    is("no notice is filed for a removed member", (await noticesFor(cid, key)).notices.length, 0);
    const pushedHer = seen.some((c) => c[0] === "HGETALL" && c[1] === `nl:cm:${cid}:ps:${key}`);
    is("her phone is not looked up to be pushed", pushedHer, false);
  }

  part("A mention in a space the named member cannot see");
  {
    const key = await member("Gina Outside", "gina-outside");
    is("she cannot see the course students' space", await maySeeSpace(club, config, gatedSpace, { owner: false, email: "gina-outside@huntnotify.example" }), false);
    const where = await creatorPost(gatedSpace.id, "Students only: the bonus module answer key is X. cc @gina-outside");
    is("the post was written in the gated space", where.includes("n=posted"), true);
    const { notices } = await noticesFor(cid, key);
    is("she is not told about a post in a space she cannot see", notices.length, 0);
    is("and its words never reach her list", notices.some((n) => n.words.includes("answer key")), false);
    const post = where.match(/\/post\/([0-9a-z]+)/)?.[1] ?? "";
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "comment");
    form.set("post", post);
    form.set("text", "Also for the students: the second key is Y. @gina-outside");
    const commented = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    is("a comment on it was written", (commented.headers.get("location") ?? "").includes("n=commented"), true);
    is("a mention in a comment there does not reach her either", (await noticesFor(cid, key)).notices.length, 0);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
