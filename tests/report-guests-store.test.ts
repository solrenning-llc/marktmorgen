/**
 * 405 [HX1] unit 3: where a store keeps the numbers email to addresses
 * outside the team: the creator's choice, the addresses with their state, and
 * the confirm and leave links' records. Synthetic stores and addresses on the
 * in-memory database only; nothing is sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { store as redis } from "./redis-stub";
import { FOLLOWERS, followable } from "@/lib/closed-store-data";
import { CLOSING, closingFamilyOf } from "@/lib/data-families";
import { linkFits, linkHash } from "@/lib/report-guests-links";
import { INVITE_DAYS } from "@/lib/report-guests-rules";
import {
  LEAVE_LINK_DAYS,
  NO_SHARE,
  SHARE_RECORD_BYTES,
  forgetGuestPerson,
  leaveToken,
  readLink,
  readShare,
  saveShare,
  type KeptGuest,
} from "@/lib/report-guests";
import { UnknownReplyError } from "@/lib/redis-reply";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const PEOPLE = { team: ["member@example.test"], owner: "owner@example.test" };
let n = 0;
const sid = () => `sidhx1${++n}`;
const run = (command: (string | number)[]) => redis.pipeline([command]).then((replies) => replies[0]);

async function allValues(): Promise<string[]> {
  const keys = ((await run(["SCAN", "0", "MATCH", "nl:rguest:*"])) as [string, string[]])[1].sort();
  const out: string[] = [];
  for (const key of keys) {
    const type = await run(["TYPE", key]);
    if (type === "string") out.push(key, String(await run(["GET", key])));
    else out.push(key);
  }
  return out;
}

test("a store that saved nothing has nothing chosen and nobody on its list", async () => {
  assert.deepEqual(await readShare(sid()), NO_SHARE);
  assert.deepEqual(NO_SHARE.figures, []);
});

test("saving invites each new address, keeps only hashes, and stays inside its byte cap", async () => {
  const id = sid();
  const saved = await saveShare(id, { figures: ["visits", "sales"], every: "month", addresses: ["Partner@Example.test", " books@example.test "] }, PEOPLE, NOW);
  assert.ok(saved.ok);
  assert.deepEqual(saved.share.figures, ["sales", "visits"]);
  assert.equal(saved.share.every, "month");
  assert.deepEqual(saved.share.guests.map((g) => [g.address, g.state, g.invitedAt]), [["partner@example.test", "invited", NOW], ["books@example.test", "invited", NOW]]);
  assert.deepEqual(saved.invites.map((i) => i.address), ["partner@example.test", "books@example.test"]);
  assert.deepEqual(await readShare(id), saved.share);

  const values = await allValues();
  for (const invite of saved.invites) {
    for (const token of [invite.confirmToken, invite.leaveToken]) {
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!values.some((value) => value.includes(token)), "a token is never kept as it is");
    }
    const guest: KeptGuest = saved.share.guests.find((g) => g.address === invite.address)!;
    assert.equal(guest.confirm, linkHash(invite.confirmToken));
    assert.equal(guest.leave, linkHash(invite.leaveToken));
    assert.equal(leaveToken(id, guest), invite.leaveToken, "the leave link is the same in every email of this invitation");
    const confirm = await readLink(invite.confirmToken);
    assert.equal(linkFits(confirm, { kind: "confirm", store: id }, guest, NOW + DAY), "ok");
    assert.equal(linkFits(await readLink(invite.leaveToken), { kind: "leave", store: id }, guest, NOW + DAY), "ok");
    const confirmTtl = Number(await run(["TTL", `nl:rguest:link:${guest.confirm}`]));
    const leaveTtl = Number(await run(["TTL", `nl:rguest:link:${guest.leave}`]));
    assert.ok(confirmTtl > INVITE_DAYS * 86_400 && confirmTtl <= (INVITE_DAYS + 1) * 86_400, `confirm lives ${confirmTtl}s`);
    assert.ok(leaveTtl > 0 && leaveTtl <= LEAVE_LINK_DAYS * 86_400, `leave lives ${leaveTtl}s`);
  }
  const raw = String(await run(["GET", `nl:rguest:${id}`]));
  assert.ok(Buffer.byteLength(raw) <= SHARE_RECORD_BYTES);
});

test("the fullest record fits its cap", async () => {
  const id = sid();
  const long = (c: string) => `${c.repeat(64)}@${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.ex`;
  const saved = await saveShare(id, { figures: ["sales", "revenue", "visits", "subscribers", "affiliates"], every: "week", addresses: [long("a"), long("b"), long("c")] }, PEOPLE, NOW);
  assert.ok(saved.ok);
  assert.ok(Buffer.byteLength(String(await run(["GET", `nl:rguest:${id}`]))) <= SHARE_RECORD_BYTES);
});

test("saving the same list again invites nobody again", async () => {
  const id = sid();
  const first = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(first.ok);
  const again = await saveShare(id, { figures: ["sales", "revenue"], every: "week", addresses: ["PARTNER@example.test"] }, PEOPLE, NOW + DAY);
  assert.ok(again.ok);
  assert.deepEqual(again.invites, []);
  assert.deepEqual(again.share.guests, first.share.guests);
  assert.deepEqual(again.share.figures, ["sales", "revenue"]);
});

test("an address taken off the list loses both its links", async () => {
  const id = sid();
  const first = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test", "books@example.test"] }, PEOPLE, NOW);
  assert.ok(first.ok);
  const books = first.share.guests[1];
  const saved = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW + 1);
  assert.ok(saved.ok);
  assert.deepEqual(saved.share.guests.map((g) => g.address), ["partner@example.test"]);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${books.confirm}`]), 0);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${books.leave}`]), 0);
  assert.equal(await readLink(first.invites[1].confirmToken), null);
});

test("an address that left is invited again, with a new invitation and new links", async () => {
  const id = sid();
  const first = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(first.ok);
  const old = first.share.guests[0];
  // As the leave route will (unit 4): the state written as left.
  await run(["SET", `nl:rguest:${id}`, JSON.stringify({ v: 1, figures: ["sales"], every: "week", guests: [{ ...old, state: "left" }] })]);
  const again = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(again.ok);
  const fresh = again.share.guests[0];
  assert.equal(fresh.state, "invited");
  assert.ok(fresh.invitedAt > old.invitedAt, "a new invitation, even in the same millisecond");
  assert.notEqual(fresh.confirm, old.confirm);
  assert.notEqual(fresh.leave, old.leave);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${old.confirm}`]), 0);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${old.leave}`]), 0);
  assert.deepEqual(again.invites.map((i) => i.address), ["partner@example.test"]);
});

test("a list that cannot be taken changes nothing", async () => {
  const id = sid();
  const first = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(first.ok);
  const before = await allValues();
  const cases: [unknown, string][] = [
    [{ figures: ["sales"], every: "week", addresses: ["a@example.test", "b@example.test", "c@example.test", "d@example.test"] }, "too_many"],
    [{ figures: ["sales"], every: "week", addresses: ["member@example.test"] }, "on_the_team"],
    [{ figures: ["sales"], every: "week", addresses: ["owner@example.test"] }, "own_address"],
    [{ figures: ["sales"], every: "week", addresses: ["not an address"] }, "not_an_address"],
    [{ figures: ["buyers"], every: "week", addresses: [] }, "invalid"],
    [{ figures: ["sales"], every: "day", addresses: [] }, "invalid"],
    [{ figures: ["sales"], every: "week", addresses: "partner@example.test" }, "invalid"],
    [{ figures: ["sales"], every: "week", addresses: Array.from({ length: 11 }, () => "") }, "invalid"],
  ];
  for (const [input, why] of cases) {
    const refused = await saveShare(id, input as Parameters<typeof saveShare>[1], PEOPLE, NOW + DAY);
    assert.ok(!refused.ok, why);
    assert.equal(refused.why, why);
  }
  assert.deepEqual(await allValues(), before);
});

test("a record that does not read is unknown, never an empty list, and is not written over", async () => {
  const id = sid();
  for (const bad of ["not json", JSON.stringify({ v: 2, figures: [], every: "week", guests: [] }), JSON.stringify({ v: 1, figures: ["x"], every: "week", guests: [] }), JSON.stringify({ v: 1, figures: [], every: "week", guests: [{ address: "a@example.test", state: "invited", invitedAt: NOW, confirm: "z", leave: "z" }] })]) {
    await run(["SET", `nl:rguest:${id}`, bad]);
    await assert.rejects(readShare(id), UnknownReplyError);
    await assert.rejects(saveShare(id, { figures: [], every: "week", addresses: [] }, PEOPLE, NOW), UnknownReplyError);
    assert.equal(await run(["GET", `nl:rguest:${id}`]), bad);
    await assert.rejects(forgetGuestPerson(id, "a@example.test"), UnknownReplyError);
  }
  await run(["DEL", `nl:rguest:${id}`]);
  await run(["SADD", `nl:rguest:${id}`, "x"]);
  // A key of another kind is refused by the database itself: still a failure, never an empty list.
  await assert.rejects(readShare(id));
});

test("a link that is not a token, or whose record is gone, reads as nothing", async () => {
  assert.equal(await readLink("short"), null);
  assert.equal(await readLink("A".repeat(43)), null);
});

test("deleting the person takes them and their links off this store only", async () => {
  const a = sid();
  const b = sid();
  const savedA = await saveShare(a, { figures: ["sales"], every: "week", addresses: ["partner@example.test", "books@example.test"] }, PEOPLE, NOW);
  const savedB = await saveShare(b, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(savedA.ok && savedB.ok);
  const partner = savedA.share.guests[0];
  assert.equal(await forgetGuestPerson(a, " PARTNER@example.test"), 1);
  assert.deepEqual((await readShare(a)).guests.map((g) => g.address), ["books@example.test"]);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${partner.confirm}`]), 0);
  assert.equal(await run(["EXISTS", `nl:rguest:link:${partner.leave}`]), 0);
  assert.deepEqual((await readShare(b)).guests.map((g) => g.address), ["partner@example.test"]);
  assert.equal(await forgetGuestPerson(a, "partner@example.test"), 0, "a second time finds nothing");
  assert.equal(await forgetGuestPerson(sid(), "partner@example.test"), 0);
});

test("a closing store's record leads the walk to its links, and to nothing else", async () => {
  const id = sid();
  const saved = await saveShare(id, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, PEOPLE, NOW);
  assert.ok(saved.ok);
  const guest = saved.share.guests[0];
  assert.equal(closingFamilyOf(`nl:rguest:${id}`), "nl:rguest:");
  assert.equal(CLOSING["nl:rguest:"].how, "erase");
  assert.equal(closingFamilyOf(`nl:rguest:link:${guest.leave}`), "nl:rguest:link:");
  assert.equal(closingFamilyOf(`nl:rguest:lock:${id}`), "nl:rguest:lock:");
  const follower = FOLLOWERS["nl:rguest:"];
  assert.ok(follower.match(`nl:rguest:${id}`));
  assert.ok(!follower.match(`nl:rguest:link:${guest.leave}`));
  assert.ok(!follower.match(`nl:rguest:lock:${id}`));
  const found = await follower.find([`nl:rguest:${id}`], undefined as never);
  assert.deepEqual(found.sort(), [`nl:rguest:link:${guest.confirm}`, `nl:rguest:link:${guest.leave}`].sort());
  for (const key of found) assert.ok(followable(key, "nl:rguest:"));
});

test("the person's copy says what is kept about them here, without the link hashes", async () => {
  const { COPIERS } = await import("@/lib/person-copy");
  const id = sid();
  const saved = await saveShare(id, { figures: ["visits"], every: "month", addresses: ["partner@example.test", "books@example.test"] }, PEOPLE, NOW);
  assert.ok(saved.ok);
  const copy = await COPIERS["lib/report-guests.ts"]({ sid: id, email: "Partner@example.test" } as never);
  assert.deepEqual(copy, [{ state: "invited", invited: new Date(NOW).toISOString(), figures: ["visits"], every: "month" }]);
  assert.ok(!JSON.stringify(copy).includes(saved.share.guests[0].confirm));
  assert.deepEqual(await COPIERS["lib/report-guests.ts"]({ sid: id, email: "nobody@example.test" } as never), []);
});
