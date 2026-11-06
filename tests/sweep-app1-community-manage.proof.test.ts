/**
 * Sweep app1 proof (CX-123 rules 24 and 30), synthetic only, through app/api/store/community/manage/route.ts.
 *
 * Part 1. Switching the community on or off, route lines 46-51:
 *   let config = await readConfig(store.community.id);
 *   if (!config) { config = freshConfig(store.name); await saveConfig(store.community.id, config); }
 * readConfig (lib/community.ts:319-323) answers null for a GET lost or in another shape, so the creator's whole
 * setup is overwritten with a fresh one: every space but a new "General", the products that let members in
 * (access [] lets nobody in, lib/community-access.ts:275, so every paying member is locked out), the questions, the
 * welcome, chat and messages settings, the pinned posts.
 *
 * Part 2. Hiding or deleting a reported post, route lines 172-176:
 *   const post = await readPost(id, target.post);
 *   if (!post) { await dismissReport(id, reportKey); return Response.json({ ok: true }); }
 * readPost (lib/community.ts:651-655) answers null for a GET lost or in another shape, so the report is dismissed and
 * the moderator told "done" while the post stays up, unhidden. lib/community.ts:1063 already has the exact reader for
 * this (readReportedTarget, "without treating a missing reply as a deleted target"); the route does not use it.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/manage/route";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { createPost, readConfig, readPost, report, reportQueue } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
let lose: "none" | "cfg" | "post" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (lose === "cfg" && one?.[0] === "GET" && String(one[1]).endsWith(":cfg")) return [];
  if (lose === "post" && one?.[0] === "GET" && /:p:[^:]+$/.test(String(one[1]))) return ["QUEUED"];
  return real(commands);
}) as typeof redis.pipeline;

type Config = { spaces: { id: string; name: string }[]; access: string[]; questions: string[]; welcome: string };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "cmanage@example.com";
  await claimHandle(OWNER, "cmanageshop", "Club Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const made = await addProduct(OWNER, "Membership", "", "20");
  const product = made.ok ? made.product.id : "";
  const store0 = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store0.sid, cookie }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok: boolean; error?: string; config?: Config };
  };
  await call({ action: "enable", on: true });
  await call({ action: "space-add", name: "Wins", about: "", creatorOnly: false, only: [], level: 0 });
  await call({ action: "access", products: [product] });
  await call({ action: "onboarding", questions: ["What do you bake?"], welcome: "Welcome in." });
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const shape = (c: Config | null) => c && [c.spaces.map((s) => s.name), c.access, c.questions, c.welcome];
  const built = shape(await readConfig(id));

  part("1. Healthy control: switching it off and on keeps the setup");
  await call({ action: "enable", on: false });
  await call({ action: "enable", on: true });
  is("spaces, access, questions and welcome kept", shape(await readConfig(id)), built);

  part("1. DEFECT: the setup's read is lost while switching");
  lose = "cfg";
  const switched = await call({ action: "enable", on: true });
  lose = "none";
  is("DEFECT: answered ok", switched.ok, true);
  is("DEFECT: the setup is overwritten with a fresh one: only General, no product lets members in, no questions", shape(await readConfig(id)), [["General"], [], [], ""]);

  part("2. Healthy control: hiding a reported post hides it");
  const room = { ...store, statsId: store.statsId } as Parameters<typeof createPost>[2];
  const spaceId = (await readConfig(id))!.spaces[0].id;
  const first = await createPost(id, { space: spaceId, author: "a".repeat(32), title: "Spam", text: "buy now", img: null, kind: "post", poll: null }, room);
  const second = await createPost(id, { space: spaceId, author: "a".repeat(32), title: "Abuse", text: "abuse", img: null, kind: "post", poll: null }, room);
  if (!first.ok || !second.ok) throw new Error("no posts");
  await report(id, { kind: "post", post: first.post.id }, "b".repeat(32), room);
  await report(id, { kind: "post", post: second.post.id }, "b".repeat(32), room);
  is("(two reports waiting)", (await reportQueue(id)).length, 2);
  is("hidden", [(await call({ action: "report-hide", key: `p:${first.post.id}` })).ok, (await readPost(id, first.post.id))?.hid ?? null], [true, true]);

  part("2. DEFECT: the reported post's read answers in another shape");
  lose = "post";
  const hid = await call({ action: "report-hide", key: `p:${second.post.id}` });
  lose = "none";
  is("DEFECT: the moderator is told it is done", hid.ok, true);
  is("DEFECT: the post is still up, not hidden", (await readPost(id, second.post.id))?.hid ?? null, false);
  is("DEFECT: and its report is gone from the queue", (await reportQueue(id)).length, 0);
  done();
}
main();
