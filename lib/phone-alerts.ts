/**
 * Notifications on the creator's phone: a sale, a booking, a report in the
 * community, an application from an affiliate.
 *
 * The studio installs as an app on a phone's home screen (app/studio/layout
 * .tsx, public/studio.webmanifest), and from there, or from any browser that
 * has Web Push, the creator turns notifications on for that device. The
 * browser hands us a subscription (lib/web-push.ts); it is kept here with the
 * events that device wants, up to MAX_DEVICES per person per store — a phone,
 * a tablet, a laptop or two — each with its own choices, and each can be
 * sent a test or removed from the studio.
 *
 * Devices are each person's own. A store can have a team (lib/team.ts), and
 * everyone on it turns notifications on for their own devices and sees,
 * changes and removes only those; nobody sees anybody else's. What a device
 * may hear is what its person's role may see (EVENT_NEEDS below, read from
 * lib/team-roles.ts), checked when it is chosen and again, against the role
 * the person has at that moment, every time something is sent — so a person
 * taken off the team, or moved to a role that does not see sales, stops
 * being told at once. A device kept before there were teams is the owner's.
 *
 * A notification is sent where the thing is written down, after the answer
 * has gone (after()), so no buyer, member or applicant ever waits on a push
 * service:
 *
 *   sale       every paid order, noticed by the thanks page or by the
 *              five-minute job for a buyer who never came back, and every
 *              one-click offer paid after it (lib/sale-events.ts): the amount
 *              and the product. A booked call is told as a booking instead.
 *   booking    every booked call or seat, when it is confirmed
 *              (lib/calls.ts): the product, the time and what was paid.
 *   report     a member reported a post or a comment (told once for each
 *              post or comment, however many members report it).
 *   affiliate  somebody confirmed an application to the affiliate programme.
 *   alert      the store's numbers went off course: visits or sales from them
 *              fell, refunds piled up, the month's goal is off pace or reached
 *              (lib/store-alerts.ts). A device kept before this event existed
 *              hears of these only once its person switches them on.
 *   live       a live event in the community starts in fifteen minutes
 *              (lib/community-event-mail.ts): its title, its time, how many
 *              said they are coming. A device kept before this event existed
 *              that hears of bookings hears of these too, until its person
 *              switches them off.
 *
 * What a notification says is written for a lock screen: amounts, product
 * titles and times, never a buyer's name or email address. Each is sent
 * once: a sale or a booking by its checkout, a report by what was reported,
 * an application by the affiliate. Reports and applications are at most
 * QUIET_PER_HOUR an hour per store, so a flood of either cannot bury the
 * phone; sales and bookings are never held back. A device that turned
 * notifications off (the push service says the subscription is gone) is
 * forgotten on the spot. A device subscribed under a key we no longer have
 * is marked, and the studio subscribes it again the next time it is opened
 * on that device.
 *
 *   nl:phone:cfg:<statsId>          { handle, devices }
 *   nl:phone:st:<statsId>           device -> how the last send went
 *   nl:phone:seen:<hash>            an event already sent, forty days
 */
import { maySendPathReminder } from "@/lib/path-reminder-rules";
import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { type Store, accountStores, setPhoneSales, storeRef } from "@/lib/store";
import { normaliseEmail } from "@/lib/auth";
import { type Permission, type Role, can } from "@/lib/team-roles";
import { memberStores, readTeam } from "@/lib/team";
import { type PushFetchHooks, type Subscription, readSubscription, sendPush, vapidKeys, vapidKeysFor } from "@/lib/web-push";
import { MAX_DEVICES } from "@/lib/phone-alerts-rules";

export const PHONE_EVENTS = ["sale", "booking", "report", "affiliate", "live", "comment", "alert", "path"] as const;
export type PhoneEvent = (typeof PHONE_EVENTS)[number];

export { MAX_DEVICES };
/** Devices one store may keep in all: its owner's and those of a full team of five. */
const MAX_STORE_DEVICES = MAX_DEVICES * 6;

/**
 * What a role has to be allowed to hear each event (lib/team-roles.ts): a
 * sale's amount is a number of the store's (stats) or an order (orders); a
 * booking is an order; a report is the community's; an application is the
 * affiliate programme's, a setting; a live event about to start is the
 * community's, which everyone who helps run it may see; a comment under a
 * lesson is the course's, which whoever edits products may answer.
 */
const EVENT_NEEDS: Record<PhoneEvent, Permission[]> = {
  sale: ["orders", "stats"],
  booking: ["orders"],
  report: ["community"],
  affiliate: ["settings"],
  live: ["community"],
  comment: ["products"],
  alert: ["stats"],
  path: [],
};

/** The events a role may be told about, in the studio's order. */
export function eventsFor(role: Role): PhoneEvent[] {
  return PHONE_EVENTS.filter((event) => event === "path" ? role === "owner" : EVENT_NEEDS[event].some((need) => can(role, need)));
}
/** Reports, and applications, a store's devices are told about in an hour, at most, of each. */
export const QUIET_PER_HOUR = 20;
/** Tests one store may send in a minute. */
const TESTS_PER_MINUTE = 6;
/** How long a sent event is remembered, so it is never sent twice. */
const SEEN_SECONDS = 40 * 86400;
/** How long before a device was turned on something may have started and still be told to it. */
const GRACE_MS = 3600_000;
/** The longest title and body a notification carries. */
const MAX_TITLE = 80;
const MAX_BODY = 180;

type Device = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Which of our keys it subscribed under (lib/web-push.ts). */
  kid: string;
  /** "iPhone · Safari", from the browser that turned it on. */
  label: string;
  events: PhoneEvent[];
  /**
   * 1 once its choices were made knowing about live events. A device from
   * before, that hears of bookings, is given them too (see parseConfig).
   */
  lv?: number;
  addedAt: number;
  /**
   * Whose device it is: their sign-in address, for someone on the team. ""
   * is the store's owner — whatever address the owner signs in with, so an
   * owner who moves their account keeps their phones (devices from before
   * teams, and every owner's device since, are kept this way).
   */
  who: string;
};
type Config = { handle: string; devices: Device[] };
type DeviceState = { at: number; ok: boolean; status: number; error: string };

const cfgKey = (statsId: string) => `nl:phone:cfg:${statsId}`;
const stateKey = (statsId: string) => `nl:phone:st:${statsId}`;
const seenKey = (statsId: string, event: string, seed: string) =>
  `nl:phone:seen:${createHash("sha256").update(`${statsId}|${event}|${seed}`).digest("hex").slice(0, 40)}`;
const testsKey = (statsId: string) => `nl:rl:phone:test:${statsId}`;
const quietKey = (statsId: string, event: string) => `nl:rl:phone:quiet:${statsId}:${event}`;

const DEVICE_ID = /^pd_[0-9a-f]{16}$/;

function eventsFrom(raw: unknown): PhoneEvent[] {
  return Array.isArray(raw) ? PHONE_EVENTS.filter((event) => raw.includes(event)) : [];
}

function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Config>;
    const devices = Array.isArray(value.devices)
      ? value.devices
          .filter(
            (d): d is Device =>
              Boolean(d) && typeof d.id === "string" && DEVICE_ID.test(d.id) && typeof d.endpoint === "string" && typeof d.p256dh === "string" && typeof d.auth === "string",
          )
          .map((d) => ({
            ...d,
            kid: typeof d.kid === "string" ? d.kid : "",
            label: typeof d.label === "string" ? d.label.slice(0, 60) : "A device",
            // A device chosen before live events existed and that hears of
            // bookings hears of them too; from then on its choice is its own.
            events: d.lv === 1 || !eventsFrom(d.events).includes("booking") ? eventsFrom(d.events) : [...eventsFrom(d.events), "live" as const],
            lv: 1,
            addedAt: typeof d.addedAt === "number" ? d.addedAt : 0,
            who: typeof d.who === "string" ? d.who : "",
          }))
      : [];
    return { handle: typeof value.handle === "string" ? value.handle : "", devices: devices.slice(0, MAX_STORE_DEVICES) };
  } catch {
    return null;
  }
}

function parseState(raw: unknown): DeviceState | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as DeviceState;
    return typeof value.at === "number" ? value : null;
  } catch {
    return null;
  }
}

async function readConfig(statsId: string): Promise<Config | null> {
  const [raw] = await redisPipeline([["GET", cfgKey(statsId)]]);
  return parseConfig(raw);
}

async function writeConfig(store: Store, config: Config): Promise<void> {
  const statsId = store.statsId as string;
  await redisPipeline([["SET", cfgKey(statsId), JSON.stringify({ ...config, handle: store.handle })]]);
  // The five-minute job looks for sales on this store only while some device wants them.
  const wantsSales = config.devices.some((d) => d.events.includes("sale"));
  // By the key the store is kept under (lib/store.ts): an account's other stores are not kept under the address.
  if (wantsSales !== store.phoneSales) await setPhoneSales(storeRef(store), wantsSales).catch(() => null);
}

/** Whose a device is, as an address: "" (from before teams) is the owner's. */
function ownerOf(store: Store, device: Device): string {
  return device.who || normaliseEmail(store.email);
}

/** How a device's person is written down: "" for the store's owner, their address for anyone else. */
function whoFor(store: Store, person: string): string {
  return person === normaliseEmail(store.email) ? "" : person;
}

/**
 * Carries a person's devices to their new address when they move their
 * account (app/api/auth/move): on the stores they own, the devices become
 * the owner's (""), and on the stores whose team they are on, the new
 * address's. Without it, a device written down under the old address would
 * belong to nobody the store knows, and go quiet. Returns how many moved.
 */
export async function movePhoneDevices(from: string, to: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  const stores = [...(await accountStores(after)), ...(await memberStores(after)).map((m) => m.store)];
  let moved = 0;
  for (const store of stores) {
    if (!store.statsId) continue;
    const config = await readConfig(store.statsId);
    if (!config || !config.devices.some((d) => d.who === before)) continue;
    const devices = config.devices.map((d) => {
      if (d.who !== before) return d;
      moved += 1;
      return { ...d, who: whoFor(store, after) };
    });
    await writeConfig(store, { ...config, devices });
  }
  return moved;
}

/** Whether a device is this person's own. */
function isMine(store: Store, device: Device, who: string): boolean {
  return ownerOf(store, device) === normaliseEmail(who);
}

/**
 * The role each device's person has on the store right now, read once for
 * all of them: the owner is the store's, the rest from its team.
 */
async function rolesOf(store: Store, devices: Device[]): Promise<Map<string, Role>> {
  const roles = new Map<string, Role>([[normaliseEmail(store.email), "owner"]]);
  const others = devices.some((d) => !roles.has(ownerOf(store, d)));
  if (others && store.sid) {
    const team = await readTeam(store.sid).catch(() => null);
    for (const member of team?.members ?? []) roles.set(member.email, member.role);
  }
  return roles;
}

/**
 * A name for a device from its browser's user agent: the kind of device and
 * the browser, which is all the creator needs to tell theirs apart.
 */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent || "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "A device";
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "";
  return browser ? `${device} · ${browser}` : device;
}

// ---- Sending ----------------------------------------------------------------

/** Test seams for the request to the push service; production passes nothing. */
let hooksForTests: PushFetchHooks | undefined;
/** Lets a local check point pushes at a stand-in. Never called by the app. */
export function setPhoneHooksForTests(hooks: PushFetchHooks | undefined): void {
  hooksForTests = hooks;
}

/** Runs after the answer is sent when there is a request to wait for; otherwise now. */
function soon(task: () => Promise<unknown>): Promise<void> {
  try {
    after(() => task().catch((error) => console.error("a phone notification failed", error)));
    return Promise.resolve();
  } catch {
    // Outside a request (the scheduled job's own work, a check): simply now.
    return task().then(
      () => undefined,
      (error) => console.error("a phone notification failed", error),
    );
  }
}

export type Alert = { title: string; body: string; url: string };

function payloadFor(event: PhoneEvent | "test", alert: Alert): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  // Only a path in the studio is opened from a notification (public/studio-sw.js checks again).
  const url = /^\/studio(?:[/?#]|$)/.test(alert.url) ? alert.url : "/studio";
  return JSON.stringify({ title: clip(alert.title, MAX_TITLE), body: clip(alert.body, MAX_BODY), url, tag: event });
}

/** Sends one message to one device and writes down how it went; forgets a device that is gone. */
async function deliver(store: Store, device: Device, event: PhoneEvent | "test", alert: Alert): Promise<DeviceState> {
  const statsId = store.statsId as string;
  const subscription: Subscription = { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth };
  const result = await sendPush(subscription, payloadFor(event, alert), {
    // A sale, a booking or a live event about to start wakes a phone that is
    // saving power; the rest waits for it.
    urgency: event === "sale" || event === "booking" || event === "live" || event === "test" ? "high" : "normal",
    // A newer report or application replaces one still waiting at the push service.
    topic: event === "report" || event === "affiliate" || event === "comment" ? `nimbus-${event}` : undefined,
    // A live event's notice is no use once the event has started.
    ttlSeconds: event === "path" ? 0 : event === "test" ? 600 : event === "live" ? 900 : 86400,
    hooks: hooksForTests,
    keys: vapidKeysFor(device.kid),
  });
  const state: DeviceState = { at: Date.now(), ok: result.ok, status: result.status, error: result.error };
  await redisPipeline([["HSET", stateKey(statsId), device.id, JSON.stringify(state)]]);
  if (result.gone && event !== "path") {
    // Read again, so a device added a moment ago is never lost with this one.
    const config = await readConfig(statsId);
    if (config && config.devices.some((d) => d.id === device.id)) {
      await writeConfig(store, { ...config, devices: config.devices.filter((d) => d.id !== device.id) });
      await redisPipeline([["HDEL", stateKey(statsId), device.id]]);
    }
  }
  return state;
}

/**
 * Tells every device that wants `event`, once per `seed`. `at` is when the
 * thing happened: a device turned on more than an hour after it is not told
 * about it. Returns
 * how many devices it is sending to; the sending itself happens after the
 * answer to the request that noticed it.
 */
export async function alertCreator(
  store: Store,
  event: PhoneEvent,
  alert: Alert,
  options: { seed: string; at?: number; pathTimeZone?: string },
): Promise<number> {
  if (event === "path" && !maySendPathReminder(options.pathTimeZone || "", Date.now())) return 0;
  if (!store.statsId || !isRedisConfigured()) return 0;
  const keys = vapidKeys();
  if (!keys) return 0;
  const statsId = store.statsId;
  const config = await readConfig(statsId);
  const at = options.at ?? Date.now();
  // A checkout is dated when it was opened, not when it was paid: an hour's
  // grace lets one paid just after a device was turned on still reach it.
  const eligible = (config?.devices ?? []).filter((d) => d.events.includes(event) && vapidKeysFor(d.kid) !== null && d.addedAt <= at + GRACE_MS && (event !== "path" || ownerOf(store, d) === normaliseEmail(store.email)));
  const wanting = event === "path" ? eligible.slice(0, MAX_DEVICES) : eligible;
  if (!wanting.length) return 0;
  // Only to a person whose role, now, may see this (EVENT_NEEDS).
  const roles = await rolesOf(store, wanting);
  const listening = wanting.filter((d) => {
    const role = roles.get(ownerOf(store, d));
    return role !== undefined && eventsFor(role).includes(event);
  });
  if (!listening.length) return 0;
  // SET NX answers OK when this event is new here and null when it was sent already; anything else is unknown, and nothing is sent on it.
  const fresh = repliesFor(await redisPipeline([["SET", seenKey(statsId, event, options.seed), "1", "NX", "EX", SEEN_SECONDS]]), 1)?.[0];
  if (fresh !== "OK") return 0;
  if (event === "report" || event === "affiliate" || event === "comment") {
    const replies = repliesFor(await redisPipeline([
      ["SET", quietKey(statsId, event), "0", "EX", 3600, "NX"],
      ["INCR", quietKey(statsId, event)],
    ]), 2);
    // A count in any other shape is unknown (CX-123 rule 24): nothing is sent on it.
    const count = countOf(replies?.[1]);
    if (count === null || count > QUIET_PER_HOUR) return 0;
  }
  await soon(() => Promise.all(listening.map((device) => event === "path" && !maySendPathReminder(options.pathTimeZone || "", Date.now()) ? Promise.resolve(null) : deliver(store, device, event, alert))));
  return listening.length;
}

// ---- The studio -----------------------------------------------------------------

export type DeviceView = {
  id: string;
  label: string;
  events: PhoneEvent[];
  addedAt: number;
  /** Subscribed under a key we no longer have: it has to be turned on again. */
  stale: boolean;
  last: DeviceState | null;
};
export type PhoneView = {
  /** The key a browser subscribes with; null when push is not set up here. */
  publicKey: string | null;
  /** This person's own devices on this store; nobody else's. */
  devices: DeviceView[];
  /** The events this person's role may be told about. */
  allowed: PhoneEvent[];
};

/** One person's view: their own devices, and what their role may hear. */
export async function phoneView(store: Store, who: string, role: Role): Promise<PhoneView> {
  const keys = vapidKeys();
  const allowed = eventsFor(role);
  if (!store.statsId || !isRedisConfigured()) return { publicKey: keys?.publicKey ?? null, devices: [], allowed };
  const [rawConfig, rawStates] = await redisPipeline([
    ["GET", cfgKey(store.statsId)],
    ["HGETALL", stateKey(store.statsId)],
  ]);
  const config = parseConfig(rawConfig);
  const states = new Map<string, DeviceState>();
  const flat = Array.isArray(rawStates) ? (rawStates as unknown[]).map(String) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const state = parseState(flat[i + 1]);
    if (state) states.set(flat[i], state);
  }
  return {
    publicKey: keys?.publicKey ?? null,
    allowed,
    devices: (config?.devices ?? []).filter((d) => isMine(store, d, who)).map((d) => ({
      id: d.id,
      label: d.label,
      events: d.events,
      addedAt: d.addedAt,
      stale: !keys || vapidKeysFor(d.kid) === null,
      last: states.get(d.id) ?? null,
    })),
  };
}

export type AddResult = { ok: true; id: string; created: boolean; label: string; view: PhoneView } | { ok: false; reason: "invalid" | "full" | "unavailable" };

/**
 * Keeps a device's subscription, as one of this person's devices. The same
 * subscription sent again (the studio opened on the same phone) updates the
 * device it already is, keeping its choices; a new one is a new device, up
 * to MAX_DEVICES for this person. A browser's subscription is one per
 * browser, so the same browser signed in as someone else becomes theirs, and
 * stops being told what only the first person could see.
 */
export async function addDevice(
  store: Store,
  who: string,
  role: Role,
  raw: unknown,
  events: unknown,
  userAgent: string,
  now = Date.now(),
): Promise<AddResult> {
  const keys = vapidKeys();
  if (!store.statsId || !keys) return { ok: false, reason: "unavailable" };
  const subscription = readSubscription(raw);
  if (!subscription) return { ok: false, reason: "invalid" };
  const person = normaliseEmail(who);
  const allowed = eventsFor(role);
  const config = (await readConfig(store.statsId)) ?? { handle: store.handle, devices: [] };
  const same = config.devices.find((d) => d.endpoint === subscription.endpoint);
  if (same) {
    const moved = !isMine(store, same, person);
    const updated: Device = {
      ...same,
      ...subscription,
      kid: keys.kid,
      who: whoFor(store, person),
      events: same.events.filter((event) => allowed.includes(event)),
      // Handed to another person: counted from now, as a device of theirs.
      addedAt: moved ? now : same.addedAt,
    };
    await writeConfig(store, { ...config, devices: config.devices.map((d) => (d.id === same.id ? updated : d)) });
    return { ok: true, id: same.id, created: moved, label: same.label, view: await phoneView(store, person, role) };
  }
  if (config.devices.filter((d) => isMine(store, d, person)).length >= MAX_DEVICES || config.devices.length >= MAX_STORE_DEVICES) {
    return { ok: false, reason: "full" };
  }
  const chosen = eventsFrom(events).filter((event) => allowed.includes(event));
  const device: Device = {
    id: `pd_${randomBytes(8).toString("hex")}`,
    ...subscription,
    kid: keys.kid,
    label: deviceLabel(userAgent),
    events: chosen.length ? chosen : allowed.filter((event) => event !== "path"),
    lv: 1,
    addedAt: now,
    who: whoFor(store, person),
  };
  await writeConfig(store, { ...config, devices: [...config.devices, device] });
  return { ok: true, id: device.id, created: true, label: device.label, view: await phoneView(store, person, role) };
}

/**
 * A phone's browser replaced its subscription by itself (the service worker
 * hears "pushsubscriptionchange"): the device keeps its place and its choices.
 */
export async function renewDevice(store: Store, who: string, oldEndpoint: string, raw: unknown): Promise<"renewed" | "missing" | "invalid"> {
  const keys = vapidKeys();
  if (!store.statsId || !keys) return "missing";
  const subscription = readSubscription(raw);
  if (!subscription) return "invalid";
  const config = await readConfig(store.statsId);
  const device = config?.devices.find((d) => d.endpoint === oldEndpoint && isMine(store, d, who));
  if (!config || !device) return "missing";
  await writeConfig(store, { ...config, devices: config.devices.map((d) => (d.id === device.id ? { ...d, ...subscription, kid: keys.kid } : d)) });
  return "renewed";
}

/** Which device, if any, a subscription belongs to: how the studio knows "this device". */
export async function findDevice(store: Store, who: string, endpoint: string): Promise<string | null> {
  if (!store.statsId || typeof endpoint !== "string" || !endpoint) return null;
  const config = await readConfig(store.statsId);
  return config?.devices.find((d) => d.endpoint === endpoint && isMine(store, d, who))?.id ?? null;
}

/** Changes which events one device hears. None at all is allowed: the device stays, silent. */
export async function setDeviceEvents(store: Store, who: string, role: Role, id: string, events: unknown): Promise<PhoneView | "missing"> {
  if (!store.statsId) return "missing";
  const config = await readConfig(store.statsId);
  if (!config || !config.devices.some((d) => d.id === id && isMine(store, d, who))) return "missing";
  const allowed = eventsFor(role);
  const chosen = eventsFrom(events).filter((event) => allowed.includes(event));
  await writeConfig(store, { ...config, devices: config.devices.map((d) => (d.id === id ? { ...d, events: chosen } : d)) });
  return phoneView(store, who, role);
}

/** Forgets a device. */
export async function removeDevice(store: Store, who: string, role: Role, id: string): Promise<PhoneView> {
  if (!store.statsId) return { publicKey: vapidKeys()?.publicKey ?? null, devices: [], allowed: eventsFor(role) };
  const config = await readConfig(store.statsId);
  if (config && config.devices.some((d) => d.id === id && isMine(store, d, who))) {
    await writeConfig(store, { ...config, devices: config.devices.filter((d) => d.id !== id) });
    await redisPipeline([["HDEL", stateKey(store.statsId), id]]);
  }
  return phoneView(store, who, role);
}

/**
 * Forgets every device of one person on a store, when they leave its team or
 * are taken off it. Nothing would be sent to them anyway — each send checks
 * the role a device's person has at that moment — but their phone's address
 * at its push service is theirs, and is not kept once they are gone.
 * Returns how many were forgotten. The owner's devices are never touched.
 */
export async function forgetPerson(store: Store, who: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const person = normaliseEmail(who);
  if (person === normaliseEmail(store.email)) return 0;
  const config = await readConfig(store.statsId);
  const theirs = (config?.devices ?? []).filter((d) => ownerOf(store, d) === person);
  if (!config || theirs.length === 0) return 0;
  await writeConfig(store, { ...config, devices: config.devices.filter((d) => ownerOf(store, d) !== person) });
  await redisPipeline([["HDEL", stateKey(store.statsId), ...theirs.map((d) => d.id)]]);
  return theirs.length;
}

/** Forgets every device of a deleted store, whoever's they were. */
export async function forgetStorePhones(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", cfgKey(statsId), stateKey(statsId)]]);
}

/** Sends one test notification to one of this person's devices, now, and says how it went. */
export async function sendTest(
  store: Store,
  who: string,
  role: Role,
  id: string,
): Promise<{ ok: true; state: DeviceState; view: PhoneView } | { ok: false; reason: "missing" | "limited" | "stale" }> {
  if (!store.statsId) return { ok: false, reason: "missing" };
  const keys = vapidKeys();
  const config = await readConfig(store.statsId);
  const device = config?.devices.find((d) => d.id === id && isMine(store, d, who));
  if (!device || !keys) return { ok: false, reason: "missing" };
  if (!vapidKeysFor(device.kid)) return { ok: false, reason: "stale" };
  const replies = repliesFor(await redisPipeline([
    ["SET", testsKey(store.statsId), "0", "EX", 60, "NX"],
    ["INCR", testsKey(store.statsId)],
  ]), 2);
  // A count in any other shape is unknown (CX-123 rule 24): no test is sent on it.
  const count = countOf(replies?.[1]);
  if (count === null || count > TESTS_PER_MINUTE) return { ok: false, reason: "limited" };
  const state = await deliver(store, device, "test", {
    title: "Marktmorgen Studio",
    body: "Notifications work on this device. Nothing happened in your store.",
    url: "/studio/phone",
  });
  return { ok: true, state, view: await phoneView(store, who, role) };
}
