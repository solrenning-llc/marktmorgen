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
import { RecipientsUnreadError, advanceAnnouncement, forgetAnnouncementRecipient, queueAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
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

  // Claude 2 lpgvy on #5072, LOW 1: a person erased in full after the members were read and before the send's list is
  // written. Their erasure finds no list to write over, so the list would keep their key until the send ends.
  part("a person erased while the members were read: the list is let go and nothing is sent");
  reset();
  const erased = members[0].k;
  const real = db.pipeline.bind(db);
  let fired = false;
  let list = "";
  db.pipeline = (async (commands: (string | number)[][]) => {
    const push = commands.find((c) => c[0] === "RPUSH" && /^nl:cm:mail:[0-9a-f]{24}:to$/.test(String(c[1])));
    if (!fired && push) {
      fired = true;
      list = String(push[1]);
      await forgetAnnouncementRecipient(community, erased);
    }
    return real(commands);
  }) as typeof db.pipeline;
  let raced: unknown = null;
  try {
    await queueAnnouncement(store, config, post);
  } catch (error) {
    raced = error;
  } finally {
    db.pipeline = real;
  }
  const kept = db.run(["LRANGE", list, 0, -1]) as string[];
  is("the erasure landed between the read and the list", fired, true);
  is("the post is said as not emailed", raced instanceof RecipientsUnreadError, true);
  is("the send's list is gone, the erased key with it", [db.run(["EXISTS", list]), kept.includes(erased)], [0, false]);
  is("nothing in line, no place held, nothing sent", [db.run(["SCARD", "nl:cm:mailq"]), db.run(["SCARD", sends]), sent.length], [0, 0, 0]);
  const again = await queueAnnouncement(store, config, post);
  is("the next announcement, with nobody erased while it reads, is queued", again.ok, true);
  // Claude 4 AC on #5072, LEVE: a send holds its place from before its members are read until its record is saved, and
  // a sweep past the cap (another send's, or an erasure's) let go of a place with no record, so a slow send's place
  // could go: more sends than the cap at once, and an erasure later not finding that send's list.
  part("a send still reading its members keeps its place against the sweeps of another send and of an erasure");
  reset();
  const busyLive = Array.from({ length: MAX_SENDS_UNDER_WAY - 1 }, (_, i) => i.toString(16).padStart(24, "a"));
  for (const send of busyLive) db.run(["SET", `nl:cm:mail:${send}`, "{}"]);
  db.run(["SADD", sends, ...busyLive]);
  const realPipe = db.pipeline.bind(db);
  let paused = false;
  let other: Awaited<ReturnType<typeof queueAnnouncement>> | null = null;
  let held: string[] = [];
  let erasedDuring: unknown = "not run";
  db.pipeline = (async (commands: (string | number)[][]) => {
    if (!paused && commands.some((c) => c[0] === "GET" && c[1] === `nl:cm:${community}:erasures`)) {
      paused = true;
      held = (db.run(["SMEMBERS", sends]) as string[]).filter((id) => !busyLive.includes(id));
      db.pipeline = realPipe;
      // While the slow send reads: another send past the cap, then an erasure past it (a dead place added first).
      other = await queueAnnouncement(store, config, post);
      db.run(["SADD", sends, "d".repeat(24)]);
      try { erasedDuring = await forgetAnnouncementRecipient(community, "nobody-here"); } catch (error) { erasedDuring = error; }
    }
    return realPipe(commands);
  }) as typeof db.pipeline;
  let slow: Awaited<ReturnType<typeof queueAnnouncement>> | null = null;
  try {
    slow = await queueAnnouncement(store, config, post);
  } finally {
    db.pipeline = realPipe;
  }
  is("the slow send had taken its place before reading", held.length, 1);
  is("the send that came meanwhile is refused as busy, not given the slow send's place", other === null ? "none" : (other as { ok: boolean; reason?: string }).ok ? "queued" : (other as { reason: string }).reason, "busy");
  is("the erasure meanwhile lets the dead place go and walks the sends", [erasedDuring, db.run(["SISMEMBER", sends, "d".repeat(24)])], [0, 0]);
  is("the slow send keeps its place and is queued", [slow?.ok, db.run(["SISMEMBER", sends, held[0] ?? ""]), db.run(["SCARD", sends])], [true, 1, MAX_SENDS_UNDER_WAY]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
