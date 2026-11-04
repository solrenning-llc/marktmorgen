/**
 * Who is given what in a creator's Discord server (lib/discord-rules.ts).
 *
 * Joining: a buyer agreed on Discord's page; which of the store's products
 * that give roles their address holds is read from the creator's Stripe
 * account (lib/community-access.ts), and they are put in the server with
 * those roles. One Discord account per address: bringing in another moves
 * the roles to it, so a purchase cannot open the server for a friend too.
 *
 * Checking: everyone given roles is checked again about every CHECK_HOURS,
 * at the job's next run after it is due (app/api/cron/discord). Roles for products no longer held are taken
 * back, roles a product gives since are added, and somebody who holds none
 * any more loses every role given and, when the creator asked for it, is
 * taken out of the server. Only roles this store gave are ever taken: a
 * role the creator gave by hand stays. When Stripe or Discord cannot be
 * asked, nothing is taken and the person is checked again later.
 */
import { holdsProductsOrThrow } from "@/lib/community-access";
import { redisPipeline } from "@/lib/redis";
import { emailKey, storeKey } from "@/lib/learn";
import { type Store, storeForId } from "@/lib/store";
import { giveRole, putMember, removeMember, takeRole } from "@/lib/discord";
import { KICK_TRIES, rolesDiff, rolesFor } from "@/lib/discord-rules";
import { accountOf, checkSoon, dueMembers, forgetMember, keepMember, productRoles, readMember, readServer } from "@/lib/discord-store";

const cacheKey = (store: Store, email: string, productId: string) => `nl:dc:ok:${storeKey(store)}:${emailKey(email)}:${productId}`;

/** Which of these products the address holds now. Throws when Stripe cannot be asked. */
export async function heldProducts(store: Store, email: string, ids: string[]): Promise<string[]> {
  const held: string[] = [];
  for (const id of ids) {
    if (await holdsProductsOrThrow(store, [id], email, cacheKey(store, email, id), "1")) held.push(id);
  }
  return held;
}

export type Joined =
  | { ok: true; serverId: string; added: boolean; roles: number }
  | { ok: false; reason: "off" | "none" | "failed" };

/** Puts a buyer who agreed on Discord's page in the creator's server, with the roles of what they hold. */
export async function joinServer(input: { store: Store; email: string; accessToken: string; user: { id: string; name: string }; now?: number }): Promise<Joined> {
  const { store, email, accessToken, user } = input;
  const room = storeKey(store);
  const server = await readServer(room);
  if (!server || !store.sid) return { ok: false, reason: "off" };
  const byProduct = await productRoles(room);
  let held: string[];
  try {
    held = await heldProducts(store, email, [...byProduct.keys()]);
  } catch (error) {
    console.error("checking what a buyer holds for Discord failed", error);
    return { ok: false, reason: "failed" };
  }
  const wanted = rolesFor(held, byProduct);
  if (!wanted.length) return { ok: false, reason: "none" };
  const reason = `Marktmorgen: bought from ${store.name}`.slice(0, 200);

  // One Discord account per address: one brought in before gives its roles up.
  const before = await accountOf(room, email);
  if (before && before !== user.id) {
    const old = await readMember(room, before);
    for (const role of old?.r ?? []) await takeRole(server.id, before, role, "Marktmorgen: the buyer joined with another Discord account");
    await forgetMember(room, store.sid, before, email);
  }

  const mine = await readMember(room, user.id);
  const placed = await putMember(server.id, user.id, accessToken, wanted, reason);
  if (placed === "failed") return { ok: false, reason: "failed" };
  // Already in the server: the roles are given one by one, and those given for what is no longer held taken back.
  const given = placed === "added" ? wanted : [...(mine?.r ?? [])];
  if (placed === "there") {
    const diff = rolesDiff(mine?.r ?? [], wanted);
    for (const role of wanted) {
      if ((await giveRole(server.id, user.id, role, reason)) === "ok" && !given.includes(role)) given.push(role);
    }
    for (const role of diff.take) {
      if ((await takeRole(server.id, user.id, role, "Marktmorgen: no longer held")) !== "failed") given.splice(given.indexOf(role), 1);
    }
  }
  const at = Math.floor((input.now ?? Date.now()) / 1000);
  await keepMember(room, store.sid, user.id, { e: email, n: user.name, p: held, r: given.filter((r) => wanted.includes(r)), at: mine?.at || at, checked: at }, input.now);
  return { ok: true, serverId: server.id, added: placed === "added", roles: wanted.length };
}

export type Checked = "kept" | "changed" | "ended" | "gone" | "later";

/** Checks one person again, and gives or takes back roles to match what they hold now. */
export async function checkMember(sid: string, userId: string, now = Date.now()): Promise<Checked> {
  const store = await storeForId(sid).catch(() => null);
  if (!store) return "gone";
  const room = storeKey(store);
  const [server, member] = await Promise.all([readServer(room), readMember(room, userId)]);
  if (!server || !member) return "gone";
  const byProduct = await productRoles(room);
  let held: string[];
  try {
    held = await heldProducts(store, member.e, [...byProduct.keys()]);
  } catch (error) {
    // Stripe could not be asked: nothing is taken on a guess.
    console.error("checking a Discord member's purchases failed", error);
    await keepMember(room, sid, userId, member, now);
    return "later";
  }
  const wanted = rolesFor(held, byProduct);
  const at = Math.floor(now / 1000);

  if (!wanted.length) {
    const reason = "Marktmorgen: access ended";
    let left = false;
    let failed = false;
    for (const role of member.r) {
      const done = await takeRole(server.id, userId, role, reason);
      if (done === "gone") left = true;
      if (done === "failed") failed = true;
    }
    if (failed) {
      await keepMember(room, sid, userId, member, now);
      return "later";
    }
    if (server.kick && !left) {
      // Discord refused or did not answer: kept, its roles already gone, so the next check tries the removal again
      // instead of forgetting somebody who is still in the server.
      // At most KICK_TRIES more checks, then forgotten as before, so a lasting refusal never keeps a check going.
      const out = await removeMember(server.id, userId, reason);
      const tried = (member.k ?? 0) + 1;
      if (out === "failed" && tried <= KICK_TRIES) {
        await keepMember(room, sid, userId, { ...member, p: held, r: [], checked: at, k: tried }, now);
        return "later";
      }
    }
    await forgetMember(room, sid, userId, member.e);
    return "ended";
  }

  const diff = rolesDiff(member.r, wanted);
  const given = [...member.r];
  let left = false;
  for (const role of diff.add) {
    const done = await giveRole(server.id, userId, role, `Marktmorgen: bought from ${store.name}`.slice(0, 200));
    if (done === "ok") given.push(role);
    if (done === "gone") left = true;
  }
  for (const role of diff.take) {
    const done = await takeRole(server.id, userId, role, "Marktmorgen: no longer held");
    if (done !== "failed") given.splice(given.indexOf(role), 1);
    if (done === "gone") left = true;
  }
  // They left the server: forgotten, and the button brings them back with what they hold.
  if (left && !diff.add.some((role) => given.includes(role))) {
    await forgetMember(room, sid, userId, member.e);
    return "gone";
  }
  await keepMember(room, sid, userId, { ...member, p: held, r: given, checked: at }, now);
  return diff.add.length || diff.take.length ? "changed" : "kept";
}

/** Everyone due, checked until the deadline; those not reached stay first in line. */
export async function sweepDiscord(deadline: number, now = Date.now()): Promise<Record<Checked, number>> {
  const counts: Record<Checked, number> = { kept: 0, changed: 0, ended: 0, gone: 0, later: 0 };
  const due = await dueMembers(now);
  for (let i = 0; i < due.length; i += 1) {
    const { sid, userId } = due[i];
    if (Date.now() > deadline) {
      for (const rest of due.slice(i)) await checkSoon(rest.sid, rest.userId);
      break;
    }
    try {
      counts[await checkMember(sid, userId, now)] += 1;
    } catch (error) {
      console.error("checking a Discord member failed", error);
      await checkSoon(sid, userId);
      counts.later += 1;
    }
  }
  return counts;
}

/** The most roles deleting one person takes back in Discord, each one call. */
export const ERASE_ROLE_CALLS = 10;

/**
 * Deletes one person from the store's Discord access (lib/person-erasure.ts):
 * the roles they were given are taken back in the creator's server, then
 * their Discord id and the address that brought it are forgotten. Answers
 * whether every role came back; a role Discord would not take back is left
 * for the creator to remove, and the confirmation says so.
 */
export async function forgetDiscordPerson(store: Store, email: string, productIds: string[]): Promise<{ records: number; rolesLeft: boolean }> {
  const room = storeKey(store);
  const userId = await accountOf(room, email).catch(() => null);
  let records = 0;
  let rolesLeft = false;
  if (userId) {
    const [server, member] = await Promise.all([readServer(room), readMember(room, userId)]);
    if (member && server) {
      for (const role of member.r.slice(0, ERASE_ROLE_CALLS)) {
        const done = await takeRole(server.id, userId, role, "Marktmorgen: deleted at their request").catch(() => "failed" as const);
        if (done === "failed") rolesLeft = true;
      }
      if (member.r.length > ERASE_ROLE_CALLS) rolesLeft = true;
    }
    await forgetMember(room, store.sid, userId, email);
    records += 1;
  }
  if (productIds.length) {
    const [gone] = await redisPipeline([["DEL", ...productIds.map((id) => cacheKey(store, email, id))]]);
    records += Number(gone) || 0;
  }
  return { records, rolesLeft };
}
