/**
 * Deleting a person, end to end (added 17 October 2026), against whichever
 * Redis "@/lib/redis" is built with: the in-memory one in
 * tests/person-erasure.test.ts, a real one in
 * scripts/test_contact_erasure_redis.py.
 *
 * A store is made and somebody else put in every part of it; everything
 * Redis holds is read. Then the person is put in every part of it too
 * (tests/erasure-world.ts) and deleted, by their own emailed link, and
 * everything is read again: what was there before them must be there as it
 * was, and nothing of theirs may be left but the store's fingerprint of
 * their address, the activity log's line, the counts that pay for it, and
 * the records the registry says are kept (lib/person-data.ts). Then the
 * same through the studio's door, where their reviews and what an import
 * gave them stay, as that door promises.
 */
import { redisPipeline } from "@/lib/redis";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { personKey } from "@/lib/person-key";
import { importContactRows, leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { isSuppressed } from "@/lib/suppression";
import { confirmErasure, readErasureLink, requestErasureLink } from "@/lib/erasure-request";
import { erasePerson, erasureScope, erasureSize } from "@/lib/person-erasure";
import { erasureUnits, erasureWork, workUnits } from "@/lib/erasure-rules";
import { storesKnownFor } from "@/lib/buyer-library";
import { storeForEmail } from "@/lib/store";
import { OWNER, makeWorld, seedPerson, snapshot } from "./erasure-world";
import { ROOM } from "./data-room";

export type Check = (what: string, got: unknown, want: unknown) => void;
export type Sent = { to: string; subject: string; text: string };

/** Keys whose change a deletion is allowed to leave: what pays for it, what records that it happened, what it keeps on purpose. */
const ALLOWED: { pattern: RegExp; why: string }[] = [
  { pattern: /^nl:erased:/, why: "the fingerprint of the deleted address (lib/suppression.ts)" },
  { pattern: /^nl:team:log:/, why: "the activity log's line of a deletion from the studio, without the address" },
  { pattern: /^nl:(allow|rl|rlm|traffic|free:pool|fp|pool|usage|studio|spend|ses|mail:day|mail:used):/, why: "counts that pay for the work and limit it" },
  { pattern: /^nl:mail:flowstats:/, why: "a workflow's counts of how many started, never who" },
  { pattern: /^nl:cm:[0-9a-f]+:pts:b:/, why: "a board worked out again when next read" },
  { pattern: /^nl:rev:(sum|stores):/, why: "a review summary worked out again" },
  { pattern: /^nl:lc:[^:]+:(seen|r)$/, why: "comment counts" },
  { pattern: /^nl:wl:[^:]+:[^:]+:send$/, why: "a launch's list, with the deleted address written over (lib/erasure-lists.ts)" },
  { pattern: /^nl:store:leads:[^:]+:(agreed|unsub)$/, why: "the list's counts" },
  { pattern: /^nl:(health|stats:[0-9a-f]+:ledger)/, why: "short-lived copies (ten minutes, the buyers' an hour), worked out again when next read" },
  { pattern: /^nl:(sender|wf:day):/, why: "counts of emails and workflow runs, never who" },
  { pattern: /^nl:tasks:doors$/, why: "files waiting for the daily job to delete them, when the file store did not answer" },
  { pattern: /^nl:rsum:(ver|last):[0-9a-f]+:[A-Za-z0-9_-]+$/, why: "a random mark that a product's reviews changed, so an AI summary counting the deleted review is not kept (lib/reviews.ts), and when the week's last summary was made, never who" },
  { pattern: /^nl:data:/, why: "the store's data room, counting what a deletion gave back (lib/store-data.ts), never who" },
];

/** What the registry keeps on purpose, so may still name them: their own stop presses, as one-way hashes. */
const KEPT_ON_PURPOSE = [/^nl:recover:off:/, /^nl:upd:off:/, /^nl:rev:off:/];

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of after) {
    if (before.get(key) !== value) out.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) out.push(key);
  return [...new Set(out)].sort();
}

/** Everything that names the person, however it is made: their address and each key made from it. */
function marks(statsId: string, email: string): string[] {
  return [email, emailKey(email), personKey(statsId, email)];
}

export async function runJourney(is: Check, sent: Sent[], counted: { commands: number; bytes: number; on: boolean }): Promise<void> {
  const world = await makeWorld();
  const { store } = world;
  const statsId = store.statsId as string;
  const listId = store.listId as string;
  const other = "carol@example.com";
  await seedPerson(world, other, null);
  const before = await snapshot();

  // ---------------------------------------------------------------- by the person's own link
  const tess = normaliseEmail("Tess.Taylor@Example.com");
  await seedPerson(world, tess, other);
  const seeded = await snapshot();
  const theirs = [...seeded].filter(([key, value]) => marks(statsId, tess).some((m) => key.includes(m) || value.includes(m)));
  is("the person is in many parts of the store", theirs.length > 25, true);
  is("and their seeding changed many keys, so the comparison below means something", changes(before, seeded).length > 60, true);
  is("the store finds them for every-store requests", (await storesKnownFor(tess)).includes(store.sid), true);

  const asked = await requestErasureLink({ email: tess, ip: "203.0.113.7", origin: "https://marktmorgen.com", handle: store.handle });
  is("asking sends a link", asked, "sent");
  // The link goes after the answer (lib/erasure-request.ts, afterAnswer): wait for it before reading what was sent.
  for (let i = 0; i < 200 && !sent.some((m) => m.to === tess && m.text.includes("/privacy/delete?token=")); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const mail = sent.find((m) => m.to === tess && m.text.includes("/privacy/delete?token="));
  const token = mail?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("the email carries a link that works", token.length, 64);
  is("asking about an address no store knows sends nothing, and says the same", [await requestErasureLink({ email: "nobody@example.com", ip: "203.0.113.8", origin: "https://marktmorgen.com", handle: store.handle }), sent.some((m) => m.to === "nobody@example.com")], ["sent", false]);
  const link = await readErasureLink(token);
  is("the link names the address and the store", [link?.email, link?.stores.map((s) => s.sid)], [tess, [store.sid]]);

  // What it sends is counted, and must fit what it takes.
  const scope = await erasureScope(store, tess);
  const size = await erasureSize(scope!);
  const work = erasureWork(size);
  counted.commands = 0;
  counted.bytes = 0;
  counted.on = true;
  const done = await confirmErasure(token);
  counted.on = false;
  is("the link deletes them", [done.state, done.deleted], ["done", [store.name]]);
  is(`it sent no more commands than it took units for (${counted.commands} of ${work.commands})`, counted.commands <= work.commands, true);
  is(`and moved no more bytes (${counted.bytes} of ${work.bytes})`, counted.bytes <= work.bytes, true);
  is("the units it takes cover that work", erasureUnits(size) >= workUnits(work), true);
  is("the link works once", (await confirmErasure(token)).state, "gone");
  is("the store's owner is told, not asked", sent.some((m) => m.to === OWNER && m.subject.includes("deleted their data")), true);

  const after = await snapshot();
  const allowed = changes(before, after).filter((key) => ALLOWED.some((a) => a.pattern.test(key)));
  console.log(`  (left as allowed: ${allowed.map((key) => key.replace(/[0-9a-f]{20,}/g, "…")).join(", ")})`);
  const changed = changes(before, after).filter((key) => !ALLOWED.some((a) => a.pattern.test(key)));
  is("everything is as it was before them, but what is allowed to change", changed, []);
  const left = [...after].filter(([key, value]) => marks(statsId, tess).some((m) => key.includes(m) || value.includes(m)));
  is("no key or value names them, by address or by any key made from it", left.map(([key]) => key), []);
  const suppressionOnly = [...after].filter(([key]) => /^nl:erased:/.test(key));
  is("only a fingerprint is kept, under the store's list", suppressionOnly.map(([key, value]) => [key, (JSON.parse(value) as string[]).length]), [[`nl:erased:${listId}`, 1]]);
  is("which cannot be read back to the address", suppressionOnly.some(([, value]) => value.includes(tess) || value.includes("@")), false);
  is("the other person is untouched", parseContact((await redisPipeline([["HGET", leadsKey(listId), other]]))[0])?.agreed, true);

  // Never emailed again, and no import puts them back.
  is("the store knows the address was deleted", await isSuppressed(listId, tess), true);
  is("an import leaves them out", await importContactRows(listId, [{ email: tess, name: "Tess", tags: [] }], ROOM), ["left"]);
  await upsertContact(listId, tess, { agreed: true, explicit: false, source: "buyer", productId: world.plain, title: "The Guide" }, ROOM);
  is("a purchase without their own yes notes the purchase, not a yes", parseContact((await redisPipeline([["HGET", leadsKey(listId), tess]]))[0])?.agreed, false);
  await upsertContact(listId, tess, { agreed: true, explicit: true, source: "free", sid: store.sid }, ROOM);
  is("their own yes, given again, puts them back and lifts the fingerprint", [parseContact((await redisPipeline([["HGET", leadsKey(listId), tess]]))[0])?.agreed, await isSuppressed(listId, tess)], [true, false]);

  // ---------------------------------------------------------------- by the studio's door
  const sam = normaliseEmail("sam.stone@example.com");
  const beforeSam = await snapshot();
  await seedPerson(world, sam, other);
  const current = (await storeForEmail(OWNER))!;
  const result = await erasePerson(current, sam, { kind: "team", who: OWNER, role: "owner" });
  is("the studio deletes them", result.ok, true);
  const afterSam = await snapshot();
  const samLeft = [...afterSam].filter(([key, value]) => marks(statsId, sam).some((m) => key.includes(m) || value.includes(m))).map(([key]) => key);
  is(
    "what the studio's door keeps: what an import gave them, by a one-way hash; nothing else names them",
    samLeft.filter((key) => !/^nl:imp:/.test(key)),
    [],
  );
  const reviews = [...afterSam].filter(([key]) => key === `nl:rev:${statsId}:${world.plain}`);
  is("their review stays, without their address (a store may not take reviews down)", reviews.length === 1 && !reviews[0][1].includes(sam), true);
  const samChanged = changes(beforeSam, afterSam).filter((key) => !ALLOWED.some((a) => a.pattern.test(key)) && !/^nl:(imp:|rev:|lib:)/.test(key) && !KEPT_ON_PURPOSE.some((p) => p.test(key)));
  is("and everything else is as it was before them", samChanged, []);
  is("the activity log says a person was deleted, never who", (await redisPipeline([["LRANGE", `nl:team:log:${store.sid}`, 0, -1]]))[0] && JSON.stringify((await redisPipeline([["LRANGE", `nl:team:log:${store.sid}`, 0, -1]]))[0]).includes(sam), false);
}
