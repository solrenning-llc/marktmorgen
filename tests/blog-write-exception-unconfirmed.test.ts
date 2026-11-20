import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/blog/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { BlogWriteUnconfirmed, allPosts, deletePost, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

// Review 6701786155 (MEDIUM 1): a write pipeline that ran on the server and then failed to answer
// (a timeout or a 5xx after Upstash executed it) is an unconfirmed write, never a "server_error, try again".
const original = redis.pipeline.bind(redis);
let throwAfterMutation = false;
(redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => {
  const isMutation = commands.some((c) => c[0] === "HSET" || c[0] === "HDEL");
  const reply = await original(commands);
  if (throwAfterMutation && isMutation) throw new Error("synthetic timeout after the write ran");
  return reply;
};

async function main() {
  redis.clear();
  const email = "blog-unconfirmed@example.com";
  await claimHandle(email, "blogunconfirmed", "Synthetic blog", "");
  await ensureStatsId(email);
  const store = (await storeForEmail(email))!;

  part("lib: a mutation that throws after running is unconfirmed");
  throwAfterMutation = true;
  const saved = await savePost(store.statsId, null, { title: "Once", body: "Synthetic words.", product: null, draft: false }, () => "aaaaa11111", ROOM).catch((e) => e);
  is("savePost reports unconfirmed instead of throwing", (saved as { ok?: boolean; reason?: string }).reason, "unconfirmed");
  const removed = await deletePost(store.statsId, "aaaaa11111", ROOM).catch((e) => e);
  is("deletePost throws BlogWriteUnconfirmed", removed instanceof BlogWriteUnconfirmed, true);
  throwAfterMutation = false;

  part("route: the editor is told to check, and a retry does not duplicate the post");
  redis.clear();
  await claimHandle(email, "blogunconfirmed", "Synthetic blog", "");
  await ensureStatsId(email);
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const sid = (await storeForEmail(email))!.sid;
  const post = (body: unknown) => POST(new NextRequest("https://marktmorgen.com/api/store/blog", {
    method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": sid, cookie }, body: JSON.stringify(body),
  }));
  throwAfterMutation = true;
  const first = await post({ action: "save", title: "Only once", body: "Synthetic words.", draft: false });
  throwAfterMutation = false;
  is("route answers 503", first.status, 503);
  is("route says unconfirmed, not server_error", (await first.json()).error, "unconfirmed");
  const fresh = (await storeForEmail(email))!;
  is("the write that ran is kept (one post)", (await allPosts(fresh.statsId)).filter((p) => p.title === "Only once").length, 1);
  done();
}
main();
