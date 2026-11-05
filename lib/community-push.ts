/**
 * A member's phone, told when something happened to them.
 *
 * Stan's own help centre says "All Community notifications are sent via
 * email!", and offers daily, weekly or never. Circle, Skool, Mighty Networks,
 * Whop, Kajabi and Discord all send push. The research put this second of the
 * six capabilities, behind search, and the reason is plain: a paid community
 * does not die of dissatisfaction, it dies of being forgotten.
 *
 * Everything hard is already written. lib/web-push.ts derives our VAPID keys
 * from the deployment's own secret, signs the requests, encrypts the payload
 * and refuses to post to anything that is not a known push service;
 * lib/phone-alerts.ts uses it for the creator's own phone. This file is the
 * same thing for the people on the other side of the community, and adds no
 * key, no dependency and no second way of doing it.
 *
 * Kept under the community's own id:
 *
 *   nl:cm:<id>:ps:<who>   endpoint -> the device, as JSON
 *
 * One person, several devices, each its own row, each going on its own when
 * its browser says it has gone.
 *
 * What is sent is deliberately thin: who did what, and where to go. Never the
 * words anybody wrote. A notification is read on a lock screen, over a
 * shoulder, on a device that may be borrowed — and a community that promises
 * private messages cannot put their contents there.
 *
 * Two limits, said here and said on the page, because a notification somebody
 * believes in and does not get is worse than one they never expected:
 *
 *   - On iPhone and iPad a web page may only send push once it has been added
 *     to the home screen. Apple requires that, not us.
 *   - A browser may drop a subscription whenever it likes. The push service
 *     then answers 404 or 410, which is not an error to retry: that device is
 *     gone, and its row goes with it.
 */
import { redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/** Where members' devices are counted in the store's data room (lib/store-data.ts). */
const DEVICES_SLOT = "cm:ps";
import { type Subscription, readSubscription, sendPush, vapidKeys, vapidKeysFor } from "@/lib/web-push";

const pushKey = (id: string, who: string) => `nl:cm:${id}:ps:${who}`;

/** How many devices one member may have listening. */
export const MAX_MEMBER_DEVICES = 5;
const MAX_TITLE = 80;
const MAX_BODY = 180;

export type MemberDevice = Subscription & {
  /** Which of our keys it subscribed under (lib/web-push.ts). */
  kid: string;
  addedAt: number;
};

/** Whether push can be sent at all here. */
export function canPush(): boolean {
  return vapidKeys() !== null;
}

/** The public key a browser needs to subscribe. Safe for anybody to see. */
export function publicKey(): string {
  return vapidKeys()?.publicKey ?? "";
}

function parseDevice(raw: string): MemberDevice | null {
  try {
    const v = JSON.parse(raw) as Partial<MemberDevice>;
    // A device is kept flat, the way lib/web-push.ts hands it back; the
    // reader wants the shape a browser sends, with the keys nested. Passing
    // the stored shape straight back returns null for every row, and a push
    // that never leaves looks exactly like a push nobody was owed.
    const subscription = readSubscription({ endpoint: v.endpoint, keys: { p256dh: v.p256dh, auth: v.auth } });
    if (!subscription || typeof v.kid !== "string" || !v.kid) return null;
    return { ...subscription, kid: v.kid, addedAt: typeof v.addedAt === "number" ? v.addedAt : 0 };
  } catch {
    return null;
  }
}

async function devicesOf(id: string, who: string): Promise<MemberDevice[]> {
  const [raw] = await redisPipeline([["HGETALL", pushKey(id, who)]]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const out: MemberDevice[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const one = parseDevice(flat[i]);
    if (one) out.push(one);
  }
  return out;
}

export type AddDeviceResult = "added" | "known" | "full" | "noroom" | "invalid" | "unavailable";

/**
 * Remembers one device. `raw` is what the browser's own subscription object
 * turns into, checked by lib/web-push.ts against the push services we know.
 */
export async function rememberDevice(id: string, who: string, raw: unknown, room: DataStore): Promise<AddDeviceResult> {
  const keys = vapidKeys();
  if (!keys) return "unavailable";
  const subscription = readSubscription(raw);
  if (!subscription) return "invalid";
  const key = pushKey(id, who);
  const [size, held] = await redisPipeline([
    ["HLEN", key],
    ["HGET", key, subscription.endpoint],
  ]);
  const already = typeof held === "string" && held.length > 0;
  if (!already && Number(size) >= MAX_MEMBER_DEVICES) return "full";
  const device: MemberDevice = { ...subscription, kid: keys.kid, addedAt: Date.now() };
  const value = JSON.stringify(device);
  // A new device takes room in the store's data room first; one known already is rewritten in its place.
  const grown = dataBytes([subscription.endpoint, value], 1) - (already ? dataBytes([subscription.endpoint, held as string], 1) : 0);
  if (grown > 0 && !(await takeData(room, [{ slot: DEVICES_SLOT, bytes: grown }])).ok) return "noroom";
  await redisPipeline([["HSET", key, subscription.endpoint, value]]);
  if (grown < 0) await giveData(room, [{ slot: DEVICES_SLOT, bytes: -grown }]);
  return already ? "known" : "added";
}

/**
 * Replaces a device the browser swapped out by itself, keeping its place.
 * Silent when the old one is not ours: a browser may report a change for a
 * subscription this community never held.
 */
export async function renewDevice(id: string, who: string, oldEndpoint: string, raw: unknown, room: DataStore): Promise<void> {
  const result = await rememberDevice(id, who, raw, room);
  if (result === "added" || result === "known") await forgetDevice(id, who, oldEndpoint, room);
}

/**
 * Forgets one device: what "turn this off on this device" writes, and gives
 * its room back when the store is known (a device a push service says is
 * gone is forgotten without it, and its room stays counted).
 */
export async function forgetDevice(id: string, who: string, endpoint: string, room?: DataStore): Promise<void> {
  if (!endpoint) return;
  const [held] = room ? await redisPipeline([["HGET", pushKey(id, who), endpoint]]) : [null];
  const [removed] = await redisPipeline([["HDEL", pushKey(id, who), endpoint]]);
  if (room && Number(removed) === 1 && typeof held === "string") await giveData(room, [{ slot: DEVICES_SLOT, bytes: dataBytes([endpoint, held], 1) }]);
}

/** Forgets every device of one member: what leaving, or being removed, writes. */
export async function forgetMember(id: string, who: string): Promise<void> {
  await redisPipeline([["DEL", pushKey(id, who)]]);
}

/** How many devices this member has listening. */
export async function deviceCount(id: string, who: string): Promise<number> {
  const [n] = await redisPipeline([["HLEN", pushKey(id, who)]]);
  return Number(n) || 0;
}

export type MemberAlert = { title: string; body: string; url: string; tag?: string };

function payloadFor(alert: MemberAlert): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  return JSON.stringify({
    title: clip(alert.title, MAX_TITLE),
    body: clip(alert.body, MAX_BODY),
    url: alert.url,
    tag: alert.tag,
  });
}

/**
 * Tells everybody named, on every device they have.
 *
 * Never throws into the caller. A comment lost because a notification failed
 * would be a lost comment; a notification that never arrived is a smaller
 * loss than the thing it was about. A device the push service says is gone is
 * forgotten rather than tried again.
 */
export async function pushMembers(id: string, to: string[], alert: MemberAlert): Promise<number> {
  if (!vapidKeys()) return 0;
  const who = [...new Set(to)].filter(Boolean);
  if (!who.length) return 0;
  const body = payloadFor(alert);
  let sent = 0;
  await Promise.all(
    who.map(async (one) => {
      let devices: MemberDevice[] = [];
      try {
        devices = await devicesOf(id, one);
      } catch (error) {
        console.error("reading a member's push devices failed", error);
        return;
      }
      await Promise.all(
        devices.map(async (device) => {
          const keys = vapidKeysFor(device.kid);
          // Subscribed under a key we no longer hold: it cannot be reached,
          // and will be replaced the next time that browser turns it on.
          if (!keys) return;
          try {
            const result = await sendPush(device, body, {
              urgency: "normal",
              ttlSeconds: 86_400,
              topic: alert.tag,
              keys,
            });
            if (result.ok) sent += 1;
            if (result.gone) await forgetDevice(id, one, device.endpoint);
          } catch (error) {
            console.error("sending a member push notification failed", error);
          }
        }),
      );
    }),
  );
  return sent;
}

/** Deletes the devices one member let us notify (lib/community-erasure.ts). */
export async function forgetPushPerson(id: string, who: string): Promise<number> {
  const reply = await redisPipeline([["DEL", pushKey(id, who)]]);
  const length = Array.isArray(reply) ? Object.getOwnPropertyDescriptor(reply, "length") : undefined;
  const gone = Array.isArray(reply) ? Object.getOwnPropertyDescriptor(reply, "0") : undefined;
  if (length?.value !== 1 || !gone || !("value" in gone) || (gone.value !== 0 && gone.value !== 1)) {
    throw new Error("Community push erasure was not confirmed");
  }
  return gone.value;
}
