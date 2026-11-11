/**
 * app/api/store/community/manage/route.ts on Redis replies that are lost or in another shape (sweep app1, findings
 * 4 and 5; lib/redis-reply.ts). Synthetic only.
 *
 * 1. Switching the community on or off reads the setup first. Only an exact absence (a GET answered nil) means there
 *    is none yet and a fresh one is written; a lost reply, one in another shape or one that does not parse refuses
 *    with 503 and writes nothing: neither the switch nor a fresh setup over the creator's spaces, the products that
 *    let members in, the questions and the welcome.
 * 2. Hiding or deleting a reported post or comment reads it with readReportedTarget. Only an exact absence clears the
 *    report as already gone; an unknown read refuses with 503, keeps the report in the queue and leaves the post as it
 *    was, so the moderator is never told it is done while it is still up.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/manage/route";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addComment, createPost, readComment, readConfig, readPost, report, reportQueue } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Lose = "none" | "cfg-empty" | "cfg-queued" | "cfg-text" | "post-empty" | "post-queued" | "comment-empty";
const real = redis.pipeline.bind(redis);
let lose: Lose = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const key = String(one?.[1] ?? "");
  if (one?.[0] === "GET" && key.endsWith(":cfg")) {
    if (lose === "cfg-empty") return [];
    if (lose === "cfg-queued") return ["QUEUED"];
    if (lose === "cfg-text") return ["{not json"];
  }
  if (one?.[0] === "GET" && /:p:[^:]+$/.test(key)) {
    if (lose === "post-empty") return [];
    if (lose === "post-queued") return ["QUEUED"];
  }
  if (one?.[0] === "HGET" && lose === "comment-empty") return [];
  return real(commands);
}) as typeof redis.pipeline;

type Config = { spaces: { id: string; name: string }[]; access: string[]; questions: string[]; welcome: string };
type Answer = { status: number; ok: boolean; error?: string; config?: Config };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "cmunknown@example.com";
  await claimHandle(OWNER, "cmunknownshop", "Club Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const made = await addProduct(OWNER, "Membership", "", "20");
  const product = made.ok ? made.product.id : "";
  const store0 = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store0.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json()) as Omit<Answer, "status">) };
  };
  const shape = (c: Config | null) => c && [c.spaces.map((s) => s.name), c.access, c.questions, c.welcome];
  const isOn = async () => (await storeForEmail(OWNER))?.community?.on ?? null;

  part("1. Control: the first switch-on finds no setup (an exact nil) and writes a fresh one");
  const first = await call({ action: "enable", on: true });
  is("ok, General", [first.status, first.ok, first.config?.spaces.map((s) => s.name)], [200, true, ["General"]]);
  await call({ action: "space-add", name: "Wins", about: "", creatorOnly: false, only: [], level: 0 });
  await call({ action: "access", products: [product] });
  await call({ action: "onboarding", questions: ["What do you bake?"], welcome: "Welcome in." });
  const id = (await storeForEmail(OWNER))!.community!.id;
  const built = shape(await readConfig(id));
  is("(the creator's setup)", built, [["General", "Wins"], [product], ["What do you bake?"], "Welcome in."]);

  part("1. Control: switching off and on keeps the setup");
  await call({ action: "enable", on: false });
  const back = await call({ action: "enable", on: true });
  is("kept, answered with it", [back.ok, shape(back.config ?? null), shape(await readConfig(id))], [true, built, built]);

  for (const mode of ["cfg-empty", "cfg-queued", "cfg-text"] as const) {
    part(`1. The setup's read is unknown (${mode}) while switching off`);
    lose = mode;
    const switched = await call({ action: "enable", on: false });
    lose = "none";
    is("refused as unavailable, nothing said done", [switched.status, switched.ok, switched.error], [503, false, "setup_read_unavailable"]);
    is("the setup is not overwritten: spaces, access, questions, welcome kept", shape(await readConfig(id)), built);
    is("and the switch is not changed either", await isOn(), true);
  }

  part("1. Exact absence still means new: a setup that is really gone is written fresh");
  await redis.pipeline([["DEL", `${"nl:cm:" + id}:cfg`]]);
  is("(gone)", await readConfig(id), null);
  const fresh = await call({ action: "enable", on: true });
  is("ok, a fresh General", [fresh.status, fresh.ok, shape(await readConfig(id))], [200, true, [["General"], [], [], ""]]);

  part("2. Setup for the reports");
  const store = (await storeForEmail(OWNER))!;
  const room = { ...store, statsId: store.statsId } as Parameters<typeof createPost>[2];
  const spaceId = (await readConfig(id))!.spaces[0].id;
  const post = async (title: string) => {
    const made = await createPost(id, { space: spaceId, author: "a".repeat(32), title, text: title, img: null, kind: "post", poll: null }, room);
    if (!made.ok) throw new Error("no post");
    return made.post.id;
  };
  const hideMe = await post("Spam");
  const deleteMe = await post("Abuse");
  const gone = await post("Gone");
  const holder = await post("Holder");
  const said = await addComment(id, holder, { parent: "", author: "c".repeat(32), text: "rude" }, room);
  if (!said.ok) throw new Error("no comment");
  const commentId = said.comment.id;
  for (const p of [hideMe, deleteMe, gone]) await report(id, { kind: "post", post: p }, "b".repeat(32), room);
  await report(id, { kind: "comment", post: holder, comment: commentId }, "b".repeat(32), room);
  const queued = async () => (await reportQueue(id)).map((r) => r.key).sort();
  is("(four reports waiting)", (await queued()).length, 4);

  for (const mode of ["post-empty", "post-queued"] as const) {
    part(`2. Hiding a reported post whose read is unknown (${mode})`);
    lose = mode;
    const hid = await call({ action: "report-hide", key: `p:${hideMe}` });
    lose = "none";
    is("refused as unavailable, not said done", [hid.status, hid.ok, hid.error], [503, false, "report_read_unavailable"]);
    is("the post is not hidden", (await readPost(id, hideMe))?.hid ?? null, false);
    is("its report is still in the queue", (await queued()).includes(`p:${hideMe}`), true);
  }

  part("2. Deleting a reported post whose read is unknown");
  lose = "post-empty";
  const deleted = await call({ action: "report-delete", key: `p:${deleteMe}` });
  lose = "none";
  is("refused, the post is still there, the report kept", [deleted.status, deleted.error, (await readPost(id, deleteMe))?.id ?? null, (await queued()).includes(`p:${deleteMe}`)], [503, "report_read_unavailable", deleteMe, true]);

  part("2. Hiding a reported comment whose read is unknown");
  lose = "comment-empty";
  const hidComment = await call({ action: "report-hide", key: `c:${holder}:${commentId}` });
  lose = "none";
  is("refused, the comment is not hidden, the report kept", [hidComment.status, hidComment.error, (await readComment(id, holder, commentId))?.hid ?? null, (await queued()).includes(`c:${holder}:${commentId}`)], [503, "report_read_unavailable", false, true]);

  part("2. Controls on exact replies");
  is("hiding the post hides it and clears its report", [(await call({ action: "report-hide", key: `p:${hideMe}` })).ok, (await readPost(id, hideMe))?.hid ?? null, (await queued()).includes(`p:${hideMe}`)], [true, true, false]);
  is("hiding the comment hides it", [(await call({ action: "report-hide", key: `c:${holder}:${commentId}` })).ok, (await readComment(id, holder, commentId))?.hid ?? null], [true, true]);
  is("deleting the post deletes it", [(await call({ action: "report-delete", key: `p:${deleteMe}` })).ok, await readPost(id, deleteMe)], [true, null]);
  await redis.pipeline([["DEL", `nl:cm:${id}:p:${gone}`]]);
  const cleared = await call({ action: "report-hide", key: `p:${gone}` });
  is("a post that is exactly gone: its report is cleared, ok", [cleared.status, cleared.ok, await queued()], [200, true, []]);

  // 3. Every other action reads the setup the same exact way: a lost read is never taken for "not set up", which would
  // tell a creator whose community is set up to set it up first (independent review of #2997, LOW).
  const setUp = shape(await readConfig(id));
  const others: Record<string, unknown>[] = [
    { action: "settings", name: "Renamed", about: "" },
    { action: "space-add", name: "Extra", about: "", creatorOnly: false, only: [], level: 0 },
    { action: "access", products: [product] },
    { action: "onboarding", questions: ["New?"], welcome: "Hi." },
    { action: "dismiss", key: `p:${hideMe}` },
  ];
  for (const mode of ["cfg-empty", "cfg-queued", "cfg-text"] as const) {
    for (const body of others) {
      part(`3. ${String(body.action)} while the setup's read is unknown (${mode})`);
      lose = mode;
      const answer = await call(body);
      lose = "none";
      is("refused as unavailable, not as not set up", [answer.status, answer.ok, answer.error], [503, false, "setup_read_unavailable"]);
      is("the setup is unchanged", shape(await readConfig(id)), setUp);
    }
  }

  part("3. Control: a setup that is exactly gone is still not set up");
  await redis.pipeline([["DEL", `nl:cm:${id}:cfg`]]);
  const unset = await call({ action: "settings", name: "Renamed", about: "" });
  is("400 not_set_up, nothing written", [unset.status, unset.error, await readConfig(id)], [400, "not_set_up", null]);
  done();
}
main();
