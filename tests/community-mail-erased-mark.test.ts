/**
 * Codex L-20261121-0758 (row 20 of #5010): what the announcement queue does with the mark a person's erasure leaves
 * where their key stood (lib/erasure-lists.ts ERASED_MARK), and with the index of each community's sends under way
 * that the erasure reads (nl:cm:<community>:sends, MAX_SENDS_UNDER_WAY at most).
 *
 *   - A batch holding the mark passes over it, counted as done and never as sent, and the members after it are
 *     emailed in their places; before, the whole send stopped at "We couldn't read the remaining recipients".
 *   - A send is noted in its community's index when it is queued and let go of when it ends.
 *   - Past MAX_SENDS_UNDER_WAY the post goes up without its email ("busy"), and a place whose send record is gone
 *     (let go after sixty days) does not hold one.
 *
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, queueAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { MAX_SENDS_UNDER_WAY } from "@/lib/community-text";
import { ERASED_MARK } from "@/lib/erasure-lists";
import type { Post } from "@/lib/community";
import { config, db, members, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const community = store.community!.id;
const sends = `nl:cm:${community}:sends`;
const post = { id: "f".repeat(12), title: "Synthetic announcement", text: "Synthetic body", sp: "" } as unknown as Post;
const read = (id: string) => JSON.parse(String(db.run(["GET", `nl:cm:mail:${id}`]))) as AnnouncementJob;

async function main(): Promise<void> {
  part("a batch holding the erased mark passes over it, and the members after it are emailed");
  reset();
  const id = "e".repeat(24);
  const job: AnnouncementJob = { id, community, handle: store.handle, post: post.id, subject: "Synthetic", body: "Synthetic",
    total: 3, done: 0, sent: 0, status: "sending", note: "", failures: 0 };
  db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(job)]);
  db.run(["RPUSH", `nl:cm:mail:${id}:to`, members[0].k, ERASED_MARK, members[1].k]);
  db.run(["SADD", "nl:cm:mailq", id]);
  db.run(["SADD", sends, id]);
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  const after = read(id);
  is("sent to the two members, the mark passed over", [after.status, after.done, after.sent], ["sent", 3, 2]);
  is("one batch, to the two members only", sent.map((batch) => batch.length), [2]);
  is("out of line and out of its community's sends", [db.run(["SISMEMBER", "nl:cm:mailq", id]), db.run(["SISMEMBER", sends, id])], [0, 0]);

  part("a send that ends failed takes its recipient list with it (Claude 7 xAF on #5072, LEVE)");
  reset();
  const failing = "9".repeat(24);
  db.run(["SET", `nl:cm:mail:${failing}`, JSON.stringify({ ...job, id: failing, total: 2 })]);
  db.run(["RPUSH", `nl:cm:mail:${failing}:to`, members[0].k, members[1].k]);
  db.run(["SADD", "nl:cm:mailq", failing]);
  db.run(["SADD", sends, failing]);
  // Its community is not there any more: the send fails, and no erasure walks it after this.
  await advanceAnnouncement(failing, async () => null, Date.now() + 10_000);
  is("failed, its member keys gone, out of line and out of its community's sends",
    [read(failing).status, db.run(["EXISTS", `nl:cm:mail:${failing}:to`]), db.run(["SISMEMBER", "nl:cm:mailq", failing]), db.run(["SISMEMBER", sends, failing])],
    ["failed", 0, 0, 0]);

  part("a queued send is noted in its community's sends under way");
  reset();
  const queued = await queueAnnouncement(store, config, post);
  is("queued", queued.ok, true);
  if (queued.ok) is("and noted for the erasure to find", db.run(["SISMEMBER", sends, queued.job.id]), 1);

  part(`past ${MAX_SENDS_UNDER_WAY} sends under way the post is not emailed, and a stale place holds none`);
  reset();
  const live = Array.from({ length: MAX_SENDS_UNDER_WAY }, (_, i) => i.toString(16).padStart(24, "c"));
  for (const send of live) db.run(["SET", `nl:cm:mail:${send}`, "{}"]);
  db.run(["SADD", sends, ...live]);
  const busy = await queueAnnouncement(store, config, post);
  is("refused as busy, nothing queued", [busy.ok ? "queued" : busy.reason, db.run(["SCARD", "nl:cm:mailq"]), db.run(["SCARD", sends])], ["busy", 0, MAX_SENDS_UNDER_WAY]);
  db.run(["DEL", `nl:cm:mail:${live[0]}`]);
  const room = await queueAnnouncement(store, config, post);
  is("a place whose send is gone is let go, and the new send takes it", [room.ok, db.run(["SISMEMBER", sends, live[0]]), db.run(["SCARD", sends])], [true, 0, MAX_SENDS_UNDER_WAY]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
