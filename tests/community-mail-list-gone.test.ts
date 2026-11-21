/**
 * A community announcement (lib/community-mail.ts, advanceAnnouncement) never goes to an address the store's list took
 * off for a hard bounce, a spam complaint or a refusal (`gone`, lib/contacts.ts; written by stopWriting, and since #4245
 * for every store email). The announcement read only the member's own "email me" choice, so a member who marked an
 * announcement as spam kept getting the next one, and an address that bounced for good kept being written to, on the
 * shared sender's reputation. A plain unsubscribe from the list does not stop announcements: the community's own stop
 * link does (a consent of its own). A list row in no known shape is unknown (rule 24): the batch waits, nobody is sent to.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { leadsKey } from "@/lib/contact-rules";
import type { Store } from "@/lib/store";
import { db, members, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
// A list id in the shape a store has (lib/store.ts LIST_ID_PATTERN), so the announcement can carry it as its stop tag.
const listId = "1".repeat(32);
const listed: Store = { ...store, listId } as Store;
const job: AnnouncementJob = {
  id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
};
const seed = (row: string | null) => {
  reset();
  db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(job)]);
  db.run(["RPUSH", `nl:cm:mail:${id}:to`, ...members.map((m) => m.k)]);
  db.run(["SADD", "nl:cm:mailq", id]);
  if (row !== null) db.run(["HSET", leadsKey(listId), members[0].e, row]);
};
const contact = (extra: Record<string, unknown>) => JSON.stringify({ agreed: true, agreedAt: "2026-09-01T00:00:00.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", t: "e".repeat(40), name: "", tags: [], importedAt: "", unsub: false, ...extra });
const to = () => sent.flat().map((m) => (m as { to: string }).to);

async function main(): Promise<void> {
  part("Control: both members are on the list in good standing");
  seed(contact({}));
  const healthy = await advanceAnnouncement(id, async () => listed, Date.now() + 10_000);
  is("sent to both", [healthy?.status, to()], ["sent", [members[0].e, members[1].e]]);
  // The real announcement names the store's list, so a bounce for good or a complaint on it takes the address off the
  // list (Claude 1 cloud's MEDIUM 2 on #4245: the bounce test sent a stand-in, never this sender).
  is("each announcement names the store's list", sent.flat().map((m) => (m as { tags?: Record<string, string> }).tags?.nl_stop), [listId, listId]);

  for (const why of ["complained", "bounced", "refused"] as const) {
    part(`Taken off the store's list as ${why}`);
    seed(contact({ unsub: true, unsubAt: "2026-11-01T00:00:00.000Z", gone: why }));
    const after = await advanceAnnouncement(id, async () => listed, Date.now() + 10_000);
    is("never sent to that address; the other member still gets it", to(), [members[1].e]);
    is("and the send finishes", after?.status, "sent");
  }

  part("A plain unsubscribe from the list does not stop announcements (the community has its own stop link)");
  seed(contact({ unsub: true, unsubAt: "2026-11-01T00:00:00.000Z" }));
  await advanceAnnouncement(id, async () => listed, Date.now() + 10_000);
  is("sent to both", to(), [members[0].e, members[1].e]);

  part("A list row in no known shape is unknown (rule 24)");
  seed("{");
  const unknown = await advanceAnnouncement(id, async () => listed, Date.now() + 10_000);
  is("nobody is sent to, and the send waits", [to().length, unknown?.status], [0, "waiting"]);

  done();
}

void main();
