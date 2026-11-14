/**
 * Codex P on #3020 @a0329c01 (MEDIUM, storage accounting): a held picture's place was given back whenever its line's
 * HDEL answered any count, zero included. Two erasures of the same author (or an erasure while the creator's removal
 * is deleting the same picture) both deleted the file, both read their HDEL as done, and both gave the place back: the
 * folder's count fell below the pictures it still keeps. Only the HDEL that took the line away (1) gives the place
 * back; a zero means somebody else already did, and an unknown reply never does.
 */
import { forgetHeldPerson, holdPost, removeHeld } from "@/lib/community-approval";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { files } from "./buyer-actions-blob";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const ada = "a".repeat(31) + "1";
const folder = "f".repeat(24);
const COUNT = `nl:cimg:n:${folder}`;
const P = `community/${folder}/held-p.png`;
const Q = `community/${folder}/kept-q.png`;
const withPicture = { space: SPACE, author: ada, title: "", text: "", img: { path: P, w: 100, h: 100, alt: "A drawing" }, kind: "post" as const, poll: null };

async function count(): Promise<number> {
  return Number((await redis.pipeline([["GET", COUNT]]))[0]);
}

async function fresh(t0: number): Promise<string> {
  redis.clear();
  files.clear();
  files.add(P);
  files.add(Q);
  const held = await holdPost(id, withPicture, ROOM, t0);
  if (!held.ok) throw new Error("not held");
  // Two pictures kept in the folder: P, held with the post, and Q, in somebody else's post.
  await redis.pipeline([["SET", COUNT, 2]]);
  return held.held.id;
}

async function main(): Promise<void> {
  const t0 = 1_800_000_000;

  part("Two erasures of the same author at once");
  await fresh(t0);
  const both = await Promise.all([forgetHeldPerson(id, ada).then(() => "finished", () => "not finished"), forgetHeldPerson(id, ada).then(() => "finished", () => "not finished")]);
  is("both erasures finish (the picture and its line are gone)", both, ["finished", "finished"]);
  is("the picture is deleted", files.has(P), false);
  is("P's place is given back once: Q's place is still counted", await count(), 1);

  part("The creator removes the post while its author's erasure runs");
  const item = await fresh(t0);
  await Promise.all([removeHeld(id, item, "", t0 + 5).catch(() => null), forgetHeldPerson(id, ada).catch(() => null)]);
  is("the picture is deleted", files.has(P), false);
  is("P's place is given back once: Q's place is still counted", await count(), 1);

  part("An erasure after the line is already gone gives nothing back");
  await fresh(t0);
  await forgetHeldPerson(id, ada);
  is("the first erasure gives P's place back", await count(), 1);
  await forgetHeldPerson(id, ada);
  is("a second one changes nothing", await count(), 1);
  done();
}

void main();
