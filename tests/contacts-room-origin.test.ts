/**
 * Where a contact's and a community member's room was taken is kept in the
 * record (Contact.r, Member.r), so deleting the person (lib/person-erasure.ts)
 * gives it back there, once: a contact from a sign-up to the contacts' slot,
 * one an order put on the list to the orders' part; a member's first write to
 * the orders' part and what it grew by to the members' slot. Records written
 * before the field existed are left counted, never given back by a guess.
 * A member's trace is given back by the deletion, and deleting a post or
 * comment of theirs afterwards gives nothing back a second time.
 */
import { forgetContactPerson, leadsKey, orderRoom, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { CREATOR, createPost, deleteComment, addComment, deletePost, setMail, setMemberToken, setProfile, toggleLike, touchMember } from "@/lib/community";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { fieldReleaseBytes } from "@/lib/order-data";
import { dataKey, dataUsed, noteData } from "@/lib/store-data";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const LIST = "l".repeat(16);
const room = dataKey(ROOM)!;
const used = async () => (await dataUsed(ROOM))?.used ?? 0;
const slot = async (name: string) => Number((await redis.pipeline([["HGET", room, name]]))[0] ?? 0);
const twice = <T>(run: () => Promise<T>) => Promise.all([run(), run()]);
const signUp = (email: string) => upsertContact(LIST, email, { agreed: true, explicit: true, source: "free" }, ROOM);
const purchase = (email: string, productId: string) => upsertContact(LIST, email, { agreed: false, explicit: false, source: "buyer", productId, title: "The Bread Book" }, orderRoom(ROOM));
const rawOf = async (email: string) => String((await redis.pipeline([["HGET", leadsKey(LIST), email]]))[0]);
/** The record as the orders' part is given back at: without the token and what leaving adds. */
const counted = (raw: string) => {
  const { t: _t, unsub: _u, unsubAt: _a, gone: _g, ...rest } = JSON.parse(raw) as Record<string, unknown>;
  void [_t, _u, _a, _g];
  return JSON.stringify(rest);
};

async function contacts(): Promise<void> {
  await signUp("ben@example.com");
  await purchase("cleo@example.com", "prodone");

  part("A contact from a sign-up gives back to the contacts' slot what it took, once");
  const before = await used();
  await signUp("ana@example.com");
  is("it is marked as counted in the contacts' slot", JSON.parse(await rawOf("ana@example.com")).r, "c");
  // A purchase afterwards is counted in the same slot, and its token and leaving are written uncounted.
  await purchase("ana@example.com", "prodtwo");
  await tokensFor(LIST, ["ana@example.com"], "harbor");
  const token = JSON.parse(await rawOf("ana@example.com")).t as string;
  await unsubscribe(token);
  is("still counted in the contacts' slot", JSON.parse(await rawOf("ana@example.com")).r, "c");
  const [first, second] = await twice(() => forgetContactPerson(LIST, "ana@example.com", ROOM));
  is("one deletion took her", [first, second].sort(), [0, 2]);
  is("exactly her room came back", await used(), before);

  part("A contact an order put on the list gives back its field's share of the orders' part, once");
  const beforeOrder = await used();
  await purchase("dana@example.com", "prodone");
  is("it is marked as counted in the orders' part", JSON.parse(await rawOf("dana@example.com")).r, "o");
  const ordersAfterOrder = (await dataUsed(ROOM))?.orders ?? 0;
  // A sign-up afterwards grows it in the orders' part too, never in the contacts' slot.
  const contactsBefore = await slot("ct");
  await signUp("dana@example.com");
  is("the contacts' slot is not touched", await slot("ct"), contactsBefore);
  is("the orders' part grew", ((await dataUsed(ROOM))?.orders ?? 0) > ordersAfterOrder, true);
  const raw = await rawOf("dana@example.com");
  const withDana = await used();
  await twice(() => forgetContactPerson(LIST, "dana@example.com", ROOM));
  is("its field's share came back once", withDana - (await used()), fieldReleaseBytes("dana@example.com", counted(raw)));
  is("never more than it took", (await used()) >= beforeOrder, true);

  part("A contact written before the field existed is left counted");
  const legacy = JSON.stringify({ agreed: true, agreedAt: "", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "", name: "", tags: [], importedAt: "" });
  await redis.pipeline([["HSET", leadsKey(LIST), "eve@example.com", legacy], ["INCR", `${leadsKey(LIST)}:agreed`]]);
  await noteData(ROOM, [{ slot: "ct", bytes: 1_024 }]);
  const withEve = await used();
  is("Eve is deleted", await forgetContactPerson(LIST, "eve@example.com", ROOM), 1);
  is("and nothing is given back for her", await used(), withEve);
}

async function community(): Promise<void> {
  const ID = "cmorigin";
  const bia = await touchMember(ID, "bia@example.com", null, ROOM);
  await setProfile(ID, bia!, { name: "Bia", dir: true, mail: false }, ROOM);

  part("A member's record: its first write to the orders' part, what it grew by to the members' slot, once");
  const members = await slot("cm:m");
  const before = await used();
  const ana = await touchMember(ID, "ana@example.com", null, ROOM);
  is("the record is marked as made by an order", ana?.r, "o");
  const first = String((await redis.pipeline([["HGET", `nl:cm:${ID}:m`, ana!.k]]))[0]);
  const named = await setProfile(ID, ana!, { name: "Ana Lima", dir: true, mail: true, answers: ["Baking bread at home"], questions: ["What brings you here?"] }, ROOM);
  // Written uncounted afterwards: the emails switch, a token.
  await setMail(ID, named, false);
  await setMemberToken(ID, named, "f".repeat(40));
  is("her name takes room in the members' slot", (await slot("cm:m")) > members, true);

  part("Her posts, comments and likes are in her trace; the deletion gives it back once");
  const post = await createPost(ID, { space: "general", author: ana!.k, title: "Hello", text: "My first loaf", img: null, kind: "post", poll: null }, ROOM);
  if (!post.ok) throw new Error("no post");
  const theirs = await createPost(ID, { space: "general", author: CREATOR, title: "Welcome", text: "Say hello", img: null, kind: "post", poll: null }, ROOM);
  if (!theirs.ok) throw new Error("no post");
  await toggleLike(ID, theirs.post.id, ana!.k, ROOM);
  const comment = await addComment(ID, theirs.post.id, { author: ana!.k, text: "Thanks!", parent: "" }, ROOM);
  if (!comment.ok) throw new Error("no comment");
  const withAna = await used();
  // Two deletions at once: Bia's record and trace stay counted, so a second give-back would show.
  await twice(() => forgetCommunityPerson(ID, ana!.k, "ana@example.com", [], ROOM));
  is("the members' slot is back where it was", await slot("cm:m"), members);
  is("the orders' part gave back her first write's share", withAna - (await used()) >= fieldReleaseBytes(ana!.k, first), true);
  const afterAna = await used();
  is("nothing more than she took came back", afterAna >= before, true);

  part("Deleting her post and comment afterwards gives nothing back a second time");
  await deletePost(ID, post.post, ROOM);
  await deleteComment(ID, theirs.post.id, comment.comment, ROOM);
  is("the members' slot does not move", await slot("cm:m"), members);

  part("A member written before the field existed is left counted");
  const old = JSON.stringify({ k: emailKey("old@example.com"), e: "old@example.com", n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] });
  await redis.pipeline([["HSET", `nl:cm:${ID}:m`, emailKey("old@example.com"), old]]);
  const withOld = await used();
  await forgetCommunityPerson(ID, emailKey("old@example.com"), "old@example.com", [], ROOM);
  is("nothing is given back for the record", await used(), withOld);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await contacts();
  await community();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
