/**
 * An announcement emailed from a space kept for the buyers of a product goes
 * only to members who can see that space (lib/community-mail.ts,
 * advanceAnnouncement). Its email carries the post's whole text, so a member
 * of the community without that product, whom the post page, the feed and
 * search all keep out of the space, must never be sent it. Checked for a send
 * that keeps its space and for one queued before it did (the post is read).
 * A space open to every member still reaches everyone.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { config, db, members, reset, sent, setPostSpace, setSeesSpace, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
const GATED = "g".repeat(12);
const OPEN = "o".repeat(12);
(config as unknown as { spaces: unknown[] }).spaces = [
  { id: OPEN, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
  { id: GATED, name: "Course students", about: "", creatorOnly: false, only: ["prodcourse1"], level: 0 },
];
const seed = (space?: string) => {
  reset();
  const job: AnnouncementJob = {
    id, community: store.community!.id, handle: store.handle, post: "f".repeat(12), ...(space ? { space } : {}),
    subject: "Students: bonus key", body: "The answer key is 42-ALPHA.", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
  };
  db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(job)]);
  db.run(["RPUSH", `nl:cm:mail:${id}:to`, ...members.map((m) => m.k)]);
  db.run(["SADD", "nl:cm:mailq", id]);
};
const outsider = members[1].e;
const to = () => sent.flat().map((m) => (m as { to: string }).to);

async function main(): Promise<void> {
  part("A send that kept its gated space");
  seed(GATED);
  setSeesSpace((email) => email !== outsider);
  const gated = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("finished", gated?.status, "sent");
  is("only the member who can see the space was emailed", to(), [members[0].e]);
  is("the outsider never got its words", to().includes(outsider), false);

  part("A send queued before it kept its space: the post is read for it");
  seed();
  setSeesSpace((email) => email !== outsider);
  setPostSpace(GATED);
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("only the member who can see the space was emailed", to(), [members[0].e]);

  part("Control: a space open to every member reaches everyone");
  seed(OPEN);
  setSeesSpace((email) => email !== outsider);
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("both members emailed", to().sort(), members.map((m) => m.e).sort());
  done();
}

void main();
