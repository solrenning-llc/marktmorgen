/**
 * 256 [KJ1], unit 2: the studio demo's session door, on the in-memory Redis.
 *
 * Off, the route is a 404 that sends no Redis command. With the switch
 * forced on through the functions' own parameter (STUDIO_DEMO_ON stays false
 * in the code): a program is refused, an address opens its sessions a day and counts only its share of the refusals,
 * two doors at the day's last place give it to one, every key written is the
 * demo's own with an expiry, the real stores' keys are untouched, a session
 * reads back until it ends, an action is counted at its caps' exact edges
 * and an unknown count refuses. What the door and an action send is held
 * against the costs lib/studio-demo-rules.ts was worked out with.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { shareAddress } from "@/lib/traffic-rules";
import { DELETE, GET, POST } from "@/app/api/studio-demo/route";
import {
  DEMO_DAY_KEEP_SECONDS, DEMO_TAKE_COMMANDS, STUDIO_DEMO_SEED, STUDIO_DEMO_SEED_BYTES, STUDIO_DEMO_SEED_VALUES,
  answerStudioDemoOpen, openStudioDemo, readStudioDemo, studioDemoCookie, takeDemoAction, type StudioDemoSession,
} from "@/lib/studio-demo";
import {
  DEMO_ACTIONS_PER_SESSION, DEMO_ACTION_MAX_BYTES, DEMO_BYTES_PER_SESSION, DEMO_COMMANDS_PER_ACTION, DEMO_COMMANDS_PER_DAY, DEMO_COOKIE,
  DEMO_KEY_FAMILIES, DEMO_NAMESPACE, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, DEMO_SESSIONS_PER_DAY, DEMO_SESSION_SECONDS,
  DEMO_SESSION_WORST_COMMANDS, DEMO_START_COMMANDS, DEMO_START_DB_BYTES, DEMO_TAKE_DB_BYTES, STUDIO_DEMO_ON, sandboxKey,
} from "@/lib/studio-demo-rules";
import * as rulesNs from "@/lib/studio-demo-rules";
import { ELSEWHERE_FAMILIES } from "@/lib/data-families";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const chunk = (flat: string[]): [string, string][] => Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);

// Every command sent, and the bytes each pipeline moves both ways.
const sent: (string | number)[][] = [];
let moved = 0;
const pipeline = store.pipeline;
store.pipeline = async (commands) => {
  sent.push(...commands);
  const replies = await pipeline(commands);
  moved += new TextEncoder().encode(JSON.stringify(commands)).byteLength + new TextEncoder().encode(JSON.stringify(replies)).byteLength;
  return replies;
};
/** What a step sends, as billed: each command, and what a script runs inside. */
async function billed<T>(work: () => Promise<T>): Promise<{ result: T; commands: number; bytes: number; keys: string[] }> {
  const from = sent.length, inner = store.scriptCalls, bytes = moved;
  const result = await work();
  const mine = sent.slice(from);
  const keys = mine.flatMap((c) => (String(c[0]) === "EVAL" ? c.slice(3, 3 + Number(c[2])) : [c[1]]).map(String));
  return { result, commands: mine.length + store.scriptCalls - inner, bytes: moved - bytes, keys };
}

const ON = { on: true, isAutomated: async () => false };
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0, 250);
let clock = T0;
const at = (ms: number) => ({ ...ON, now: () => ms });
const door = (address = "203.0.113.7", headers: Record<string, string> = {}, body?: string) =>
  new Request("https://marktmorgen.com/api/studio-demo", { method: "POST", headers: { "x-forwarded-for": address, ...headers }, body });
const withCookie = (value: string) => new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: value } });
const fresh = () => {
  store.clear();
  store.now = () => clock;
};
const dayKey = "nl:sdemo:day:2026-11-04";
const addrKey = "nl:sdemo:addr:2026-11-04";
// A different address for each call that is not about addresses, so a part's refusals never meet an address's own cap.
let nth = 0;
const asker = () => door(`198.18.${Math.floor(nth / 250) % 250}.${(nth++ % 250) + 1}`);

async function run(): Promise<void> {
  part("Off: a path that does not exist, and not one Redis command");
  fresh();
  is("STUDIO_DEMO_ON is still false in the code", STUDIO_DEMO_ON, false);
  const offRoute = await billed(async () => [
    (await POST(door())).status,
    (await POST(door("203.0.113.7", { origin: "https://elsewhere.example", "content-type": "application/json" }, JSON.stringify({ website: "x".repeat(5_000) })))).status,
    (await GET()).status,
    (await DELETE()).status,
  ]);
  is("POST, GET and DELETE answer 404", offRoute.result, [404, 404, 404, 404]);
  is("the body is not read and nothing is answered in it", await (await POST(door())).text(), "");
  const offLib = await billed(async () => [
    (await openStudioDemo(door())).ok,
    (await answerStudioDemoOpen(door())).status,
    (await takeDemoAction(door(), { id: "sd" + "a".repeat(32), day: "2026-11-04", startedAt: T0, expiresAt: T0 + 1, actions: 0, bytes: 0 }, { commands: 12, bytes: 1 })).ok,
    await readStudioDemo(withCookie(`${DEMO_COOKIE}=sd${"0".repeat(32)}`)),
  ]);
  is("off, the functions refuse too, a read with a made-up cookie included", offLib.result, [false, 404, false, null]);
  is("zero Redis commands while off", offRoute.commands + offLib.commands, 0);
  is("no key in Redis", store.keys(), []);

  part("A program is refused before anything is counted or written");
  fresh();
  const bot = await billed(() => openStudioDemo(door(), { on: true, isAutomated: async () => true, now: () => clock }));
  // The stand-in keeps an empty hash for a key HMGET asked about; Redis does not, so a field count is what tells a write.
  is("after the day's and the address's refusals read (one command), nothing is counted or written", [bot.commands, store.keys().filter((k) => k !== addrKey), store.run(["HLEN", addrKey])], [1, [], 0]);
  is("the bot check's verdict refuses", bot.result, { ok: false, reason: "automated" });
  const honeypot = await billed(() => answerStudioDemoOpen(door("203.0.113.7", { "content-type": "application/json" }, JSON.stringify({ website: "https://spam.example" })), at(clock)));
  is("the hidden field filled reads as a program, with no command", [honeypot.result.status, honeypot.commands], [403, 0]);
  is("another site is refused", (await answerStudioDemoOpen(door("203.0.113.7", { origin: "https://elsewhere.example", host: "marktmorgen.com" }), at(clock))).status, 403);
  is("a body past its bound is refused", (await answerStudioDemoOpen(door("203.0.113.7", {}, "{" + " ".repeat(300) + "}"), at(clock))).status, 413);
  is("a body that is not an object is refused", (await answerStudioDemoOpen(door("203.0.113.7", {}, "[]"), at(clock))).status, 400);

  part("Sessions an address a day; the new kind of address by its network");
  fresh();
  is("three at the most an address", DEMO_SESSIONS_PER_ADDRESS_PER_DAY <= 3, true);
  const mine: boolean[] = [];
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) mine.push((await openStudioDemo(door("198.51.100.1"), at(clock))).ok);
  is("an address opens its own", mine, mine.map(() => true));
  is("the next is refused", await openStudioDemo(door("198.51.100.1"), at(clock)), { ok: false, reason: "address" });
  is("another address still opens", (await openStudioDemo(door("198.51.100.2"), at(clock))).ok, true);
  const network: boolean[] = [];
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) network.push((await openStudioDemo(door(`2001:db8:abcd:${i + 1}::${i + 7}`), at(clock))).ok);
  is("addresses of one network, each on its own /64, open the network's own", network, network.map(() => true));
  is("the network's next, from yet another /64, is refused", await openStudioDemo(door("2001:db8:abcd:ff::1"), at(clock)), { ok: false, reason: "address" });
  is("another network still opens", (await openStudioDemo(door("2001:db8:abce::1"), at(clock))).ok, true);
  is("no address or network is kept in the clear", store.keys().some((k) => /198\.51\.100|2001:db8/.test(k)) || JSON.stringify(store.run(["HGETALL", `${DEMO_NAMESPACE}addr:2026-11-04`])).includes("db8"), false);
  is("the addresses' counts end with the day", store.run(["PEXPIRETIME", `${DEMO_NAMESPACE}addr:2026-11-04`]), Date.UTC(2026, 10, 5));
  {
    // An address's field is made with the deployment's key: a plain hash of an
    // IPv4 address can be found again by trying all 2^32 of them.
    const plain = createHash("sha256").update(`marktmorgen-studio-demo:${shareAddress("198.51.100.1")}`).digest("hex").slice(0, 32);
    const fields = Object.keys(Object.fromEntries(chunk(store.run(["HGETALL", `${DEMO_NAMESPACE}addr:2026-11-04`]) as string[])));
    is("an address is counted under a keyed fingerprint, never a plain hash anyone can recompute", [fields.length > 0, fields.includes(plain)], [true, false]);
  }

  part("The day's last place, taken by one of two doors");
  fresh();
  store.run(["HSET", dayKey, "sessions", String(DEMO_SESSIONS_PER_DAY - 1), "commands", "0", "sent", "0"]);
  const both = await Promise.all([openStudioDemo(door("192.0.2.1"), at(clock)), openStudioDemo(door("192.0.2.2"), at(clock))]);
  is("one opens, the other is refused for the day's sessions", both.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["ok", "sessions"]);
  is("the day counts exactly its cap", store.run(["HGET", dayKey, "sessions"]), String(DEMO_SESSIONS_PER_DAY));
  fresh();
  store.run(["HSET", dayKey, "sessions", "0", "commands", String(DEMO_COMMANDS_PER_DAY - DEMO_SESSION_WORST_COMMANDS), "sent", "0"]);
  const room = await Promise.all([openStudioDemo(door("192.0.2.1"), at(clock)), openStudioDemo(door("192.0.2.2"), at(clock))]);
  is("room for one session's whole worst: one opens, the other is refused for the day's commands", room.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["commands", "ok"]);
  is("the reservation fills the day's commands exactly", store.run(["HGET", dayKey, "commands"]), String(DEMO_COMMANDS_PER_DAY));
  fresh();
  store.run(["HSET", dayKey, "sessions", "abc"]);
  is("a day's count that is not a number refuses", await openStudioDemo(door(), at(clock)), { ok: false, reason: "unknown" });
  fresh();
  const realPipeline = store.pipeline;
  store.pipeline = async (commands) => (String(commands[0][0]) === "EVAL" ? Promise.reject(new Error("down")) : realPipeline(commands));
  is("today's counts out of reach refuse", await openStudioDemo(door(), at(clock)), { ok: false, reason: "unknown" });
  store.pipeline = realPipeline;

  part("What opening writes: the demo's own keys, each ending");
  fresh();
  const house: [string, string][] = [
    ["nl:store:0123456789abcdef0123456789abcdef", JSON.stringify({ name: "Harbor Kitchen", handle: "harborkitchen" })],
    ["nl:handle:harborkitchen", "0123456789abcdef0123456789abcdef"],
    ["nl:house:seed", JSON.stringify({ fingerprint: "f", missing: [] })],
    ["nl:session:abc", "owner@example.test"],
  ];
  for (const [k, v] of house) store.run(["SET", k, v]);
  const before = house.map(([k]) => [k, store.run(["GET", k]), store.run(["PTTL", k])]);
  const opened = await billed(() => openStudioDemo(door(), at(clock)));
  if (!opened.result.ok) throw new Error(`the door did not open: ${opened.result.reason}`);
  const session = opened.result.session;
  is("the session id is sd and 32 hex digits", /^sd[0-9a-f]{32}$/.test(session.id), true);
  is("two sessions never share an id", new Set(await Promise.all([1, 2, 3].map(async (i) => {
    const o = await openStudioDemo(door(`192.0.2.${10 + i}`), at(clock));
    return o.ok ? o.session.id : "";
  }))).size, 3);
  const after = house.map(([k]) => [k, store.run(["GET", k]), store.run(["PTTL", k])]);
  is("the real stores' keys are untouched", after, before);
  const touched = opened.keys;
  is("every key the door sends is in the demo's namespace", touched.every((k) => k.startsWith(DEMO_NAMESPACE)), true);
  const sandbox = touched.filter((k) => k !== dayKey && k !== `${DEMO_NAMESPACE}addr:2026-11-04`);
  const families = sandbox.map((k) => k.slice(`${DEMO_NAMESPACE}{${session.id}}:`.length));
  is("its sandbox keys are the session record and the five first drafts", families, ["session", "product", "page", "offer", "subscription", "email"]);
  is("every one is made by sandboxKey, in an allowed family", sandbox.every((k, i) => sandboxKey(session.id, families[i]) === k && DEMO_KEY_FAMILIES.includes(families[i])), true);
  const written = store.keys().filter((k) => !house.some(([h]) => h === k));
  is("every key written has an expiry", written.filter((k) => Number(store.run(["PTTL", k])) <= 0), []);
  is("every key written is the demo's", written.filter((k) => !k.startsWith(DEMO_NAMESPACE)), []);
  is("the sandbox's keys all end when the session does, at the same instant", [...new Set(sandbox.map((k) => store.run(["PEXPIRETIME", k])))], [session.expiresAt]);
  is("the session lives its DEMO_SESSION_SECONDS from its whole second", [session.startedAt, session.expiresAt - session.startedAt], [Math.floor(T0 / 1000) * 1000, DEMO_SESSION_SECONDS * 1000]);
  is("the day's counts are kept 400 days", store.run(["TTL", dayKey]), DEMO_DAY_KEEP_SECONDS);
  is("the day reserved the session's whole worst", [store.run(["HGET", dayKey, "commands"]), store.run(["HGET", dayKey, "sent"])], [String(4 * DEMO_SESSION_WORST_COMMANDS), String(4 * DEMO_START_COMMANDS)]);
  is("the first drafts are the fixed fictional ones", sandbox.slice(1).map((k) => store.run(["GET", k])), STUDIO_DEMO_SEED_VALUES);
  is("the record counts the first drafts' bytes", store.run(["HGET", sandbox[0], "bytes"]), String(STUDIO_DEMO_SEED_BYTES));
  is("opening bills exactly DEMO_START_COMMANDS", opened.commands, DEMO_START_COMMANDS);
  is(`and moves no more than DEMO_START_DB_BYTES (${opened.bytes})`, opened.bytes <= DEMO_START_DB_BYTES, true);

  part("The cookie");
  const cookie = opened.result.cookie;
  is("its own name, HttpOnly, Secure, SameSite=Lax", cookie.split("; ").filter((p) => /^(HttpOnly|Secure|SameSite=Lax|Path=\/)$/.test(p)).sort(), ["HttpOnly", "Path=/", "SameSite=Lax", "Secure"]);
  is("named nl_studio_demo with the session's id", cookie.startsWith(`${DEMO_COOKIE}=${session.id};`), true);
  is("kept no longer than the session lives", cookie.includes(`Max-Age=${Math.floor((session.expiresAt - T0) / 1000)};`), true);
  is("ten minutes on, it says what is left", studioDemoCookie(session, session.startedAt + 600_000).includes(`Max-Age=${DEMO_SESSION_SECONDS - 600};`), true);
  const answered = await answerStudioDemoOpen(door("192.0.2.99"), at(clock));
  is("the door's answer carries it, never cached", [answered.status, (answered.headers.get("set-cookie") ?? "").startsWith(`${DEMO_COOKIE}=sd`), answered.headers.get("cache-control")], [200, true, "no-store"]);

  part("Reading a session");
  const cookieHeader = `${DEMO_COOKIE}=${session.id}`;
  is("the cookie reads its live session", await readStudioDemo(withCookie(`nl_session=x; ${cookieHeader}`), at(clock)), session);
  is("no cookie, no session", await readStudioDemo(withCookie("nl_session=x"), at(clock)), null);
  is("a malformed id reads nothing and sends nothing", (await billed(() => readStudioDemo(withCookie(`${DEMO_COOKIE}=0123456789abcdef0123456789abcdef`), at(clock)))).commands, 0);
  is("an unknown id, null", await readStudioDemo(withCookie(`${DEMO_COOKIE}=sd${"f".repeat(32)}`), at(clock)), null);
  is("the cookie given twice, null", await readStudioDemo(withCookie(`${cookieHeader}; ${cookieHeader}`), at(clock)), null);
  is("its last millisecond, live", (await readStudioDemo(withCookie(cookieHeader), at(session.expiresAt - 1)))?.id, session.id);
  is("at its end, null", await readStudioDemo(withCookie(cookieHeader), at(session.expiresAt)), null);
  store.run(["HSET", sandbox[0], "bytes", "lots"]);
  is("a record that does not read as written, null", await readStudioDemo(withCookie(cookieHeader), at(clock)), null);
  store.run(["HSET", sandbox[0], "bytes", String(STUDIO_DEMO_SEED_BYTES)]);
  clock = session.expiresAt;
  is("expired in Redis too: the record is gone", [store.run(["EXISTS", sandbox[0]]), await readStudioDemo(withCookie(cookieHeader), at(clock))], [0, null]);
  clock = T0;

  part("An action: checked and counted at its caps' exact edges");
  fresh();
  const o = await openStudioDemo(door(), at(clock));
  if (!o.ok) throw new Error("no session");
  const s: StudioDemoSession = o.session;
  const record = sandboxKey(s.id, "session")!;
  const cost = { commands: DEMO_COMMANDS_PER_ACTION, bytes: 100 };
  const first = await billed(() => takeDemoAction(asker(), s, cost, at(clock)));
  is("the first action is counted", first.result, { ok: true, actions: 1, bytes: STUDIO_DEMO_SEED_BYTES + 100 });
  is("its check and count bill DEMO_TAKE_COMMANDS", first.commands, DEMO_TAKE_COMMANDS);
  is("under an action's commands", DEMO_TAKE_COMMANDS < DEMO_COMMANDS_PER_ACTION, true);
  is(`and move no more than DEMO_TAKE_DB_BYTES (${first.bytes})`, first.bytes <= DEMO_TAKE_DB_BYTES, true);
  is("and touch only the session record (its own refusals read with it) and the day, never the addresses' refusals", [...new Set(first.keys)], [record, dayKey]);
  is("the day counts the commands sent", store.run(["HGET", dayKey, "sent"]), String(DEMO_START_COMMANDS + DEMO_COMMANDS_PER_ACTION));
  store.run(["HSET", record, "actions", String(DEMO_ACTIONS_PER_SESSION - 1)]);
  is("the last action runs", (await takeDemoAction(asker(), s, cost, at(clock))).ok, true);
  is("one past it is refused", await takeDemoAction(asker(), s, cost, at(clock)), { ok: false, reason: "actions" });
  store.run(["HSET", record, "actions", String(DEMO_ACTIONS_PER_SESSION - 1)]);
  const race = await Promise.all([takeDemoAction(asker(), s, cost, at(clock)), takeDemoAction(asker(), s, cost, at(clock))]);
  is("two actions at the last place: one runs, one is refused", race.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["actions", "ok"]);
  store.run(["HSET", record, "actions", "0", "bytes", String(DEMO_BYTES_PER_SESSION - 100)]);
  is("filling the session's bytes exactly runs", (await takeDemoAction(asker(), s, cost, at(clock))).ok, true);
  is("one byte past them is refused", await takeDemoAction(asker(), s, { commands: DEMO_TAKE_COMMANDS, bytes: 1 }, at(clock)), { ok: false, reason: "bytes" });
  store.run(["HSET", record, "bytes", "0"]);
  is("an action dearer than the worst costed is refused", [
    await takeDemoAction(asker(), s, { commands: DEMO_COMMANDS_PER_ACTION + 1, bytes: 0 }, at(clock)),
    await takeDemoAction(asker(), s, { commands: DEMO_TAKE_COMMANDS, bytes: DEMO_ACTION_MAX_BYTES + 1 }, at(clock)),
  ], [{ ok: false, reason: "too_big" }, { ok: false, reason: "too_big" }]);
  is("its last millisecond runs", (await takeDemoAction(asker(), s, cost, at(s.expiresAt - 1))).ok, true);
  is("at its end it is over", await takeDemoAction(asker(), s, cost, at(s.expiresAt)), { ok: false, reason: "expired" });
  store.run(["HSET", dayKey, "sent", String(DEMO_COMMANDS_PER_DAY - DEMO_COMMANDS_PER_ACTION + 1)]);
  is("one command past the day's is refused", await takeDemoAction(asker(), s, cost, at(clock)), { ok: false, reason: "commands" });
  store.run(["HDEL", dayKey, "sent"]);
  is("the day's count missing refuses", await takeDemoAction(asker(), s, cost, at(clock)), { ok: false, reason: "unknown" });
  store.run(["HSET", dayKey, "sent", "0"]);

  part("Unknown counts refuse, before any command");
  const unknown = await billed(async () => [
    await takeDemoAction(asker(), s, { commands: Number.NaN, bytes: 0 }, at(clock)),
    await takeDemoAction(asker(), s, { commands: -1, bytes: 0 }, at(clock)),
    await takeDemoAction(asker(), s, { commands: 12, bytes: Number.POSITIVE_INFINITY }, at(clock)),
    await takeDemoAction(asker(), s, { commands: 12, bytes: 1.5 }, at(clock)),
    await takeDemoAction(asker(), s, { commands: DEMO_TAKE_COMMANDS - 1, bytes: 0 }, at(clock)),
    await takeDemoAction(asker(), { ...s, id: "0123456789abcdef0123456789abcdef" }, cost, at(clock)),
    await takeDemoAction(asker(), s, cost, at(Number.NaN)),
  ]);
  is("each refuses as unknown", unknown.result.map((r) => (r.ok ? "ok" : r.reason)), Array(7).fill("unknown"));
  const sentBefore = store.run(["HGET", dayKey, "sent"]);
  is("the day is the record's, never the caller's", (await takeDemoAction(asker(), { ...s, day: "2026-01-01" }, cost, at(clock))).ok, true);
  is("so the opening day counts it", [Number(store.run(["HGET", dayKey, "sent"])) - Number(sentBefore), store.run(["EXISTS", "nl:sdemo:day:2026-01-01"])], [DEMO_COMMANDS_PER_ACTION, 0]);
  is("and sends nothing", unknown.commands, 0);
  store.run(["HSET", record, "actions", "x"]);
  is("a record that does not read as written refuses", await takeDemoAction(asker(), s, cost, at(clock)), { ok: false, reason: "unknown" });
  store.run(["DEL", record]);
  is("a session whose record is gone is over", await takeDemoAction(asker(), s, cost, at(clock)), { ok: false, reason: "expired" });

  part("Refusals: each counted, the day's capped, and past the cap one command each");
  fresh();
  const RN = rulesNs as unknown as Record<string, unknown>;
  const REFUSALS = Number(RN.DEMO_REFUSALS_PER_DAY), REFUSAL_WORST = Number(RN.DEMO_REFUSAL_WORST_COMMANDS);
  const REFUSALS_ADDRESS = Number(RN.DEMO_REFUSALS_PER_ADDRESS_PER_DAY), REFUSAL_BYTES = DEMO_TAKE_DB_BYTES;
  const REFUSALS_SESSION = Number(RN.DEMO_REFUSALS_PER_SESSION);
  is("the day's refusals and a refusal's commands are capped", [Number.isSafeInteger(REFUSALS) && REFUSALS > 0, Number.isSafeInteger(REFUSAL_WORST) && REFUSAL_WORST > 0], [true, true]);
  const live = await openStudioDemo(door("192.0.2.50"), at(clock));
  if (!live.ok) throw new Error("no session");
  const liveRecord = sandboxKey(live.session.id, "session")!;
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) await openStudioDemo(door("192.0.2.60"), at(clock));
  const refusedNow = () => Number(store.run(["HGET", addrKey, "refused"]) ?? 0);
  const sessionRefused = () => Number(store.run(["HGET", liveRecord, "refused"]) ?? 0);
  const ghost: StudioDemoSession = { ...live.session, id: "sd" + "e".repeat(32) };
  // Each path, and where its refusal is counted: the site's (through its address) or the live session's own record.
  const paths: [string, () => Promise<unknown>, () => void, () => number][] = [
    ["an address past its sessions", () => openStudioDemo(door("192.0.2.60"), at(clock)), () => {}, refusedNow],
    ["a day with no session left", () => openStudioDemo(door("192.0.2.61"), at(clock)), () => store.run(["HSET", dayKey, "sessions", String(DEMO_SESSIONS_PER_DAY)]), refusedNow],
    ["a session whose record is gone", () => takeDemoAction(door(), ghost, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => {}, refusedNow],
    ["an action past the day's commands, in the session's own record", () => takeDemoAction(door(), live.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => store.run(["HSET", dayKey, "sent", String(DEMO_COMMANDS_PER_DAY)]), sessionRefused],
    ["an action past the session's, refused by its script, in the session's own record", () => takeDemoAction(door(), live.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => {
      store.run(["HSET", dayKey, "sent", "0"]);
      // As if another request took the last place between this one's read and its count.
      const run = store.run.bind(store);
      store.run = (command) => {
        if (String(command[0]) === "EVAL") {
          store.run = run;
          run(["HSET", liveRecord, "actions", String(DEMO_ACTIONS_PER_SESSION)]);
        }
        return run(command);
      };
    }, sessionRefused],
    ["a cookie naming no session", () => readStudioDemo(withCookie(`${DEMO_COOKIE}=${ghost.id}`), at(clock)), () => {}, refusedNow],
  ];
  for (const [name, work, setUp, counted] of paths) {
    setUp();
    const was = counted();
    const step = await billed(work);
    const result = step.result as { ok?: boolean } | null;
    is(`${name}: refused, counted once, in ${step.commands} commands at most DEMO_REFUSAL_WORST_COMMANDS`, [result === null || result.ok === false, counted() - was, step.commands <= REFUSAL_WORST], [true, 1, true]);
    is(`${name}: and moves no more than the bytes a refusal is priced with (${step.bytes})`, step.bytes <= REFUSAL_BYTES, true);
  }
  store.run(["HSET", dayKey, "sessions", "0"]);
  store.run(["HSET", addrKey, "refused", String(REFUSALS)]);
  const shut = () => store.keys().map((k) => [k, store.run(["TYPE", k]) === "hash" ? store.run(["HGETALL", k]) : store.run(["GET", k])]);
  const beforeShut = shut();
  const closedOpen = await billed(() => openStudioDemo(door("192.0.2.70"), at(clock)));
  const closedRead = await billed(() => readStudioDemo(withCookie(`${DEMO_COOKIE}=${ghost.id}`), at(clock)));
  is("past the day's refusals, a door is answered after one command and a made-up cookie after two", [closedOpen.result, closedRead.result, closedOpen.commands, closedRead.commands], [{ ok: false, reason: "closed" }, null, 1, 2]);
  is("and nothing is written", shut(), beforeShut);
  const ownRead = await billed(() => readStudioDemo(withCookie(`${DEMO_COOKIE}=${live.session.id}`), at(clock)));
  is("while a live session still reads, in two commands", [ownRead.result?.id, ownRead.commands], [live.session.id, 2]);

  part("One address, or made-up cookies, never close the demo for everyone");
  const refusedToday = () => Number(store.run(["HGET", addrKey, "refused"]) ?? 0);
  is("an address counts a small share of the day's refusals", [Number.isSafeInteger(REFUSALS_ADDRESS) && REFUSALS_ADDRESS > 0, REFUSALS_ADDRESS * 100 <= REFUSALS], [true, true]);
  fresh();
  const flood: Record<string, number> = {};
  for (let i = 0; i < REFUSALS + 4; i += 1) {
    const o = await openStudioDemo(door("198.51.100.200"), at(clock));
    const k = o.ok ? "ok" : o.reason;
    flood[k] = (flood[k] ?? 0) + 1;
  }
  is(`one address with ${REFUSALS + 4} doors opens its own and is then refused as an address, never closing the day`, flood, { ok: DEMO_SESSIONS_PER_ADDRESS_PER_DAY, address: REFUSALS + 4 - DEMO_SESSIONS_PER_ADDRESS_PER_DAY });
  is("only the address's own share of refusals reached the day", refusedToday(), REFUSALS_ADDRESS);
  const pastShare = await billed(() => openStudioDemo(door("198.51.100.200"), at(clock)));
  is("past its share, the address is answered after one command and nothing is written", [pastShare.result, pastShare.commands, refusedToday()], [{ ok: false, reason: "address" }, 1, REFUSALS_ADDRESS]);
  is("so another address still opens", (await openStudioDemo(door("198.51.100.201"), at(clock))).ok, true);
  fresh();
  const busy = await openStudioDemo(door("198.51.100.205"), at(clock));
  if (!busy.ok) throw new Error("no session");
  store.run(["HSET", sandboxKey(busy.session.id, "session")!, "actions", String(DEMO_ACTIONS_PER_SESSION)]);
  const spent: Record<string, number> = {};
  for (let i = 0; i < REFUSALS + 4; i += 1) {
    const r = await takeDemoAction(door("198.51.100.205"), busy.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock));
    const k = r.ok ? "ok" : r.reason;
    spent[k] = (spent[k] ?? 0) + 1;
  }
  is(`a session sending ${REFUSALS + 4} actions past its own is refused, its own refusals counted in its record and none for the site`, [spent, store.run(["HGET", sandboxKey(busy.session.id, "session")!, "refused"]), refusedToday()], [{ actions: REFUSALS_SESSION, refusals: REFUSALS + 4 - REFUSALS_SESSION }, String(REFUSALS_SESSION), 0]);
  const pastOwn = await billed(() => takeDemoAction(door("198.51.100.205"), busy.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)));
  is("past its own refusals, an action is answered after one command, nothing written", [pastOwn.result, pastOwn.commands], [{ ok: false, reason: "refusals" }, 1]);
  const other = await openStudioDemo(door("198.51.100.206"), at(clock));
  is("so another address still opens and acts", [other.ok, other.ok && (await takeDemoAction(door("198.51.100.206"), other.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock))).ok], [true, true]);
  fresh();
  const kept = await openStudioDemo(door("198.51.100.210"), at(clock));
  if (!kept.ok) throw new Error("no session");
  const fake = withCookie(`${DEMO_COOKIE}=sd${"0".repeat(32)}`);
  let fakeRead: unknown = "unread";
  for (let i = 0; i < REFUSALS + 4; i += 1) fakeRead = await readStudioDemo(fake, at(clock));
  is(`${REFUSALS + 4} reads with a made-up cookie read nothing`, fakeRead, null);
  is("and count no more than one address's share", refusedToday(), REFUSALS_ADDRESS);
  is("and close nothing: a new visitor still opens", (await openStudioDemo(door("198.51.100.211"), at(clock))).ok, true);
  const keptRead = new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: `${DEMO_COOKIE}=${kept.session.id}`, "x-forwarded-for": "198.51.100.210" } });
  is("and a live session still reads from its own address", (await readStudioDemo(keptRead, at(clock)))?.id, kept.session.id);
  fresh();
  store.run(["HSET", addrKey, "refused", String(REFUSALS - 1)]);
  const together = await Promise.all(Array.from({ length: 20 }, (_, i) => readStudioDemo(new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: `${DEMO_COOKIE}=sd${"0".repeat(32)}`, "x-forwarded-for": `203.0.113.${100 + i}` } }), at(clock))));
  is("twenty refusals at once, one place left: none reads", together.filter((x) => x !== null).length, 0);
  is("and the day's refusals stop exactly at their cap", refusedToday(), REFUSALS);
  fresh();
  const sameAddress = new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: `${DEMO_COOKIE}=sd${"0".repeat(32)}`, "x-forwarded-for": "203.0.113.250" } });
  await Promise.all(Array.from({ length: 4 * REFUSALS_ADDRESS }, () => readStudioDemo(sameAddress, at(clock))));
  is(`${4 * REFUSALS_ADDRESS} refusals at once from one address count exactly its share`, refusedToday(), REFUSALS_ADDRESS);

  part("A live session is never barred by other people's refusals");
  fresh();
  const office = "198.51.100.230";
  const atOffice = await openStudioDemo(door(office), at(clock));
  if (!atOffice.ok) throw new Error("no session");
  const officeSession = atOffice.session;
  const asked = (cookie: string, address: string) => new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: `${DEMO_COOKIE}=${cookie}`, "x-forwarded-for": address } });
  const officeAct = () => takeDemoAction(door(office), officeSession, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock));
  for (let i = 0; i < REFUSALS_ADDRESS + 5; i += 1) await readStudioDemo(asked(`sd${"0".repeat(32)}`, office), at(clock));
  is("behind one address (an office, a carrier's NAT), a stranger's made-up cookies spend the address's share: no new session opens there", await openStudioDemo(door(office), at(clock)), { ok: false, reason: "address" });
  is("but the session already open behind it still reads", (await readStudioDemo(asked(officeSession.id, office), at(clock)))?.id, officeSession.id);
  is("and still acts", (await officeAct()).ok, true);
  store.run(["HSET", addrKey, "refused", String(REFUSALS)]);
  const pastDay = await billed(() => readStudioDemo(asked(`sd${"1".repeat(32)}`, "198.51.100.232"), at(clock)));
  is("past the site's refusals, a new door is closed and a made-up cookie reads nothing, counting nothing", [await openStudioDemo(door("198.51.100.231"), at(clock)), pastDay.result, refusedToday()], [{ ok: false, reason: "closed" }, null, REFUSALS]);
  is("but a live session still reads", (await readStudioDemo(asked(officeSession.id, office), at(clock)))?.id, officeSession.id);
  is("and still acts", (await officeAct()).ok, true);

  part("Its first drafts, and what the module may reach");
  const seedFile = readFileSync("lib/demo-seed.ts", "utf8");
  is("the product, the page and the offer are the demo store's own words", [
    STUDIO_DEMO_SEED.product.title, STUDIO_DEMO_SEED.product.summary, STUDIO_DEMO_SEED.page.blocks[0].headline, STUDIO_DEMO_SEED.page.blocks[0].sub, STUDIO_DEMO_SEED.offer.product,
  ].map((words) => seedFile.includes(`"${words}"`)), [true, true, true, true, true]);
  is("their prices are the demo store's", [seedFile.includes('price: "27"'), seedFile.includes('{ label: "5 weeks", price: "39"'), seedFile.includes('price: "5",')], [true, true, true]);
  is("the first drafts are far under a session's bytes", STUDIO_DEMO_SEED_BYTES < DEMO_ACTION_MAX_BYTES, true);
  const source = readFileSync("lib/studio-demo.ts", "utf8");
  const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gm)].map((m) => m[1]).sort();
  is("it imports only the bot check, Redis, the request guard, its rules, the address rule and the key its fingerprints are made with", imports, ["@/lib/bot-check", "@/lib/redis", "@/lib/request-guard", "@/lib/secret-box", "@/lib/studio-demo-rules", "@/lib/traffic-rules", "node:crypto"]);
  is("the route imports only the module", [...readFileSync("app/api/studio-demo/route.ts", "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["@/lib/studio-demo"]);
  is("no switch is read from the environment", /process\.env/.test(source), false);
  const demoFamilies = ELSEWHERE_FAMILIES.flatMap((name, i) => (name.startsWith(DEMO_NAMESPACE) ? [[ELSEWHERE_FAMILIES[i - 1], name, ELSEWHERE_FAMILIES[i + 1]]] : []));
  is("the demo's families sit in their place in ELSEWHERE_FAMILIES, in order", [demoFamilies.length, demoFamilies.every(([before, name, after]) => before < name && name < after)], [2, true]);
}

run().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
